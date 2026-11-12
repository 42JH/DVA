"""배송 초안 저장과 통화 종료 확정을 순서대로 재생한다."""

import asyncio
import logging
from uuid import uuid4
from weakref import WeakValueDictionary

from app.domain.assess import assess
from app.domain.state import ACCEPTED_STATUSES, draft_snapshot
from app.domain.store import hold_unclassified_items, is_pending_reconfirm
from app.integrations.backend.gateway import BackendFailure
from app.integrations.backend.mapping import to_order
from backend_client.api import parcel_body

log = logging.getLogger(__name__)
COUNTS = ("documentCount", "smallBoxCount", "mediumBoxCount", "bigBoxCount", "otherItemDescription")


def _contains(actual: dict, desired: dict) -> bool:
    return all(_contains(actual.get(key) or {}, value) if isinstance(value, dict) else actual.get(key) == value
               for key, value in desired.items())


def _applied(current: dict, body: dict) -> bool:
    if current["version"] != body["expectedVersion"] + 1:
        return False
    action = body["action"]
    if action == "CANCEL":
        return current["status"] == "CANCELLED"
    parcel = current["parcel"]
    if action == "START_EDIT":
        fields = [part for key in body["clearFields"] for part in (COUNTS if key == "items" else (key,))]
        return current["status"] == "EDITING" and all(not any(parcel[key].values()) if isinstance(parcel.get(key), dict)
                                                      else not parcel.get(key) for key in fields)
    return current["status"] == body["status"] and _contains(parcel, body["parcel"])


class IntakeService:
    def __init__(self, backend, outbox, policy, fare_of):
        self.backend, self.outbox, self.policy, self.fare_of = backend, outbox, policy, fare_of
        self.locks = WeakValueDictionary()

    def sync(self, s, *, payment_available: bool = True) -> bool:
        """통화 잠금 안에서 저장할 내용을 고정한다. 확인되지 않은 수정은 READY로 되돌리지 않는다."""
        st, seq = s.state, s.state.customer.call_session_seq
        if not seq:
            return False
        if st.editing:
            edited = next(p for p in st.parcels if p.parcel_id == st.editing)
            edited.confirmed_snapshot = edited.confirmed_hash = None
        previous, saved = {}, {}
        for step in self.outbox.intake_steps(s.call_id):
            previous[step["parcel_id"]] = step
            if step["result"]:
                saved[step["parcel_id"]] = step["result"]
        changed = False
        for pid in st.discarded_parcel_ids:
            if pid in previous and previous[pid]["action"] != "CANCEL":
                self.outbox.add_intake_step(s.call_id, seq, pid, "CANCEL", {})
                changed = True
        st.discarded_parcel_ids.clear()
        parcels = [(p.draft, None if is_pending_reconfirm(p) else p.confirmed_snapshot)
                   for p in st.parcels if p.parcel_id != st.editing]
        if st.current is not None:
            parcels.append((st.current, None))
        for draft, confirmed in parcels:
            if draft.empty() and draft.client_parcel_id is None:
                continue
            draft.client_parcel_id = draft.client_parcel_id or str(uuid4())
            pid = draft.client_parcel_id
            prior = previous.get(pid)
            if prior and prior["action"] == "CANCEL":
                continue
            snapshot = confirmed if confirmed is not None else draft_snapshot(draft)
            blocked = bool(draft.item_issues or st.unassigned_item_issues)
            if blocked:
                snapshot = {key: value for key, value in snapshot.items() if key not in ("items", "item_price")}
            fare = self.fare_of(snapshot) if confirmed is not None and not blocked else None
            parcel = parcel_body(to_order(snapshot), fare if fare and fare > 0 else None)
            ready = bool(confirmed is not None and st.customer.customer_seq and st.customer.status != "WITHDRAWN"
                         and payment_available and not blocked and fare and fare > 0
                         and self._ready(parcel))
            body = {"status": "READY" if ready else "EDITING", "parcel": parcel}
            if prior and prior["action"] == "SAVE" and prior["payload"] == body:
                continue
            stored_parcel = (saved.get(pid) or {}).get("parcel") or {}
            previous_body = (prior["payload"] if prior and prior["action"] == "SAVE"
                             else saved.get(pid) or {})
            fields = _cleared_fields(previous_body.get("parcel") or {}, parcel)
            origin_keys = ("roadAddress", "detailAddress", "jibunAddress", "dongName", "postalCode")
            old_origin, new_origin = stored_parcel.get("origin") or {}, parcel.get("origin") or {}
            if stored_parcel.get("originPin") and any((old_origin.get(k) or "") != (new_origin.get(k) or "")
                                                      for k in origin_keys):
                fields.append("originPin")
            if previous_body.get("status") == "READY" and "notifiedPrice" not in fields:
                fields.append("notifiedPrice")
            if fields:
                self.outbox.add_intake_step(s.call_id, seq, pid, "START_EDIT", {"clearFields": fields})
            self.outbox.add_intake_step(s.call_id, seq, pid, "SAVE", body)
            changed = True
        return changed

    def _ready(self, parcel: dict) -> bool:
        required = ("name", "phoneNumber", "roadAddress", "jibunAddress", "dongName", "postalCode")
        phone = self.policy.phone
        return (all(all(parcel.get(side, {}).get(k) for k in required) for side in ("origin", "destination"))
                and phone.mobile.accepts(parcel["origin"]["phoneNumber"])
                and phone.accepts_recipient(parcel["destination"]["phoneNumber"])
                and all(len(parcel[side]["postalCode"]) == 5 for side in ("origin", "destination"))
                and 1 <= parcel.get("itemPrice", 0) <= 100_000_000 and any(parcel.get(k) for k in COUNTS))

    def current_target(self, s) -> dict | None:
        current = s.state.current
        if current is None or current.empty():
            return None
        current.client_parcel_id = current.client_parcel_id or str(uuid4())
        return {"client_parcel_id": current.client_parcel_id, "receiver_name": current["receiver_name"].value,
                "status": "EDITING"}

    def cancel(self, s, target: dict) -> int | None:
        draft_seq = target.get("draft_seq")
        pid = target.get("client_parcel_id")
        payload = {}
        if draft_seq is not None:
            pid = self.local_id(s, draft_seq) or f"draft:{draft_seq}"
            payload = {"draftSeq": draft_seq, "version": target["version"]}
        step = None
        if payload or any(row["parcel_id"] == pid for row in self.outbox.intake_steps(s.call_id)):
            step = self.outbox.add_intake_step(s.call_id, s.state.customer.call_session_seq, pid, "CANCEL", payload)
        st = s.state
        st.parcels[:] = [p for p in st.parcels if p.draft.client_parcel_id != pid]
        if st.current and st.current.client_parcel_id == pid:
            st.current, st.editing = None, None
        st.bump()
        return step

    def confirmed_status(self, s, parcel_id: str) -> str:
        parcel = next((p for p in s.state.parcels if p.parcel_id == parcel_id), None)
        if (parcel is None or s.state.editing == parcel_id or parcel.draft.item_issues
                or s.state.unassigned_item_issues or is_pending_reconfirm(parcel)):
            return "not_ready"
        for step in reversed(self.outbox.intake_steps(s.call_id)):
            if step["parcel_id"] and step["parcel_id"] == parcel.draft.client_parcel_id:
                if step["action"] == "SAVE" and step["payload"]["status"] == "READY":
                    return "ready" if step["result"] and step["result"].get("status") == "READY" else "pending"
                break
        return "not_ready"

    def step_result(self, s, step_id: int) -> dict | None:
        return next(step["result"] for step in self.outbox.intake_steps(s.call_id) if step["id"] == step_id)

    def local_id(self, s, draft_seq: int) -> str | None:
        return next((step["parcel_id"] for step in reversed(self.outbox.intake_steps(s.call_id))
                     if step["result"] and step["result"].get("draftSeq") == draft_seq), None)

    async def finish(self, s) -> None:
        st = s.state
        if not st.intent and not st.parcels and st.current is None and not self.outbox.intake_steps(s.call_id):
            return
        uncertain_registration = (st.customer.status == "UNREGISTERED"
                                  and s.tools.ops.get("register", {}).get("status") == "unknown")
        if s.caller and (not st.customer.call_session_seq or uncertain_registration):
            from app.calls.service import _apply_context
            call = {"providerCallId": s.call_id, "incomingAt": s.incoming_at}
            try:
                ctx = await self.backend.read("caller_context_intake", self.backend.api.caller_context, s.caller, call, 0)
            except BackendFailure as e:
                s.note("접수 종료", e.code)
            else:
                async with s.lock:
                    _apply_context(st, ctx, s.caller)
        async with s.lock:
            seq = st.customer.call_session_seq
            if not seq:
                return
            if s.rt and s.rt.customer_turns:
                turn = s.rt.customer_turns[-1]
                hold_unclassified_items(st, self.policy.parcel_items, turn.utterance_id, turn.text)
            payment = st.payment.value if st.payment.valid else assess(st, self.policy).payment_auto
            self.sync(s, payment_available=bool(payment))
            payload = {"paymentMethodType": payment, "pickupRequestedAt": st.pickup_at.value if st.pickup_at.valid else None}
            self.outbox.add_intake_step(s.call_id, seq, None, "COMPLETE", payload)
        result = await self.flush(s.call_id)
        s.tools.ops["intake"] = result
        order = result.get("order")
        if order:
            s.result = order | {"orderSeq": result["orderSeq"]}
            st.result_accepted = order.get("status") in ACCEPTED_STATUSES
        s.note("접수 종료", result.get("status", "SAVE_PENDING"))

    async def recover(self) -> None:
        for sid in await asyncio.to_thread(self.outbox.unfinished_intakes):
            await self.flush(sid)

    async def flush(self, sid: str) -> dict:
        lock = self.locks.setdefault(sid, asyncio.Lock())
        async with lock:
            drafts = {}
            version = 0
            for step in await asyncio.to_thread(self.outbox.intake_steps, sid):
                pid, action = step["parcel_id"], step["action"]
                try:
                    if action == "COMPLETE":
                        ready = sum(row["status"] == "READY" for row in drafts.values())
                        data = step["result"] or await self._complete(step, version, ready)
                        if data["status"] in ("FINALIZED", "NO_ORDER"):
                            await asyncio.to_thread(self.outbox.intake_result, step["id"], data)
                        return data | {"ready_count": ready,
                                       "cancelled_count": sum(row["status"] == "CANCELLED" for row in drafts.values())}
                    if action == "CANCEL" and pid not in drafts and not step["payload"]:
                        if step["result"] is None:
                            await asyncio.to_thread(self.outbox.intake_result, step["id"], {"discarded": True})
                        continue
                    data = step["result"] or await self._write(step, drafts.get(pid))
                    if data.get("resume_rejected"):
                        if step["result"] is None:
                            await asyncio.to_thread(self.outbox.intake_result, step["id"], data)
                        continue
                    version = max(version, data["intakeVersion"])
                    if (data["callSessionSeq"] != step["call_seq"] or not isinstance(data["draftSeq"], int)
                            or not isinstance(data["version"], int)):
                        raise ValueError("invalid parcel draft response")
                    if step["result"] is None:
                        await asyncio.to_thread(self.outbox.intake_result, step["id"], data)
                    drafts[pid] = data
                except (BackendFailure, KeyError, TypeError, ValueError) as e:
                    code = e.error_code or e.code if isinstance(e, BackendFailure) else "BE_CONTRACT_VIOLATION"
                    log.warning("배송 초안 전송 보류 session=%s step=%s code=%s", sid, step["id"], code)
                    return {"status": "SAVE_PENDING", "error": code,
                            "ready_count": sum(row["status"] == "READY" for row in drafts.values()),
                            "cancelled_count": sum(row["status"] == "CANCELLED" for row in drafts.values())}
        return {}

    async def _write(self, step: dict, prior: dict | None) -> dict:
        api, seq = self.backend.api, step["call_seq"]
        action, payload = step["action"], step["payload"]
        if action == "RESUME" or (action == "SAVE" and prior is None):
            body = {"clientParcelId": step["parcel_id"]} | payload
            try:
                return await self.backend.write("draft_create", api.create_draft, seq, body)
            except BackendFailure as e:
                if action != "RESUME" or e.kind not in ("not_found", "state") or e.error_code == "IDEMPOTENCY_KEY_REUSED":
                    raise
                try:
                    source = await self.backend.read("draft_detail", api.draft_detail, seq, payload["sourceDraftSeq"])
                except BackendFailure as source_error:
                    if source_error.kind != "not_found":
                        raise
                else:
                    if source["status"] == "INCOMPLETE":
                        raise e
                return {"resume_rejected": True}  # 원본 소실·다른 통화에서 재개. 새 접수는 계속할 수 있다.
        if action == "CANCEL":
            target = prior["draftSeq"] if prior else payload["draftSeq"]
            body = {"action": action, "expectedVersion": prior["version"] if prior else payload["version"]}
        else:
            target = prior["draftSeq"]
            body = {"action": action, "expectedVersion": prior["version"]} | payload
        if step["request"] is not None:
            body = step["request"]
            fresh = await self.backend.read("draft_detail", api.draft_detail, seq, target)
            if _applied(fresh, body):
                return fresh
            if fresh["version"] != body["expectedVersion"]:
                raise BackendFailure("state", "BE_INVALID_STATE", error_code="VERSION_CONFLICT")
        else:
            await asyncio.to_thread(self.outbox.intake_request, step["id"], body)
        return await self.backend.write("draft_patch", api.patch_draft, seq, target, body)

    async def _complete(self, step: dict, version: int, ready: int) -> dict:
        api, seq = self.backend.api, step["call_seq"]
        body = step["request"]
        if body is None:
            if ready and not step["payload"]["paymentMethodType"]:
                raise BackendFailure("state", "PAYMENT_UNKNOWN")
            if not version:
                current = await self.backend.read("intake_detail", api.intake_detail, seq)
                version = current["intakeVersion"]
            body = {"expectedIntakeVersion": version}
            if ready:
                body |= {k: v for k, v in step["payload"].items() if v is not None}
            await asyncio.to_thread(self.outbox.intake_request, step["id"], body)
        else:
            current = await self.backend.read("intake_detail", api.intake_detail, seq)
            if current["status"] in ("FINALIZED", "NO_ORDER", "FINALIZING", "WAITING_PBX"):
                return current
        return await self.backend.write("intake_complete", api.complete_intake, seq, body)


def _cleared_fields(previous: dict, current: dict) -> list[str]:
    fields = [key for key in ("itemPrice", "notifiedPrice", "clientComment")
              if key in previous and key not in current]
    for side in ("origin", "destination"):
        if set(previous.get(side, {})) - set(current.get(side, {})):
            fields.append(side)
    if any(key in previous and key not in current for key in COUNTS):
        fields.append("items")
    return fields
