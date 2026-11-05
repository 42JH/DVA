"""페르소나 다음 통화 적용(BE 계약 spec/ai-integration-current.md §7, backend/docs/ai-persona-next-call.md).

원본 develop-ai ai/app/persona.py(PersonaManager)의 동작을 옮겼다:
알림 처리와 새 통화 진입이 같은 잠금을 쓴다 — 대기(PENDING) 조회 → 검증 → APPLIED 회신 → 응답 ACTIVE 확인 → 새 통화 기본값 교체.
진행 중 통화는 시작 때 고정한 설정·버전을 끝까지 쓴다(CallSession.persona_version_seq). activeCallCount를 기다리지 않는다.

원본과 다른 점(결정 P2): 연동이 켜져 있어도 쓸 ACTIVE가 없으면 통화를 거절하지 않고 서버 기본 프롬프트(버전 null)로 받는다
— 계약의 "둘 다 없으면 임의 버전을 선택하지 않는다"를 지킨다. 적용 결과가 불명확하면(APPLIED 회신 응답 유실) 계약대로 거절한다.
shortcut: 프로세스 하나 기준(잠금·기본값이 메모리). 워커·인스턴스를 늘리면 공통 잠금이 필요하다(계약도 단일 프로세스 전제).
"""

import asyncio
import logging
from dataclasses import dataclass

from backend_client.api import BackendError

log = logging.getLogger(__name__)

# gpt-live-1 내장 음성(원본 persona.py와 같은 목록)
VOICES = ("alloy", "ash", "ballad", "beacon", "bossa", "brise", "cedar", "cinder", "coral", "delta", "echo", "flitz",
          "gleam", "harema", "juni", "marin", "meridian", "nira", "noeul", "nuri", "quartz", "ripple", "sage", "shida",
          "shimmer", "sillage", "stone", "tempo", "verse", "vesper", "willow")
# 실제로 지원하는 것만 알린다. 말 속도는 GPT-Live 설정에 없고, 말끝 판단은 모델이 해서 조절할 수 없다(원본 그대로)
OPTIONS = {"voices": [{"id": v, "label": v} for v in VOICES],
           "speakingRate": {"min": None, "max": None},
           "turnWaitLevels": ["NORMAL"]}
OUR_ERRORS = ("INVALID_CONFIG", "UNSUPPORTED_OPTIONS", "APPLY_FAILED")


class PersonaError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class PersonaUnavailable(Exception):
    """적용 결과가 불명확하다. 확인될 때까지 새 통화를 열지 않는다."""


@dataclass(frozen=True)
class Persona:
    version_seq: int
    application_id: str | None
    prompt: str          # promptText 전체(render_live가 정책 앞에 둔다)
    voice: str | None    # None이면 GPT-Live 기본 음성


def check(data: dict, max_chars: int) -> Persona:
    """설정 한 버전 검증. 프롬프트 원문은 오류·로그에 넣지 않는다."""
    seq, prompt = data.get("aiPersonaVersionSeq"), data.get("promptText")
    if not isinstance(seq, int) or not isinstance(prompt, str) or not prompt.strip() or len(prompt) > max_chars:
        raise PersonaError("INVALID_CONFIG")
    voice = data.get("voiceId")
    # turnWaitLevel null은 AI 기본(NORMAL)으로 본다 — voiceId·speakingRate의 null과 같은 뜻
    if (voice is not None and voice not in VOICES) or data.get("speakingRate") is not None \
            or data.get("turnWaitLevel") not in (None, *OPTIONS["turnWaitLevels"]):
        raise PersonaError("UNSUPPORTED_OPTIONS")
    return Persona(seq, data.get("applicationId"), prompt.strip(), voice)


class PersonaManager:
    def __init__(self, api, *, entry_wait_sec: float = 1.0, retry_sec: float = 5.0, report_attempts: int = 3,
                 max_prompt_chars: int = 20000, enabled: bool | None = None, allowed_version: int | None = None):
        self.api = api  # backend_client(BackendAPI·MockBackend): persona_config·persona_result
        self.entry_wait_sec, self.retry_sec = entry_wait_sec, retry_sec
        self.report_attempts, self.max_prompt_chars = report_attempts, max_prompt_chars
        # 실제 BE는 AI_PERSONA_TOKEN이 있을 때만(없으면 서버 기본 프롬프트). 가짜 BE는 토큰 없이 켠다
        self.enabled = bool(getattr(api, "persona_token", True)) if enabled is None else enabled
        self.allowed_version = allowed_version
        self.active: Persona | None = None  # 새 통화의 기본 설정(BE ACTIVE)
        self.loaded = False                 # ACTIVE를 한 번이라도 확인했는지
        self.unresolved = False             # APPLIED 회신 결과 불명확(확인될 때까지 새 통화 거절)
        self.lock = asyncio.Lock()          # 알림 처리와 새 통화 진입을 줄 세운다
        self._wake = asyncio.Event()

    def refresh(self) -> None:
        """BE 알림(힌트). 실제 대기 설정을 다시 조회한다. 중복 알림은 한 번의 작업으로 합쳐진다."""
        self._wake.set()

    async def run(self) -> None:
        """기동 때 한 번(재시작 복구), 그 뒤로는 알림마다 동기화. 실패하면 retry_sec 뒤 다시."""
        if not self.enabled:
            return
        self._wake.set()
        while True:
            await self._wake.wait()
            self._wake.clear()
            try:
                async with self.lock:
                    await self.sync()
            except Exception as e:  # BE 장애·응답 불일치: 같은 절차를 다시(새 통화는 캐시·거절 규칙으로)
                log.warning("페르소나 동기화 실패, 다시 시도: %s", type(e).__name__)
                await asyncio.sleep(self.retry_sec)
                self._wake.set()

    async def entry(self) -> Persona | None:
        """새 통화 진입: 잠금 안에서 최신 대기를 맞추고 이 통화의 설정을 돌려준다(부르는 쪽이 바로 고정).
        None = 서버 기본 프롬프트(연동 꺼짐·ACTIVE 없음). 적용이 불명확하면 PersonaUnavailable."""
        if not self.enabled:
            return None
        try:
            await asyncio.wait_for(self.lock.acquire(), self.entry_wait_sec)
        except TimeoutError:
            if self.unresolved:
                raise PersonaUnavailable("적용 확인 중") from None
            return self.active  # 다른 동기화가 진행 중: 지금 기본값으로(그 동기화가 끝나야 바뀐다)
        try:
            try:
                async with asyncio.timeout(self.entry_wait_sec):
                    await self.sync()
            except Exception as e:  # 조회 실패·초과는 캐시로 받는다(적용이 불명확하면 아래에서 거절)
                log.warning("통화 진입 페르소나 확인 실패, 캐시 사용: %s", type(e).__name__)
                self._wake.set()
            if self.unresolved:
                raise PersonaUnavailable("적용 확인 중")
            return self.active
        finally:
            self.lock.release()

    async def sync(self) -> None:
        """잠금을 쥔 채로 부른다. ACTIVE는 이 프로세스의 APPLIED 회신으로만 바뀌어 대기만 매번 조회한다."""
        for _ in range(self.report_attempts):
            if not self.loaded or self.unresolved:
                await self._load_active()
            pending = await self.api.persona_config("PENDING")
            if pending is None or pending.get("applyErrorCode") in OUR_ERRORS:
                # 대기 없음, 또는 이미 실패를 회신한 요청. 앞선 회신이 불명확했어도 방금 조회한 ACTIVE가 결과다
                self.unresolved = False
                return
            if self.allowed_version is not None and pending.get("aiPersonaVersionSeq") != self.allowed_version:
                log.warning("검토하지 않은 Live 주도 페르소나 대기는 적용하지 않음")
                self.unresolved = False
                return  # APPLIED/FAILED를 허위 회신하지 않고 BE의 PENDING을 유지
            if await self._apply(pending):
                return
            # 409: 그사이 대기가 교체됐다. ACTIVE·PENDING을 다시 맞춘다
        raise BackendError("페르소나 대기가 계속 교체됨")

    async def _load_active(self) -> None:
        data = await self.api.persona_config("ACTIVE")
        self.loaded = True
        if data is None:
            self.active = None
            return
        try:
            self.active = check(data, self.max_prompt_chars)
            if self.allowed_version is not None and self.active.version_seq != self.allowed_version:
                self.active = None
        except PersonaError as e:
            log.error("BE ACTIVE 페르소나를 쓸 수 없음 → 서버 기본 프롬프트: %s", e.code)
            self.active = None

    async def _apply(self, pending: dict) -> bool:
        """처리했으면 True, 409(교체됨)면 False. 회신 결과가 불명확하면 예외(unresolved 유지)."""
        try:
            candidate = check(pending, self.max_prompt_chars)
        except PersonaError as e:
            log.warning("페르소나 적용 실패 회신: %s", e.code)  # 기존 ACTIVE·PENDING은 BE가 보존
            return await self._report(pending, "FAILED", e.code) is not None
        self.unresolved = True
        data = await self._report(pending, "APPLIED")
        if data is None:
            self.unresolved = False
            log.info("페르소나 대기가 교체됨(409), 다시 조회")
            return False
        if data.get("status") == "ACTIVE" and data.get("aiPersonaVersionSeq") == candidate.version_seq \
                and data.get("applicationId") == candidate.application_id:
            self.active, self.unresolved = candidate, False
            log.info("페르소나 적용 완료: 버전 %s", candidate.version_seq)
            return True
        raise BackendError("페르소나 적용 회신 응답이 요청과 다름")

    async def _report(self, pending: dict, result: str, error: str | None = None) -> dict | None:
        body = {"aiPersonaVersionSeq": pending["aiPersonaVersionSeq"], "applicationId": pending.get("applicationId"),
                "result": result}
        if error:
            body["errorCode"] = error
        for attempt in range(self.report_attempts):
            try:
                return await self.api.persona_result(body)
            except BackendError as e:
                log.warning("페르소나 결과 회신 실패(%d): %s", attempt + 1, type(e).__name__)
                if attempt + 1 < self.report_attempts:
                    await asyncio.sleep(self.retry_sec)
        raise BackendError("페르소나 결과 회신 실패")

