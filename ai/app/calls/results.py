"""S6: 통화 결과·신규 고객 등록·최종 분석·이벤트·미답변(spec/ai-integration-current.md §2~§5).

원칙: BE 쓰기는 대화 경로에 넣지 않는다 — 결과 전송은 서비스 단위 백그라운드 작업(통화 정리에 취소되지 않음),
분석·이벤트·미답변은 통화가 끝난 뒤. 같은 키·같은 본문·같은 eventId로만 재시도한다(아웃박스).
"""

import asyncio
import logging
import time
import uuid
from datetime import datetime, timezone

from openai import APIError
from pydantic import ValidationError

from app.calls.session import CallSession
from app.calls.unanswered import ReviewError, apply_review, evidence_from_session
from app.domain.assess import assess
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


# 대시보드(ai-dashboard-ai-integration.md §3): 시스템 사유로 끝난 통화는 이탈 판정 대상이 아니다(미전송 = 미판정)
SYSTEM_END = ("persona_unresolved", "accept_failed", "pbx_ended_during_accept", "expiring", "shutdown")
ORDER_STAGE = {"sender": "SENDER_INFO", "receiver": "RECIPIENT_INFO", "item": "ITEM_INFO",
               "readback": "CONFIRMATION"}  # PAYMENT_GUIDANCE: 결제 단계 없음(2026-11-05)
# 분석 다음에 보내는 대시보드 항목(payload 키, 진행 키) — 서로 독립: 한쪽 실패·재전송이 다른 쪽을 막지 않는다(§1)
DASHBOARD = (("stage_metrics", "send_stage_metrics"), ("wait_metrics", "send_wait_metrics"))


def dropoff_stage(s: CallSession, policy) -> str | None:
    """끊긴 순간 진행 중이던 단계. 판정하지 못하면 None — 모른다는 뜻으로 NONE을 보내지 않는다(§3)."""
    st, reason = s.state, s.close_reason or ""
    if reason in SYSTEM_END or reason.startswith("connection_") or st.agent_transferred or st.intent in (None, "agent"):
        return None

    def answered(tool: str) -> bool:  # 그 도구 결과가 나온 뒤 AI가 말했다
        done = [t for t in s.tool_calls if t["name"] == tool and t.get("output")]
        return bool(done) and s.last_output_t > done[-1]["at"] + (done[-1].get("elapsed_ms") or 0) / 1000

    if st.intent == "order":
        a = assess(st, policy)
        if a.stage in ("closing", "more_parcels"):
            return "NONE"  # 접수 정보 확정 뒤(남은 결정 없음)
        stage = ORDER_STAGE.get(a.stage)
        if stage and s.tool_calls and s.tool_calls[-1]["name"] == "search_manual":
            return "FAQ_ANSWER"  # 접수 중 질문하다 끊김(문의는 진행 중 업무를 바꾸지 않는다)
        return stage
    if st.intent == "inquiry":
        return "NONE" if answered("search_manual") else "FAQ_ANSWER"
    if st.intent == "lookup":
        return "NONE" if answered("lookup_orders") else "ORDER_LOOKUP"
    if st.intent == "cancel":
        return "NONE" if st.cancel_done else "ORDER_CANCEL"
    return None


def wait_metrics(s: CallSession) -> dict:
    """§4 본문. 대기 = 고객 말 끝 → AI 말 시작 구간 합계(순서대로라 겹치지 않음). 고객 말 뒤 AI 말 없이 끝났으면
    끝나기 시작한 시각까지. 측정하지 않은 유형은 뺀다(횟수 0 금지)."""
    total, rt = s.wait_ms, s.rt
    if rt is not None and rt.cust_end_t and rt.cust is None and s.ended_t > rt.cust_end_t:
        total += (s.ended_t - rt.cust_end_t) * 1000
    return {"providerCallId": s.call_id, "totalWaitMs": round(total),
            "latencyStats": [{"processType": k, "totalLatencyMs": int(ms), "measurementCount": int(n)}
                             for k, (ms, n) in s.latency.items() if n > 0]}


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="milliseconds")


class ResultService:
    def __init__(self, backend: BackendGateway, outbox: Outbox, policy, fare_of, submit_budget_sec: float = 60.0,
                 callback_field: bool = False, reviewer=None, reason_contract_enabled: bool = False,
                 review_max_attempts: int = 3, faq_answered_enabled: bool = False):
        self.backend, self.outbox, self.policy, self.fare_of = backend, outbox, policy, fare_of
        self.callback_field = callback_field  # 분석 hasCallbackRequest(새 BE 배포 후에만 켠다)
        self.submit_budget_sec = submit_budget_sec
        self.tasks: dict[str, asyncio.Task] = {}   # session_id → 결과 전송(통화 정리와 무관하게 끝까지)
        self.background: set[asyncio.Task] = set()
        self.reviewer = reviewer
        self.reason_contract_enabled = reason_contract_enabled
        self.review_max_attempts = review_max_attempts
        self.faq_answered_enabled = faq_answered_enabled
        self.review_lock = asyncio.Lock()  # 한 프로세스 안에서 종료·복구 작업의 중복 판정/전송 방지
        self.insight_lock = asyncio.Lock()  # 전사 작업과 검토 작업이 같은 진행 상태를 덮지 않게 한다.
        self.result_lock = asyncio.Lock()   # 기동 복구와 주기 재확인이 같은 결과 행을 동시에 보내지 않게

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
                c.default_address_detail = snap.get("sender_address_detail") or ""
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
            # 503·네트워크·시간 초과는 같은 키로 다시(주기 재확인·재시작 때), 404(삭제·만료 통화)·400·422·그 밖 409는 멈춘다(§8)
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
        async with self.result_lock:
            for row in await asyncio.to_thread(self.outbox.unfinished_results):
                await self._send(row)
        for row in await asyncio.to_thread(self.outbox.unfinished_insights):
            await self._send_insight(row)
        await self.recover_reviews()

    async def resend_loop(self, interval_sec: float) -> None:
        while True:
            await asyncio.sleep(interval_sec)
            await self.resend_unfinished()

    async def resend_unfinished(self) -> None:
        """실행 중에도 SENT_UNCERTAIN(503·연결 끊김·시간 초과) 주문 결과를 같은 키·본문으로 다시 확인한다(BE 확인 2026-11-05 2번).
        새 키를 만들지 않으므로 BE가 이미 저장했으면 기존 결과를 돌려주고, 못 받았으면 그때 저장한다."""
        async with self.result_lock:
            for row in await asyncio.to_thread(self.outbox.unfinished_results):
                task = self.tasks.get(row["session_id"])
                if task is not None and not task.done():
                    continue  # 이 프로세스가 지금 보내는 중
                if time.time() - (row.get("updated_at") or 0) < self.submit_budget_sec:
                    continue  # 방금 바뀐 행(전송 직후·다른 작업과 경쟁)은 다음 주기에
                await self._send(row)

    async def review_loop(self, poll_sec: float) -> None:
        while True:
            await asyncio.sleep(poll_sec)
            await self.recover_reviews()

    async def recover_reviews(self) -> None:
        if self.reviewer is None:
            return
        for row in await asyncio.to_thread(self.outbox.unfinished_reviews):
            await self._process_review(row["session_id"])
        # 검토가 끝난 뒤 전송만 실패한 건도 실행 중 재시도한다(재판정하지 않는다).
        async with self.review_lock:
            for row in await asyncio.to_thread(self.outbox.unfinished_insights):
                review = await asyncio.to_thread(self.outbox.review, row["session_id"])
                if row["payload"].get("deferred_review") or (review is not None and review["status"] == "DONE"):
                    await self._send_insight(row)

    async def _process_review(self, sid: str) -> None:
        async with self.review_lock:
            row = await asyncio.to_thread(self.outbox.review, sid)
            if row is None or row["status"] not in ("PENDING", "READY"):
                return
            if row["status"] == "PENDING":
                if row["attempts"] >= self.review_max_attempts:
                    await self._failed_review(row, "REVIEW_ATTEMPTS_EXHAUSTED")
                    return
                await asyncio.to_thread(self.outbox.begin_review, sid)
                verdict = None
                try:
                    source = row["input"]
                    verdict = await self.reviewer.review(source["evidence"])
                    prepared = apply_review(sid, source["started_t"], source["evidence"], source["payload"], verdict,
                                            faq_answered_enabled=self.faq_answered_enabled)
                    await asyncio.to_thread(self.outbox.record_review_attempt, sid, row["attempts"] + 1, verdict, None)
                    await asyncio.to_thread(self.outbox.complete_review, sid, verdict, prepared)
                except (APIError, TimeoutError, ReviewError, ValidationError) as e:
                    # 모델/판정 장애는 지식 검색 장애가 아니다. 고객 미답변을 만들어 보내지 않는다.
                    code = str(e) if isinstance(e, ReviewError) else type(e).__name__
                    await asyncio.to_thread(self.outbox.record_review_attempt, sid, row["attempts"] + 1,
                                            (e.diagnostic or verdict) if isinstance(e, ReviewError) else verdict, code)
                    status = "FAILED" if row["attempts"] + 1 >= self.review_max_attempts else "PENDING"
                    if status == "FAILED":
                        await self._failed_review(row, code)
                    else:
                        await asyncio.to_thread(self.outbox.update_review, sid, status, code)
                    log.warning("통화 종료 검토 보류 %s %s", sid, code)
                    return
                row = await asyncio.to_thread(self.outbox.review, sid)
            if not self.reason_contract_enabled and not row["prepared"].get("deferred_review"):
                return  # 계약이 확정되기 전에는 reason을 구버전 BE에 보내지 않는다.
            if not self.faq_answered_enabled and _has_faq_answers(row["prepared"]) and not row["prepared"].get("deferred_review"):
                return  # 이미 고정된 배열 이벤트는 임의 제거하지 않고 지원 환경까지 보류한다.
            insight = await asyncio.to_thread(self.outbox.create_insight, sid, row["call_session_seq"], row["prepared"])
            await self._send_insight(insight)
            # 전송 실패면 기존 insights 아웃박스가 복구한다. 확정 판정은 다시 호출하지 않는다.
            await asyncio.to_thread(self.outbox.update_review, sid, "DONE")

    async def _failed_review(self, row: dict, code: str) -> None:
        sid, source = row["session_id"], row["input"]
        prepared = source["payload"] | {"unanswered": [],
            "analysis": source["payload"]["analysis"] | {"faqAnswerCount": None}}
        await asyncio.to_thread(self.outbox.fail_review, sid, code, prepared)
        insight = await asyncio.to_thread(self.outbox.create_insight, sid, row["call_session_seq"], prepared)
        await self._send_insight(insight)

    async def drain(self) -> None:
        """종료 시 작업을 취소해도 저장된 PENDING/READY/insights에서 재개한다."""
        tasks = list(self.background)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

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
        if self.reviewer is not None:
            payload = payload | {"deferred_review": True, "base_event_count": len(payload["events"])}
            await asyncio.to_thread(self.outbox.create_review, s.call_id, seq,
                                    {"started_t": s.started_t, "evidence": evidence_from_session(s), "payload": payload})
            # 이 본문은 불변. 최종 분석/추가 결과는 review_jobs.prepared_json에 따로 고정한다.
            base = payload | {"unanswered": [], "analysis": payload["analysis"] | {"faqAnswerCount": None}}
            insight = await asyncio.to_thread(self.outbox.create_insight, s.call_id, seq, base)
            delivery = asyncio.create_task(self._send_insight(insight), name=f"records:{s.call_id[-8:]}")
            self.background.add(delivery)
            delivery.add_done_callback(self._review_done)
            task = asyncio.create_task(self._process_review(s.call_id), name=f"review:{s.call_id[-8:]}")
            self.background.add(task)
            task.add_done_callback(self._review_done)
            return  # 통화 소유 작업으로 생성하지 않는다. Live는 판정을 기다리지 않는다.
        row = await asyncio.to_thread(self.outbox.create_insight, s.call_id, seq, payload)
        await self._send_insight(row)

    def _review_done(self, task: asyncio.Task) -> None:
        self.background.discard(task)
        if not task.cancelled() and task.exception() is not None:
            log.error("통화 종료 검토 작업 오류: %s", type(task.exception()).__name__)

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
        stage = dropoff_stage(s, self.policy)
        return {"provider_call_id": s.call_id, "events": events, "analysis": analysis, "unanswered": unanswered,
                "stage_metrics": {"providerCallId": s.call_id, "dropoffStage": stage} if stage else None,
                "wait_metrics": wait_metrics(s)}

    async def _send_insight(self, row: dict) -> None:
        async with self.insight_lock:
            row = await asyncio.to_thread(self.outbox.insight, row["session_id"])
            if row["status"] in ("DONE", "FAILED"):
                return
            if row["payload"].get("deferred_review"):
                await self._send_deferred_insight(row)
            else:
                await self._send_legacy_insight(row)

    async def _send_deferred_insight(self, row: dict) -> None:
        """기본 기록·부가 결과·최종 분석을 독립 전송. 각 본문/진행 단계는 불변."""
        sid, seq, base = row["session_id"], row["call_session_seq"], row["payload"]
        progress, api = dict(row["progress"]), self.backend.api

        async def perform(key, op, fn, *args):
            if progress.get(key) in ("done", "failed"):
                return progress[key] == "done"
            try:
                data = await self.backend.write(op, fn, *args)
                progress[key] = "done"
                if data is not None:
                    progress[key + "_result"] = data
            except BackendFailure as e:
                progress[key] = None if e.kind in ("unavailable", "in_progress") else "failed"
                progress[key + "_error"] = e.code
                log.warning("통화 기록 단계 보류 %s %s %s", sid, key, e.code)
            await asyncio.to_thread(self.outbox.update_insight, sid, "PENDING", progress)
            return progress.get(key) == "done"

        base_done = True
        for i, batch in enumerate(_batches(base["provider_call_id"], base["events"])):
            key = f"base_batch_{i}"
            if not await perform(key, "events", api.send_call_events, seq, batch):
                base_done = False
                progress["base"] = "failed" if progress.get(key) == "failed" else None
                break
        if base_done:
            progress["base"] = "done"
        review = await asyncio.to_thread(self.outbox.review, sid)
        prepared = review.get("prepared") if review else None
        if prepared is None:
            await asyncio.to_thread(self.outbox.update_insight, sid, "PENDING", progress)
            return  # 전사는 이미 전송. 분석은 검토 최종값/미판정 값 확정까지 기다린다.

        extras = prepared["events"][base["base_event_count"]:]
        unanswered = prepared["unanswered"]
        permitted = ((self.reason_contract_enabled or not unanswered)
                     and (self.faq_answered_enabled or not _has_faq_answers(prepared)))
        extra_done = permitted
        if permitted and base_done:
            for i, item in enumerate(unanswered):
                if not await perform(f"unanswered_{i}", "unanswered", api.send_unanswered,
                                     item | {"callSessionSeq": seq, "providerCallId": base["provider_call_id"]}):
                    extra_done = False
                    if progress.get(f"unanswered_{i}") == "failed":
                        progress["review_events"] = "failed"
                    break
            if extra_done:
                events = list(extras)
                order = len(prepared["events"])
                for i, item in enumerate(unanswered):
                    events.append({"eventId": str(uuid.uuid5(NAMESPACE, f"{sid}:qu:{i}")),
                                   "eventOrder": order + i + 1, "kind": "BUSINESS_RESULT",
                                   "occurredAt": item["occurredAt"], "offsetSeconds": item["offsetSeconds"],
                                   "payload": {"action": "QUESTION_UNANSWERED", "orderSeq": None,
                                               "unansweredQuestionSeq": progress[f"unanswered_{i}_result"],
                                               "summaryText": "답하지 못한 질문 기록"}})
                for i, batch in enumerate(_batches(base["provider_call_id"], events)):
                    key = f"review_batch_{i}"
                    if not await perform(key, "events", api.send_call_events, seq, batch):
                        extra_done = False
                        if progress.get(key) == "failed":
                            progress["review_events"] = "failed"
                        break
        elif not base_done and (extras or unanswered):
            extra_done = False
            if progress.get("base") == "failed":
                progress["review_events"] = "failed"
        elif not extras and not unanswered:
            extra_done = True
        if extra_done:
            progress["review_events"] = "done"

        # FAQ·미답변 전송 오류와 무관하게 검토 후 확정한 분석은 전송한다.
        await perform("analysis", "analysis", api.send_call_analysis, seq, prepared["analysis"])
        for key, method in DASHBOARD:
            if prepared.get(key) is None:
                continue
            if progress.get("analysis") == "done":
                await perform(key, key, getattr(api, method), seq, prepared[key])
            elif progress.get("analysis") == "failed":
                progress[key] = "failed"
        stages = ["base", "review_events", "analysis", *(k for k, _ in DASHBOARD if prepared.get(k) is not None)]
        waiting = any(progress.get(k) not in ("done", "failed") for k in stages)
        status = "PENDING" if waiting else ("FAILED" if any(progress.get(k) == "failed" for k in stages) else "DONE")
        await asyncio.to_thread(self.outbox.update_insight, sid, status, progress)

    async def _send_legacy_insight(self, row: dict) -> None:
        sid, seq, p = row["session_id"], row["call_session_seq"], row["payload"]
        if not self.reason_contract_enabled and any("reason" in u for u in p["unanswered"]):
            return  # 재시작으로 복구한 새 본문에도 같은 계약 게이트를 적용한다.
        if not self.faq_answered_enabled and _has_faq_answers(p):
            return
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
        except BackendFailure as e:
            status = "PENDING" if e.kind in ("unavailable", "in_progress") else "FAILED"
            await asyncio.to_thread(self.outbox.update_insight, sid, status, progress | {"error": e.code})
            log.error("통화 기록 전송 %s %s", sid, e)
            return
        retry = False
        for key, method in DASHBOARD:  # analysis 204 뒤에만. 배포 전에 저장된 본문(키 없음)은 보내지 않는다
            if p.get(key) is None or progress.get(key) in ("done", "failed"):
                continue
            try:
                await self.backend.write(key, getattr(api, method), seq, p[key])
                progress[key] = "done"
            except BackendFailure as e:  # 5xx·연결은 같은 본문으로 다시, 409 충돌·422·400 등은 멈춘다(§5)
                again = e.kind in ("unavailable", "in_progress")
                retry |= again
                progress |= {key: None if again else "failed", f"{key}_error": e.code}
                log.error("대시보드 전송 %s %s %s", sid, key, e)
        await asyncio.to_thread(self.outbox.update_insight, sid, "PENDING" if retry else "DONE", progress)
        log.info("통화 기록 전송 %s", sid)


def _has_faq_answers(payload: dict) -> bool:
    return any(e.get("payload", {}).get("action") == "FAQ_ANSWERED" for e in payload.get("events", []))


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
