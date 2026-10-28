"""페르소나(말투·인사 문구·음성) 연동(spec/persona.md, 백엔드 계약 spec/ai-persona-integration.md).

관리자가 백엔드에서 고친 설정을 받아 다음 통화부터 쓴다. 진행 중인 통화의 설정은 바꾸지 않는다.
적용 순서: 대기(PENDING) 조회 → 통화 0건이 되면 새 통화 잠금 → 검증·설치 → 결과 회신 → 백엔드 ACTIVE 확인 → 잠금 해제.
백엔드에 설정이 없거나 연동이 꺼져 있으면(토큰 없음) prompts/persona.md와 live.toml 음성을 쓴다.
shortcut: 프로세스 하나 기준(통화 레지스트리가 메모리). 워커를 늘리면 공통 잠금이 필요하다.
"""

import asyncio
import logging
from dataclasses import dataclass

from app.backend_api import BackendError
from app.live_session import PERSONA_MARK, LiveConfigError, build_session

log = logging.getLogger(__name__)

# gpt-live-1 내장 음성(공식 레퍼런스, spec/gpt-live-session.md). SDK 3.35.1 타입에는 일부만 있어 문서 기준으로 둔다
VOICES = ("alloy", "ash", "ballad", "beacon", "bossa", "brise", "cedar", "cinder", "coral", "delta", "echo", "flitz",
          "gleam", "harema", "juni", "marin", "meridian", "nira", "noeul", "nuri", "quartz", "ripple", "sage", "shida",
          "shimmer", "sillage", "stone", "tempo", "verse", "vesper", "willow")

# 실제로 지원하는 것만 알린다. 말 속도는 GPT-Live 설정에 없고, 말끝 판단은 모델이 해서 조절할 수 없다
OPTIONS = {"voices": [{"id": v, "label": v} for v in VOICES],
           "speakingRate": {"min": None, "max": None},
           "turnWaitLevels": ["NORMAL"]}

OUR_ERRORS = ("INVALID_CONFIG", "UNSUPPORTED_OPTIONS", "APPLY_FAILED")


class PersonaError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class Persona:
    version_seq: int
    application_id: str | None
    prompt: str
    voice: str | None  # None이면 live.toml 음성


def check(data: dict, max_chars: int) -> Persona:
    """백엔드 설정 한 버전을 검증한다. 프롬프트 원문은 오류·로그에 넣지 않는다."""
    seq, prompt = data.get("aiPersonaVersionSeq"), data.get("promptText")
    if not isinstance(seq, int) or not isinstance(prompt, str) or not prompt.strip() or len(prompt) > max_chars \
            or PERSONA_MARK in prompt:
        raise PersonaError("INVALID_CONFIG")
    voice = data.get("voiceId")
    if (voice is not None and voice not in VOICES) or data.get("speakingRate") is not None \
            or data.get("turnWaitLevel") not in OPTIONS["turnWaitLevels"]:
        raise PersonaError("UNSUPPORTED_OPTIONS")
    persona = Persona(seq, data.get("applicationId"), prompt.strip(), voice)
    try:
        build_session("", persona=persona.prompt, voice=persona.voice)  # 실제 세션 설정으로 만들어지는지
    except LiveConfigError:
        raise PersonaError("INVALID_CONFIG") from None
    return persona


class PersonaManager:
    def __init__(self, backend, registry, cfg, enabled: bool):
        self.backend = backend
        self.registry = registry
        self.cfg = cfg  # [persona]
        self.enabled = enabled
        self.active: Persona | None = None  # 새 통화에 쓸 설정. None이면 로컬 기본값
        self.locked = False  # True면 새 통화를 받지 않는다(설치·회신 중)
        self._wake = asyncio.Event()

    def refresh(self) -> None:
        """백엔드 알림. 알림의 버전은 힌트일 뿐이고 실제 대기 설정을 다시 조회한다. 중복 알림은 한 번의 작업으로 합쳐진다."""
        self._wake.set()

    async def run(self) -> None:
        """기동 때 한 번, 그 뒤로는 알림마다 동기화. 실패하면 retry_sec 뒤 다시."""
        if not self.enabled:
            return
        self._wake.set()
        while True:
            await self._wake.wait()
            self._wake.clear()
            try:
                await self.sync()
            except Exception as e:
                log.warning("페르소나 동기화 실패, 다시 시도: %s", type(e).__name__)
                await asyncio.sleep(self.cfg.retry_sec)
                self._wake.set()

    async def sync(self) -> None:
        """백엔드 오류는 예외로 올라가고(run이 다시 시도) 잠금은 결과가 확인될 때까지 유지된다."""
        await self._load_active()
        pending = await self.backend.persona_config("PENDING")
        if pending is None or pending.get("applyErrorCode") in OUR_ERRORS:
            # 대기 없음, 또는 이미 실패를 회신한 요청(관리자가 다시 요청하면 새 applicationId로 온다).
            # 앞선 적용이 불명확해 잠겨 있었어도 ACTIVE를 확인했으니 연다
            self.locked = False
            return
        while self.registry.active_count() > 0:  # 진행 중 통화는 기존 설정으로 끝까지
            await asyncio.sleep(self.cfg.wait_poll_sec)
        self.locked = True  # 위 확인과 사이에 await가 없어 그사이 새 통화가 등록되지 않는다
        log.info("페르소나 적용 시작: 새 통화 잠금")
        await self._apply()

    async def _load_active(self) -> None:
        """백엔드 ACTIVE를 새 통화 설정으로. ACTIVE가 없으면 로컬 기본값."""
        data = await self.backend.persona_config("ACTIVE")
        if data is None:
            self.active = None
            return
        try:
            self.active = check(data, self.cfg.max_prompt_chars)
        except PersonaError as e:
            log.error("백엔드 ACTIVE 페르소나를 쓸 수 없어 로컬 기본값 사용: %s", e.code)
            self.active = None

    async def _apply(self) -> None:
        pending = await self.backend.persona_config("PENDING")  # 잠근 뒤 다시: 그사이 교체됐을 수 있다
        if pending is None or pending.get("applyErrorCode") in OUR_ERRORS:
            self.locked = False
            return
        try:
            candidate = check(pending, self.cfg.max_prompt_chars)
        except PersonaError as e:
            # 기존 설정은 그대로라 복원할 것이 없다. 회신이 안 닿아도 백엔드가 다시 알리면 같은 실패를 회신한다
            log.warning("페르소나 적용 실패 회신: %s", e.code)
            await self._report(pending, "FAILED", e.code)
            self.locked = False
            return
        data = await self._report(pending, "APPLIED")
        if data is not None and data.get("status") == "ACTIVE" and data.get("aiPersonaVersionSeq") == candidate.version_seq \
                and data.get("applicationId") == candidate.application_id:
            self.active = candidate
            self.locked = False
            log.info("페르소나 적용 완료: 버전 %s", candidate.version_seq)
            return
        # 409(교체됨) 또는 응답 불명: 백엔드 ACTIVE로 다시 맞춘다. ACTIVE가 이번 요청이면 완료다
        await self._load_active()
        self.locked = False
        self._wake.set()  # 더 새 대기가 있으면 이어서 처리

    async def _report(self, pending: dict, result: str, error: str | None = None) -> dict | None:
        """적용 결과 회신. 백엔드 응답 data, 409면 None. 연결 실패는 같은 회신을 몇 번 다시 보낸다."""
        body = {"aiPersonaVersionSeq": pending["aiPersonaVersionSeq"], "applicationId": pending.get("applicationId"),
                "result": result, "activeCallCount": self.registry.active_count()}
        if error:
            body["errorCode"] = error
        for attempt in range(self.cfg.report_attempts):
            try:
                return await self.backend.persona_result(body)
            except BackendError as e:
                log.warning("페르소나 결과 회신 실패(%d): %s", attempt + 1, e)
                await asyncio.sleep(self.cfg.retry_sec)
        return None
