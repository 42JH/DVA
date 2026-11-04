"""페르소나(음성 지시문 전체·음성) 연동(spec/persona.md, 백엔드 계약 spec/ai-persona-next-call.md).

관리자가 백엔드에서 고친 설정을 다음 통화부터 쓴다. 진행 중인 통화는 시작할 때 고정한 설정으로 끝까지 간다.
알림 처리와 새 통화 진입이 같은 잠금을 쓴다: 대기(PENDING) 조회 → 검증 → APPLIED 회신 → 백엔드 ACTIVE 확인 → 새 통화 기본값 교체.
연동이 꺼져 있으면(토큰 없음) prompts/voice.md와 live.toml 음성을 쓴다. 켜져 있는데 쓸 설정이 없으면 통화를 거절한다.
shortcut: 프로세스 하나 기준(잠금·기본값이 메모리). 워커·인스턴스를 늘리면 공통 잠금이 필요하다.
"""

import asyncio
import contextlib
import logging
from dataclasses import dataclass

from app.backend_api import BackendError
from app.live_session import LiveConfigError, build_session

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


class PersonaUnavailable(Exception):
    """새 통화에 쓸 설정이 없거나 적용 결과가 불명확하다. 통화를 거절한다."""


@dataclass(frozen=True)
class Persona:
    version_seq: int
    application_id: str | None
    prompt: str  # 음성 지시문 전체(prompts/voice.md 대신)
    voice: str | None  # None이면 live.toml 음성


def check(data: dict, max_chars: int) -> Persona:
    """백엔드 설정 한 버전을 검증한다. 프롬프트 원문은 오류·로그에 넣지 않는다."""
    seq, prompt = data.get("aiPersonaVersionSeq"), data.get("promptText")
    if not isinstance(seq, int) or not isinstance(prompt, str) or not prompt.strip() or len(prompt) > max_chars:
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
    def __init__(self, backend, cfg, enabled: bool):
        self.backend = backend
        self.cfg = cfg  # [persona]
        self.enabled = enabled
        self.active: Persona | None = None  # 새 통화의 기본 설정(백엔드 ACTIVE)
        self.loaded = False  # ACTIVE를 한 번이라도 확인했는지
        self.unresolved = False  # APPLIED 회신 결과가 불명확(확인될 때까지 새 통화를 열지 않는다)
        self.lock = asyncio.Lock()  # 알림 처리와 새 통화 진입(설정 고정·등록)을 줄 세운다
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
                async with self.lock:
                    await self.sync()
            except Exception as e:
                log.warning("페르소나 동기화 실패, 다시 시도: %s", type(e).__name__)
                await asyncio.sleep(self.cfg.retry_sec)
                self._wake.set()

    @contextlib.asynccontextmanager
    async def entry(self):
        """새 통화 진입: 잠금 안에서 최신 대기를 맞추고 이 통화의 설정을 내준다. 통화 등록까지 이 블록 안에서 한다.
        연동이 꺼져 있으면 None(로컬 기본값). 쓸 설정이 없거나 적용이 불명확하면 PersonaUnavailable."""
        if not self.enabled:
            yield None
            return
        try:
            await asyncio.wait_for(self.lock.acquire(), self.cfg.entry_wait_sec)
        except TimeoutError:
            raise PersonaUnavailable("잠금 대기 초과") from None
        try:
            try:
                async with asyncio.timeout(self.cfg.entry_wait_sec):
                    await self.sync()
            except Exception as e:  # 조회 실패는 캐시로 받는다(적용이 불명확하면 아래에서 거절)
                log.warning("통화 진입 페르소나 확인 실패, 캐시 사용: %s", type(e).__name__)
                self._wake.set()
            if self.unresolved or self.active is None:
                raise PersonaUnavailable("쓸 설정 없음" if self.active is None else "적용 확인 중")
            yield self.active
        finally:
            self.lock.release()

    async def sync(self) -> None:
        """잠금을 쥔 채로 부른다. 백엔드 오류는 예외로 올라가고, 회신이 불명확하면 unresolved가 남는다.
        ACTIVE는 이 프로세스의 APPLIED 회신으로만 바뀌어 대기만 매번 조회한다(처음·불명확할 때만 ACTIVE 조회)."""
        for _ in range(self.cfg.report_attempts):
            if not self.loaded or self.unresolved:
                await self._load_active()
            pending = await self.backend.persona_config("PENDING")
            if pending is None or pending.get("applyErrorCode") in OUR_ERRORS:
                # 대기 없음, 또는 이미 실패를 회신한 요청(관리자가 다시 publish하면 새 applicationId).
                # 앞선 회신이 불명확했어도 방금 조회한 ACTIVE가 결과다
                self.unresolved = False
                return
            if await self._apply(pending):  # 불명확했던 같은 대기면 같은 APPLIED를 다시 보낸다(백엔드가 멱등 처리)
                return
            # 409: 그사이 대기가 교체됐다. ACTIVE·PENDING을 다시 맞춘다
        raise BackendError("페르소나 대기가 계속 교체됨")

    async def _load_active(self) -> None:
        """백엔드 ACTIVE를 새 통화 기본값으로. 없거나 쓸 수 없으면 None(새 통화 거절)."""
        data = await self.backend.persona_config("ACTIVE")
        self.loaded = True
        if data is None:
            self.active = None
        else:
            try:
                self.active = check(data, self.cfg.max_prompt_chars)
            except PersonaError as e:
                log.error("백엔드 ACTIVE 페르소나를 쓸 수 없음: %s", e.code)
                self.active = None

    async def _apply(self, pending: dict) -> bool:
        """처리했으면 True, 409(교체됨)면 False. 회신 결과가 불명확하면 예외(unresolved 유지)."""
        try:
            candidate = check(pending, self.cfg.max_prompt_chars)
        except PersonaError as e:
            # 기존 설정은 그대로라 복원할 것이 없다. 회신이 안 닿아도 다음 동기화에서 같은 실패를 회신한다
            log.warning("페르소나 적용 실패 회신: %s", e.code)
            return await self._report(pending, "FAILED", e.code) is not None
        self.unresolved = True
        data = await self._report(pending, "APPLIED")
        if data is None:
            self.unresolved = False  # 교체돼 적용되지 않았다
            log.info("페르소나 대기가 교체됨(409), 다시 조회")
            return False
        if data.get("status") == "ACTIVE" and data.get("aiPersonaVersionSeq") == candidate.version_seq \
                and data.get("applicationId") == candidate.application_id:
            self.active, self.unresolved = candidate, False
            log.info("페르소나 적용 완료: 버전 %s", candidate.version_seq)
            return True
        raise BackendError("페르소나 적용 회신 응답이 요청과 다름")

    async def _report(self, pending: dict, result: str, error: str | None = None) -> dict | None:
        """적용 결과 회신. 백엔드 응답 data, 409면 None. 연결 실패는 같은 회신을 몇 번 다시 보내고 그래도 안 되면 예외."""
        body = {"aiPersonaVersionSeq": pending["aiPersonaVersionSeq"], "applicationId": pending.get("applicationId"),
                "result": result}
        if error:
            body["errorCode"] = error
        for attempt in range(self.cfg.report_attempts):
            try:
                return await self.backend.persona_result(body)
            except BackendError as e:
                log.warning("페르소나 결과 회신 실패(%d): %s", attempt + 1, e)
                if attempt + 1 < self.cfg.report_attempts:
                    await asyncio.sleep(self.cfg.retry_sec)
        raise BackendError("페르소나 결과 회신 실패")
