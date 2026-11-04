"""통화 생명주기(call-lifecycle.md §2): 수신 → 1단계 고객 확인 ∥ 페르소나 → accept → sideband 수신 루프 → 마무리 → 정리.

S4 범위: 전이·2단계 고객 확인·PBX 종료 매칭·자원 정리. 함수 호출 라우터·발화 끝 Decision·전달(notifier)은 S5가
`handlers`에 붙이고, 통화 결과 아웃박스는 S6가 `on_finalize`에 붙인다.
"""

import asyncio
import json
import logging
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from app.calls.persona import Persona, PersonaManager, PersonaUnavailable
from app.calls.registry import CallRegistry
from app.calls.session import ENDED, CallSession, Phase
from app.config import CallConfig
from app.domain.state import ConversationState, Customer, Geo, Place, Source
from app.integrations.backend.gateway import BackendFailure, BackendGateway
from app.observability.trace import current_call, new_trace, span, trace_id_var
from app.policy.model import Policy
from app.policy.render import render_backend, render_live
from app.tools import function_specs
from app.tools.context import ToolContext
from pbx_webhook import IncomingCall, hangup_quietly, mask_phone

log = logging.getLogger(__name__)
KST = timezone(timedelta(hours=9))
AUDIO_TYPES = (b"session.input_audio.append", b"session.output_audio.delta")
_TYPE = re.compile(rb'"type"\s*:\s*"([^"]+)"')
Handler = Callable[[CallSession, dict], None]


@dataclass
class CallDeps:
    client: object                 # AsyncOpenAI(sessions.accept/reject/hangup, live.sideband.connect)
    backend: BackendGateway
    policy: Policy
    cfg: CallConfig
    backend_model: str
    backend_effort: str = "low"
    address: object = None
    rag: Callable[[str], Awaitable[dict]] | None = None
    rag_min_score: float | None = None     # 원본 [rag] min_score(RAG 담당 설정)
    rag_budget_sec: float = 12.0           # 원본 [rag] timeout_sec


class CallService:
    def __init__(self, deps: CallDeps):
        self.d = deps
        self.registry = CallRegistry(deps.cfg.max_active_calls)
        c = deps.cfg
        self.persona = PersonaManager(deps.backend.api, entry_wait_sec=c.persona_budget_sec, retry_sec=c.persona_retry_sec,
                                      report_attempts=c.persona_report_attempts,
                                      max_prompt_chars=c.persona_max_prompt_chars)
        self.handlers: dict[str, Handler] = {"session.started": self._on_started, "session.closed": self._on_closed,
                                             "error": self._on_error, "session.usage.updated": self._on_usage,
                                             "session.input_transcript.delta": self._on_input,
                                             "session.output_transcript.delta": self._on_output}
        self.on_finalize: list[Callable[[CallSession], Awaitable[None]]] = []  # S6: 결과 아웃박스
        self.on_change: Callable[[CallSession], None] = lambda s: None         # 관제 알림
        self.accepting_new = True
        self.results = None                                                    # S6: app.calls.results.ResultService

    # --- 수신 ---
    async def on_incoming(self, inc: IncomingCall) -> None:
        trace = new_trace()
        state = ConversationState(customer=Customer(caller_phone=inc.caller))
        tools = ToolContext(inc.session_id, state, self.d.policy, self.d.backend, self.d.address, self.d.rag,
                            rag_min_score=self.d.rag_min_score, rag_budget_sec=self.d.rag_budget_sec)
        s = CallSession(inc.session_id, trace, inc.caller, inc.incoming_at or _utc_now(), tools)
        s.on_change = self.on_change
        current_call.set(s)  # 이 통화 태스크·자식 태스크의 BE 호출을 관제에 남긴다
        verdict = self.registry.admit(s) if self.accepting_new else "full"
        if verdict == "duplicate":
            log.info("같은 session_id 재수신 무시 %s", inc.session_id)
            return
        if verdict == "full":
            log.warning("통화 상한·종료 중 → reject %s", inc.session_id)
            await self._quiet(self.d.client.live.sessions.reject(inc.session_id, status_code=486), "reject")
            return
        s.note("수신", mask_phone(inc.caller))
        try:
            await self._run(s)
        finally:
            await self.finalize(s)

    async def _run(self, s: CallSession) -> None:
        self._phase(s, Phase.ACCEPTING)
        t0 = time.monotonic()
        persona, stage1 = await asyncio.gather(_timed(s, "페르소나 확인", self.persona.entry()),
                                               _timed(s, "고객 확인(1단계)", self._stage1(s)), return_exceptions=True)
        s.timing("통화 준비(accept 전)", (time.monotonic() - t0) * 1000)
        if isinstance(stage1, BaseException):
            raise stage1
        if isinstance(persona, PersonaUnavailable):  # 적용 결과 불명확: 확인될 때까지 새 통화를 열지 않는다(계약)
            log.warning("페르소나 적용 확인 중 → reject %s", s.call_id)
            await self._quiet(self.d.client.live.sessions.reject(s.call_id, status_code=503), "reject")
            s.close_reason = "persona_unresolved"
            self._phase(s, Phase.FAILED)
            return
        if isinstance(persona, BaseException):
            raise persona
        s.persona_version_seq = persona.version_seq if persona else None  # 이 통화가 끝까지 쓰는 버전(분석에 그대로)
        try:
            with span("accept"):
                await _timed(s, "accept", self.d.client.live.sessions.accept(s.call_id,
                                                                              session=self.session_config(s, persona)))
        except Exception as e:  # decision_already_made(재시작 후 재전송) 등: 업무 정보 없음 → 결과 미전송
            log.warning("accept 실패 %s %s", s.call_id, type(e).__name__)
            s.close_reason = "accept_failed"
            self._phase(s, Phase.FAILED)
            return
        if s.hangup_after_accept:
            await self._quiet(hangup_quietly(self.d.client, s.call_id), "hangup")
            s.close_reason = "pbx_ended_during_accept"
            self._phase(s, Phase.CLOSED)
            return
        self._phase(s, Phase.ATTACHING)
        await self._read_loop(s)

    def session_config(self, s: CallSession, persona: Persona | None) -> dict:
        """delegation.md §8: 페르소나 우선 + 정책 렌더링, Responses 위임(priority, decisions.md S0b), 트리거 없음(S0c)."""
        c = s.state.customer
        info = {"전화 받은 시각": _kst(s.incoming_at), "고객": "등록 고객" if c.customer_seq else "처음 이용하는 고객"}
        if c.name:
            info["고객 성함"] = c.name
        if c.customer_seq and c.origin_address:
            info["등록된 출발지"] = c.origin_address  # 인사 문구(business_rules.md). 상세주소는 넣지 않는다
        tools = tuple((t["name"], t["description"]) for t in function_specs())
        config = {"type": "live", "model": "gpt-live-1",
                "instructions": render_live(persona and persona.prompt, self.d.policy, info, tools),
                "delegation": {"type": "responses", "responses": {
                    "model": self.d.backend_model,
                    "instructions": render_backend(self.d.policy) + f"\n현재 시각(한국): {_kst(_utc_now())}",
                    "tools": function_specs(), "tool_choice": "auto", "parallel_tool_calls": False,
                    "reasoning": {"effort": self.d.backend_effort}, "text": {"verbosity": "low"},
                    "service_tier": "priority"}}}
        if persona and persona.voice:  # 원본 live_session.build_session과 같은 자리
            config["audio"] = {"output": {"voice": persona.voice}}
        return config

    # --- 고객 확인 2단계(be-api.md §1, call-lifecycle.md §2.2) ---
    async def _stage1(self, s: CallSession) -> None:
        """accept 전 전화번호만으로(통화 등록 안 함). 실패·초과 → UNREGISTERED로 진행."""
        if not s.caller:
            return
        try:
            ctx = await self.d.backend.read("caller_context", self.d.backend.api.caller_context, s.caller,
                                            None, 0, budget_sec=self.d.cfg.stage1_budget_sec)
        except BackendFailure as e:
            s.note("고객 확인 실패", e.code)
            return
        async with s.lock:
            _apply_context(s.state, ctx, s.caller)
        s.note("고객 확인", ctx.status)

    def stage2(self, s: CallSession) -> asyncio.Task | None:
        """첫 업무 의도 확정 시 1회(ops["stage2"]). 통화 번호와 이전 접수 주소를 받는다. 이미 시작했으면 그 작업."""
        op = s.tools.ops.get("stage2")
        if op is not None:
            return op["task"]
        task = s.spawn(self._stage2(s), "stage2")
        s.tools.ops["stage2"] = {"status": "running", "task": task}
        return task

    async def _stage2(self, s: CallSession) -> int | None:
        if not s.caller:  # 발신번호 없으면 고객 범위를 만들 수 없다
            s.tools.ops["stage2"]["status"] = "failed"
            return None
        call = {"providerCallId": s.call_id, "incomingAt": s.incoming_at}
        try:
            ctx = await self.d.backend.read("caller_context2", self.d.backend.api.caller_context, s.caller, call,
                                            self.d.cfg.recent_destinations, budget_sec=self.d.cfg.stage2_budget_sec)
        except BackendFailure as e:
            s.tools.ops["stage2"]["status"] = "failed"
            s.note("통화 등록 실패", e.code)
            return None
        async with s.lock:
            _apply_context(s.state, ctx, s.caller)
        s.tools.ops["stage2"]["status"] = "done"
        s.note("통화 등록", "ok" if ctx.call_session_seq else "번호 없음")
        return ctx.call_session_seq

    async def call_session_seq(self, s: CallSession) -> int | None:
        """조회·취소가 쓰는 통화 번호. 2단계를 시작하고(이미 했으면 그대로) 잠금 밖에서 기다린다."""
        if s.state.customer.call_session_seq:
            return s.state.customer.call_session_seq
        task = self.stage2(s)
        return await asyncio.shield(task) if task else None

    # --- sideband ---
    async def _read_loop(self, s: CallSession) -> None:
        def on_reconnecting(event):  # 넘겨야 SDK 재연결이 켜진다
            s.note("재연결", type(event).__name__)
            return None

        try:
            manager = self.d.client.live.sideband.connect(session_id=s.call_id, graceful_close=True,
                                                          on_reconnecting=on_reconnecting)
            async with manager as conn:
                s.sideband = conn
                while s.phase not in (Phase.CLOSED, Phase.FAILED):
                    raw = await conn.recv_bytes()
                    m = _TYPE.search(raw[:200])
                    if m and m.group(1) in AUDIO_TYPES:
                        continue  # 오디오 반사는 파싱하지 않는다(D12, S0 U6 ~120KB/s)
                    ev = json.loads(raw)
                    handler = self.handlers.get(ev.get("type"))
                    if handler:
                        handler(s, ev)  # 동기: 상태 갱신 + 작업 생성만
        except asyncio.CancelledError:
            raise
        except Exception as e:  # 연결 종료·재연결 소진·핸들러 예외
            log.warning("수신 루프 종료 %s %s", s.call_id, type(e).__name__)
            s.close_reason = s.close_reason or f"connection_{type(e).__name__}"
            if s.phase not in (Phase.CLOSED, Phase.FAILED):
                await self._quiet(hangup_quietly(self.d.client, s.call_id), "hangup")
        finally:
            s.sideband = None
            if s.phase not in (Phase.FAILED,):
                self._phase(s, Phase.CLOSED)

    def _on_started(self, s: CallSession, ev: dict) -> None:
        s.active_t = time.time()
        s.expires_at = (ev.get("session") or {}).get("expires_at")
        self._phase(s, Phase.ACTIVE)
        if s.expires_at:
            s.set_timer("expire", s.expires_at - self.d.cfg.expire_margin_sec - time.time(),
                        lambda: self.begin_closing(s, "expiring"))
        self._arm_silence(s)

    def _on_closed(self, s: CallSession, ev: dict) -> None:
        s.close_reason = ev.get("reason") or s.close_reason
        self._phase(s, Phase.CLOSED)

    def _on_error(self, s: CallSession, ev: dict) -> None:
        err = ev.get("error") or {}
        log.warning("Live 오류 %s %s client_event_id=%s", s.call_id, err.get("code"), err.get("client_event_id"))
        s.note("오류", str(err.get("code")))

    def _on_usage(self, s: CallSession, ev: dict) -> None:
        ratio = (ev.get("context_window") or {}).get("usage_ratio") or 0
        if ratio >= 0.9:
            log.warning("컨텍스트 사용률 %.2f %s", ratio, s.call_id)

    def _on_input(self, s: CallSession, ev: dict) -> None:
        s.last_input_t = time.time()
        self._arm_silence(s)

    def _on_output(self, s: CallSession, ev: dict) -> None:
        if s.active_t and not s.last_output_t:
            s.timing("연결→첫 AI 발화", (time.time() - s.active_t) * 1000)
        s.last_output_t = time.time()
        self._arm_silence(s)  # 무발화 = 고객·AI 모두 조용(2026-11-03 통화 363d19: 긴 되읽기 도중 고객 무입력 30초로 끊음)

    def _arm_silence(self, s: CallSession) -> None:
        if s.phase == Phase.ACTIVE:
            s.set_timer("silence", self.d.cfg.silence_sec, lambda: self.begin_closing(s, "silence"))

    # --- 마무리·PBX ---
    def begin_closing(self, s: CallSession, reason: str, after_speech: bool = False) -> None:
        """CLOSING: 출력 전사가 closing_quiet_ms 멈추면(또는 closing_max_sec) 끊는다. 이미 끝나는 중이면 무시.
        after_speech: 마무리 인사를 요청한 경우 — 요청 뒤 AI가 한 번 말하기 시작한 다음부터 조용함을 센다."""
        if s.phase in ENDED or s.phase not in (Phase.ACTIVE, Phase.ATTACHING):
            return
        s.close_reason = reason
        s.closing_requested_t = time.time() if after_speech else 0.0
        self._phase(s, Phase.CLOSING)
        s.cancel_timer("silence")
        s.cancel_timer("expire")
        s.spawn(self._close_when_quiet(s), "closing")

    async def _close_when_quiet(self, s: CallSession) -> None:
        deadline = time.monotonic() + self.d.cfg.closing_max_sec
        quiet = self.d.cfg.closing_quiet_ms / 1000
        speak_by = time.monotonic() + 4.0  # 마무리 인사를 요청했는데 4초 안에 말하지 않으면 그냥 끊는다
        while time.monotonic() < min(deadline, speak_by) and s.closing_requested_t \
                and s.last_output_t <= s.closing_requested_t:
            await asyncio.sleep(0.1)
        while time.monotonic() < deadline and time.time() - s.last_output_t < quiet:
            await asyncio.sleep(0.1)
        await self._quiet(hangup_quietly(self.d.client, s.call_id), "hangup")

    async def on_call_ended(self, ev) -> None:
        """PBX 종료 웹훅(call-lifecycle.md §5). 같은 번호로 다시 건 통화는 끊지 않게 ended_at 전에 시작한 통화만."""
        for s in self.registry.active_by_caller(ev.caller):
            if datetime.fromisoformat(s.incoming_at) >= ev.ended_at:
                continue
            s.note("PBX 종료")
            if s.phase in (Phase.RECEIVED, Phase.ACCEPTING):
                s.hangup_after_accept = True
            elif s.phase in (Phase.ATTACHING, Phase.ACTIVE):
                s.close_reason = "pbx_ended"
                self._phase(s, Phase.CLOSING)
                s.spawn(self._quiet(hangup_quietly(self.d.client, s.call_id), "hangup"), "pbx_hangup")

    # --- 정리(concurrency.md §6.4) ---
    async def finalize(self, s: CallSession) -> None:
        if s.phase in (Phase.FINALIZING, Phase.DONE):
            return
        async with s.lock:
            s.closed = True                                         # 1 이후 반영·부작용 거부
        self._phase(s, Phase.FINALIZING)
        for name in list(s.timers):                                 # 2 타이머·확정 대기 취소
            s.cancel_timer(name)
        if s.rt is not None:
            s.rt.cancel()
        tasks = list(s.tasks)                                       # 3 작업 취소·상한 대기
        for t in tasks:
            t.cancel()
        if tasks:
            await asyncio.wait(tasks, timeout=self.d.cfg.finalize_wait_sec)
        for key, op in s.tools.ops.items():                         # 4 진행 중 부작용 → unknown
            if op.get("status") == "running":
                op["status"] = "unknown"
                s.note("작업 결과 불확실", key)
        for hook in self.on_finalize:                               # 5 결과 아웃박스(S6) 등
            try:
                await hook(s)
            except Exception:
                log.exception("정리 훅 실패 %s", s.call_id)
        self.registry.remove(s.call_id)
        self._phase(s, Phase.DONE)
        trace_id_var.set("-")

    async def warmup(self) -> None:
        """Decision API 콜드 첫 호출이 1.7~2.3초(S0c) — 서버 시작 시 1번(S5 실통화 첫 판정이 DECISION_TIMEOUT)."""
        from app.policy.render import decision_questions
        try:
            await self.d.client.decisions.create(model="gpt-6-luna", input="직전 AI 발화: (없음)\n고객 발화: 여보세요",
                                                 questions=decision_questions(self.d.policy, "intent"))
            log.info("Decision 웜업 완료")
        except Exception as e:
            log.warning("Decision 웜업 실패: %s", type(e).__name__)

    async def shutdown(self, wait_sec: float = 10.0) -> None:
        """신규 수신 거부 → 진행 통화 마무리 요청 → 정리 대기."""
        self.accepting_new = False
        for s in list(self.registry.calls.values()):
            self.begin_closing(s, "shutdown")
        deadline = time.monotonic() + wait_sec
        while self.registry.calls and time.monotonic() < deadline:
            await asyncio.sleep(0.1)

    # --- 공용 ---
    def _phase(self, s: CallSession, phase: Phase) -> None:
        if s.phase != phase:
            if phase in ENDED and not s.ended_t:
                s.ended_t = time.time()  # 통화가 끝나기 시작한 시각(대시보드 열린 대기 구간의 끝)
            s.phase = phase
            s.note("단계", phase.value)
            s.publish()  # 관제 오류가 전이·정리를 멈추지 않게

    async def _quiet(self, coro, what: str) -> None:
        try:
            await coro
        except Exception as e:
            log.warning("%s 실패: %s", what, type(e).__name__)


def _apply_context(state: ConversationState, ctx, caller: str) -> None:
    """BE CallerContext → 도메인 고객. 받는 곳 후보 = 최근 도착지(최근 것부터) → 주소록(중복 제거)."""
    c = state.customer
    c.status = ctx.status
    c.initial_status = c.initial_status or ctx.status
    c.customer_seq, c.name = ctx.customer_seq, ctx.name
    c.payment_methods = tuple(ctx.payment_methods)
    c.call_session_seq = ctx.call_session_seq or c.call_session_seq
    if getattr(ctx, "default_origin", None) and ctx.default_origin.address:
        c.default_address = ctx.default_origin.address
    origin = getattr(ctx, "default_origin", None) or getattr(ctx, "recent_origin", None)
    if origin and origin.address and c.origin_place is None:
        src = Source.PROFILE if getattr(ctx, "default_origin", None) else Source.HISTORY
        g = origin.geo
        c.origin_place = Place(c.name or origin.name, origin.phone, origin.address, origin.address_detail or "",
                               Geo(g.jibun_address, g.dong_name, g.postal_code) if g else None, src)
        state.origin_offered = state.origin_offered or src == Source.PROFILE  # 기본 주소는 인사에서 묻는다
    if origin and origin.address:
        c.origin_address = origin.address
    places, seen = [], set()
    for src, items in ((Source.HISTORY, ctx.recent_destinations), (Source.PIN, ctx.places)):
        for p in items:
            key = (p.name, p.address, p.address_detail)
            if key in seen:
                continue
            seen.add(key)
            geo = Geo(p.geo.jibun_address, p.geo.dong_name, p.geo.postal_code) if p.geo else None
            places.append(Place(p.name, p.phone, p.address, p.address_detail, geo, src))
    if places:
        c.places = tuple(places)
    state.bump()


async def _timed(s: CallSession, name: str, aw):
    """관제 지연 기록(실패해도 걸린 시간은 남긴다)."""
    t0 = time.monotonic()
    try:
        return await aw
    finally:
        s.timing(name, (time.monotonic() - t0) * 1000)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _kst(iso: str) -> str:
    try:
        return datetime.fromisoformat(iso).astimezone(KST).strftime("%Y-%m-%d %H:%M")
    except ValueError:
        return iso

