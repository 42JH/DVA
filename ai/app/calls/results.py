"""S6: 통화 결과·신규 고객 등록·최종 분석·이벤트·미답변(spec/ai-integration-current.md §2~§5).

원칙: BE 쓰기는 대화 경로에 넣지 않는다 — 결과 전송은 서비스 단위 백그라운드 작업(통화 정리에 취소되지 않음),
분석·이벤트·미답변은 통화가 끝난 뒤. 같은 키·같은 본문·같은 eventId로만 재시도한다(아웃박스).
"""

import asyncio
import logging
import time
import uuid
from datetime import datetime, timezone

from app.calls.session import CallSession
from app.domain.outcome import decide_outcome
from app.domain.state import Source, draft_snapshot
from app.integrations.backend.gateway import BackendFailure, BackendGateway
from app.integrations.backend.mapping import submit_body, to_order
from app.persistence.outbox import Outbox

log = logging.getLogger(__name__)
NAMESPACE = uuid.UUID("6f1d3c52-6a59-4c4c-9a39-4b7c5f0f2d11")  # 원본 insights.py와 같은 규칙: uuid5(통화 ID:순번)
MAX_EVENTS, MAX_BYTES, MAX_TEXT = 50, 90 * 1024, 1000
# 주문이 저장된 결과(접수 정보 확정 — 결제·디버 접수 완료와는 별개, registeredParcelCount 기준)
SAVED = ("ACCEPTED", "notPaid", "PAID", "SUBMITTING", "SUBMITTING_FAILED", "SUBMISSION_FAILED")
ACTIONS = {"find_destination": "PIN_SEARCH", "lookup_orders": "PREVIOUS_ORDER_SEARCH", "search_manual": "FAQ_SEARCH",
           "record_fields": "FIELD_SAVED"}


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="milliseconds")


class ResultService:
    def __init__(self, backend: BackendGateway, outbox: Outbox, policy, fare_of, submit_budget_sec: float = 60.0,
                 callback_field: bool = False):
        self.backend, self.outbox, self.policy, self.fare_of = backend, outbox, policy, fare_of
        self.callback_field = callback_field  # 분석 hasCallbackRequest(새 BE 배포 후에만 켠다)
        self.submit_budget_sec = submit_budget_sec
        self.tasks: dict[str, asyncio.Task] = {}   # session_id → 결과 전송(통화 정리와 무관하게 끝까지)
        self.background: set[asyncio.Task] = set()

    # ------------------------------------------------------------------ 신규 고객 등록(원본 register_customer)
    async def register(self, s: CallSession, call_session_seq) -> None:
        """보내는 분 성함·주소·상세가 다 찬 미등록 고객을 통화당 1번 등록 → 고객 확인 재호출 → 보내는 곳 PIN.
        실패해도 통화는 신규 고객으로 이어 가고 결과는 customer{name, phoneNumber}로 보낸다."""
        op = s.tools.ops["register"]
        try:
            seq = await call_session_seq(s)
            async with s.lock:
                cur = s.state.current
                name = cur["sender_name"].value
                snap = draft_snapshot(cur)
                geo = cur.sender_geo
            address = None
            if geo:  # 주소 7항목 중 이름·번호를 뺀 완성 주소만(부분 주소로 기본 출발지를 만들지 않는다)
                address = {"roadAddress": snap["sender_address"], "jibunAddress": geo.jibun_address,
                           "detailAddress": snap.get("sender_address_detail") or "", "dongName": geo.dong_name,
                           "postalCode": geo.postal_code}
            await self.backend.write("create_customer", self.backend.api.create_customer, name, s.caller, address)
            call = {"providerCallId": s.call_id, "incomingAt": s.incoming_at}
            ctx = await self.backend.read("caller_context3", self.backend.api.caller_context, s.caller, call, 0)
            from app.calls.service import _apply_context
            async with s.lock:
                _apply_context(s.state, ctx, s.caller)
            if ctx.status == "REGISTERED" and geo and seq:
                await self.backend.write("create_pin", self.backend.api.create_pin, seq, ctx.customer_seq,
                                         to_order(snap), "sender", "보내는 곳")
            op["status"] = "done" if ctx.status == "REGISTERED" else "failed"
            s.note("고객 등록", ctx.status)
        except BackendFailure as e:
            op["status"] = "failed"
            s.note("고객 등록 실패", e.code)

    async def save_addresses(self, s: CallSession, call_session_seq, snap: dict, offer: dict) -> None:
        """고객 동의 후 저장(BE 계약 ai-call-follow-up.md): 기본 주소 PATCH(통화 중, call_session_seq 헤더),
        받는 곳 PIN 추가(같은 주소 409 DUPLICATE_RESOURCE는 이미 있음). 실패는 주문에 영향 없음(관측만)."""
        try:
            seq = await call_session_seq(s)
            c = s.state.customer
            if not seq or not c.customer_seq:
                s.note("주소 저장 생략", "통화 번호·고객 번호 없음")
                return
            if offer.get("sender") and (geo := snap.get("sender_geo")):
                address = {"roadAddress": snap["sender_address"], "jibunAddress": geo.jibun_address,
                           "detailAddress": snap.get("sender_address_detail") or "", "dongName": geo.dong_name,
                           "postalCode": geo.postal_code}
                await self.backend.write("update_customer_address", self.backend.api.update_customer_address,
                                         c.customer_seq, seq, address)
                c.default_address = snap["sender_address"]
                s.note("기본 주소 저장", "ok")
            if offer.get("receiver") and snap.get("receiver_geo"):
                await self.backend.write("create_pin", self.backend.api.create_pin, seq, c.customer_seq,
                                         to_order(snap), "receiver", snap.get("receiver_name") or "받는 곳")
                s.note("주소록 저장", "ok")
        except BackendFailure as e:
            s.note("주소 저장 실패", e.code)

    # ------------------------------------------------------------------ 통화 결과
    def start(self, s: CallSession, on_result=None) -> asyncio.Task:
        """결과 전송을 시작(이미 했으면 그 작업). 대화는 기다리지 않는다(사용자 결정 2-b)."""
        if (t := self.tasks.get(s.call_id)) is not None:
            return t
        t = asyncio.create_task(self.submit(s, on_result), name=f"result:{s.call_id[-8:]}")
        self.tasks[s.call_id] = t
        return t

    async def submit(self, s: CallSession, on_result=None) -> dict | None:
        row = await asyncio.to_thread(self.outbox.result, s.call_id)
        if row is None:
            reg = s.tools.ops.get("register")
            if reg and reg.get("status") == "running":  # 등록 중이면 끝나길 잠깐 기다린다(customerSeq로 보내려고)
                for _ in range(50):
                    if reg.get("status") != "running":
                        break
                    await asyncio.sleep(0.1)
            async with s.lock:
                outcome = decide_outcome(s.state, self.policy, datetime.now(timezone.utc), self.fare_of)
                if outcome.kind is None or not s.caller:
                    return None  # 무의미 통화: 등록·쓰기 없음
                c = s.state.customer
                body = submit_body(outcome, {"providerCallId": s.call_id, "callerPhoneNumber": s.caller,
                                             "incomingAt": s.incoming_at}, c.customer_seq, None, s.caller)
                s.state.bump()
            s.note("결과 본문", f"{outcome.kind} {','.join(outcome.reasons) or ''}")
            row = await asyncio.to_thread(self.outbox.create_result, s.call_id, str(uuid.uuid4()), body)
        data = await self._send(row)
        if data is not None:
            s.state.result_accepted = data.get("status") == "ACCEPTED"
            s.result = data
            s.note("결과", str(data.get("status")))
            if on_result:
                await on_result(s, data)
        return data

    async def _send(self, row: dict) -> dict | None:
        sid = row["session_id"]
        if row["status"] in ("DONE", "FAILED"):
            return row["data"]
        try:
            data = await self.backend.write("submit", self.backend.api.submit_result, row["body"], row["key"],
                                            budget_sec=self.submit_budget_sec)
        except BackendFailure as e:
            # 503·네트워크·시간 초과는 같은 키로 다시(재시작 때), 404(삭제·만료 통화)·400·422·그 밖 409는 멈춘다(§8)
            status = "SENT_UNCERTAIN" if e.kind in ("unavailable", "in_progress") else "FAILED"
            await asyncio.to_thread(self.outbox.update_result, sid, status, {"error": e.code, "http": e.http_status,
                                                                            "errorCode": e.error_code})
            log.error("결과 전송 %s %s %s", sid, status, e)
            return None
        # SUBMITTING·SUBMITTING_FAILED는 BE가 자동 재시도 중 — 새 키를 만들지 않는다. 받은 상태 그대로 기록
        await asyncio.to_thread(self.outbox.update_result, sid, "DONE", data)
        log.info("결과 %s → %s", sid, data.get("status"))
        return data

    async def recover(self) -> None:
        """재시작 후: 끝나지 않은 결과·인사이트를 같은 키·본문·eventId로 다시 보낸다."""
        for row in await asyncio.to_thread(self.outbox.unfinished_results):
            await self._send(row)
        for row in await asyncio.to_thread(self.outbox.unfinished_insights):
            await self._send_insight(row)

    # ------------------------------------------------------------------ 분석·이벤트·미답변(통화 끝)
    async def finish(self, s: CallSession) -> None:
        """정리 훅: 결과 전송을 끝까지 기다린 뒤(없으면 지금 시작) 인사이트를 만들어 보낸다."""
        task = self.tasks.get(s.call_id) or (self.start(s) if s.state.intent or s.state.parcels else None)
        if task is not None:
            try:
                await task
            except Exception:
                log.exception("결과 전송 작업 실패 %s", s.call_id)
            self.tasks.pop(s.call_id, None)
        seq = s.state.customer.call_session_seq
        if not seq or not s.state.intent or not getattr(self.backend.api, "insights_enabled", False):
            return  # 무의미 통화·통화 미등록·수집 토큰 없음: 보내지 않는다
        payload = self.build_insights(s)
        row = await asyncio.to_thread(self.outbox.create_insight, s.call_id, seq, payload)
        await self._send_insight(row)

    def build_insights(self, s: CallSession) -> dict:
        st, now = s.state, time.time()
        started = s.started_t

        def off(ts):
            return max(0, int(ts - started)) if ts else None

        rows: list[tuple[float, str, dict]] = []
        if st.customer.initial_status:
            rows.append((started, "AI_ACTION", {"action": "CUSTOMER_LOOKUP", "summaryText": {
                "REGISTERED": "등록 고객", "WITHDRAWN": "탈퇴 고객"}.get(st.customer.initial_status, "미등록 고객"),
                "orderSeq": None}))
        utter = 0
        utter_at: list[tuple[float, int, str]] = []
        for r in s.transcript:
            if not r["text"].strip():
                continue
            utter += 1
            utter_at.append((r["t"], utter, r["speaker"]))
            rows.append((r["t"], "UTTERANCE", {"utteranceOrder": utter,
                                                "speaker": "CUSTOMER" if r["speaker"] == "customer" else "AI",
                                                "utteranceText": r["text"][:20000], "lastSentenceSeq": 1}))
        unanswered = []
        for t in s.tool_calls:
            action = ACTIONS.get(t["name"])
            out = t.get("output") or {}
            if not action or not out:
                continue
            rows.append((t.get("at", started), "AI_ACTION", {"action": action, "orderSeq": None,
                                                              "summaryText": _summary(t["name"], out)}))
            if t["name"] == "search_manual" and not (out.get("facts") or {}).get("answerable"):
                q = _question(t)
                if q:
                    unanswered.append({"eventId": str(uuid.uuid5(NAMESPACE, f"{s.call_id}:unanswered:{len(unanswered)}")),
                                       "questionText": q[:1000], "occurredAt": _iso(t.get("at", started)),
                                       "offsetSeconds": off(t.get("at"))})
        data = getattr(s, "result", None) or {}
        order_seq = data.get("orderSeq") if isinstance(data.get("orderSeq"), int) else None
        if data:
            rows.append((now, "AI_ACTION", {"action": "ORDER_SUBMITTED", "orderSeq": order_seq,
                                            "summaryText": f"통화 결과 전송: {data.get('status') or '응답 없음'}"}))
        if data.get("status") in SAVED:
            rows.append((now, "BUSINESS_RESULT", {"action": "ORDER_CREATED", "orderSeq": order_seq,
                                                  "unansweredQuestionSeq": None, "summaryText": "택배 접수 주문 저장"}))
        cancels = [k for k, v in s.tools.ops.items() if k.startswith("cancel:") and v.get("status") in ("done", "already")]
        for key in cancels:
            rows.append((now, "BUSINESS_RESULT", {"action": "ORDER_CANCELLED", "orderSeq": int(key.split(":")[1]),
                                                  "unansweredQuestionSeq": None, "summaryText": "택배 취소"}))
        if st.agent_transferred:
            rows.append((now, "BUSINESS_RESULT", {"action": "HANDOFF_REQUESTED", "orderSeq": None,
                                                  "unansweredQuestionSeq": None, "summaryText": "상담원 연결 요청"}))
        if st.intent == "inquiry" and not data:
            rows.append((now, "BUSINESS_RESULT", {"action": "INQUIRY", "orderSeq": None, "unansweredQuestionSeq": None,
                                                  "summaryText": "문의 응대"}))
        rows.sort(key=lambda r: r[0])
        events = [{"eventId": str(uuid.uuid5(NAMESPACE, f"{s.call_id}:{i}")), "eventOrder": i, "kind": kind,
                   "occurredAt": _iso(ts), "offsetSeconds": off(ts), "payload": payload}
                  for i, (ts, kind, payload) in enumerate(rows, 1)]
        submitted = _parcel_count(self.outbox, s.call_id) if data.get("status") in SAVED else 0
        analysis = {
            "providerCallId": s.call_id, "startedAt": _iso(started), "endedAt": _iso(now),
            "aiPersonaVersionSeq": s.persona_version_seq,           # 서버 기본 프롬프트면 null(BE가 ACTIVE로 채우지 않음)
            "isNewCustomer": st.customer.initial_status != "REGISTERED" if st.customer.initial_status else None,
            "registeredParcelCount": submitted,
            "faqAnswerCount": sum(1 for t in s.tool_calls if t["name"] == "search_manual"
                                  and ((t.get("output") or {}).get("facts") or {}).get("answerable")),
            "orderLookupCount": sum(1 for t in s.tool_calls if t["name"] == "lookup_orders"
                                    and ((t.get("output") or {}).get("facts") or {}).get("found")),
            "cancelledParcelCount": len(cancels),
            "hasHandoffRequest": bool(st.agent_transferred),
            **({"hasCallbackRequest": bool(st.callback_requested)} if self.callback_field else {}),
            "repeatQuestionCount": _repeats(st),                    # 서버가 다시 받게 한 횟수(검증 실패 기준)
            "hasComplaint": None, "complaints": [],                 # 불만 판정 장치 없음 → 미수집(null)
        }
        return {"provider_call_id": s.call_id, "events": events, "analysis": analysis, "unanswered": unanswered}

    async def _send_insight(self, row: dict) -> None:
        sid, seq, p = row["session_id"], row["call_session_seq"], row["payload"]
        progress = dict(row["progress"])
        api = self.backend.api
        try:
            seqs = progress.get("unanswered_seqs", [])
            for i, u in enumerate(p["unanswered"][len(seqs):], start=len(seqs)):
                body = u | {"callSessionSeq": seq, "providerCallId": p["provider_call_id"]}
                seqs.append(await self.backend.write("unanswered", api.send_unanswered, body))
                progress["unanswered_seqs"] = seqs
            events = list(p["events"])
            order = len(events)
            for i, uq in enumerate(seqs):  # 미답변 번호를 참조하는 업무 결과(같은 eventId 규칙으로 고정)
                order += 1
                u = p["unanswered"][i]
                events.append({"eventId": str(uuid.uuid5(NAMESPACE, f"{sid}:qu:{i}")), "eventOrder": order,
                               "kind": "BUSINESS_RESULT", "occurredAt": u["occurredAt"],
                               "offsetSeconds": u["offsetSeconds"],
                               "payload": {"action": "QUESTION_UNANSWERED", "orderSeq": None,
                                           "unansweredQuestionSeq": uq, "summaryText": "답하지 못한 질문 기록"}})
            for b in _batches(p["provider_call_id"], events)[progress.get("batches", 0):]:
                await self.backend.write("events", api.send_call_events, seq, b)
                progress["batches"] = progress.get("batches", 0) + 1
            if not progress.get("analysis"):
                await self.backend.write("analysis", api.send_call_analysis, seq, p["analysis"])
                progress["analysis"] = True
            await asyncio.to_thread(self.outbox.update_insight, sid, "DONE", progress)
            log.info("통화 기록 전송 %s", sid)
        except BackendFailure as e:
            status = "PENDING" if e.kind in ("unavailable", "in_progress") else "FAILED"
            await asyncio.to_thread(self.outbox.update_insight, sid, status, progress | {"error": e.code})
            log.error("통화 기록 전송 %s %s", sid, e)


def _summary(name: str, out: dict) -> str:
    """도구 결과 한 줄. 인수 원문·개인정보(이름·번호·주소)는 넣지 않는다."""
    facts, code = out.get("facts") or {}, out.get("code")
    if out.get("status") not in ("ok", "needs_choice"):
        return f"실패·재질문: {code or out.get('status')}"[:MAX_TEXT]
    if name == "record_fields":
        return f"기록: {len(facts.get('recorded') or [])}개 항목"
    if name == "find_destination":
        return f"받는 곳 후보 {facts.get('found', 0)}건"
    if name == "lookup_orders":
        return f"택배 {facts.get('found', 0)}건 찾음"
    if name == "search_manual":
        return "FAQ 근거 있음" if facts.get("answerable") else "FAQ 근거 없음"
    return "완료"


def _question(tool_call: dict) -> str | None:
    import json
    try:
        return (json.loads(tool_call.get("arguments") or "{}").get("question") or "").strip() or None
    except ValueError:
        return None


def _repeats(state) -> int:
    drafts = [state.current] if state.current else []
    drafts += [p.draft for p in state.parcels]
    return sum(f.attempts for d in drafts for f in d.fields.values() if f.source != Source.CALLER_ID)


def _parcel_count(outbox: Outbox, session_id: str) -> int:
    row = outbox.result(session_id)
    return len(row["body"].get("parcels") or []) if row and row["body"].get("outcome") == "COMPLETE" else 0


def _batches(provider_call_id: str, events: list[dict]) -> list[dict]:
    import json
    out, current = [], []
    for e in events:
        body = {"providerCallId": provider_call_id, "events": [*current, e]}
        if current and (len(body["events"]) > MAX_EVENTS or len(json.dumps(body, ensure_ascii=False).encode()) > MAX_BYTES):
            out.append({"providerCallId": provider_call_id, "events": current})
            current = []
        current.append(e)
    if current:
        out.append({"providerCallId": provider_call_id, "events": current})
    return out
