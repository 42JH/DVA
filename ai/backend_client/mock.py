"""메모리 가짜 백엔드. backend_client.api.BackendAPI와 같은 메서드. 테스트와 환경변수 BACKEND_MOCK=true에서 쓴다.
백엔드의 주요 검증만 흉내 낸다: 통화당 주문 한 건, 같은 키는 기존 결과, COMPLETE 필수값(배송비·합계 포함),
결제 방식별 상태(billing → notPaid, 후불 → 디버 접수), 통화 고객 범위의 조회·상세 취소(COLLECTING·notPaid만).
BackendAPI의 공개 메서드는 모두 같은 이름으로 둔다(새 API를 붙이면 여기도, backend_client/tests/test_mock.py가 검사).
shortcut: 프로세스 메모리라 재시작·재배포하면 사라진다. 실제 백엔드를 쓰려면 BACKEND_MOCK을 비우거나 false."""

import copy
import itertools
import unicodedata
from datetime import datetime, timezone

from backend_client.api import BackendError, CallerContext, CompanyDirectoryPage, _parcels
from backend_client.order import CompanyPlace, Place

ADDRESS_REQUIRED = ("name", "phoneNumber", "roadAddress", "jibunAddress", "dongName", "postalCode")
REMOVED = ("latitude", "longitude")  # 백엔드 계약에서 제거: 보내면 400 INVALID_REQUEST(address-coordinates-removal.md)


def _no_coordinates(path: str, *addresses: dict) -> None:
    if any(k in (a or {}) for a in addresses for k in REMOVED):
        raise BackendError(f"{path} 400 INVALID_REQUEST", 400, "INVALID_REQUEST")
CANCELLABLE = ("COLLECTING", "notPaid")


class MockBackend:
    def __init__(self):
        self.customers: dict[str, dict] = {}  # 전화번호 → {seq, name, status}
        self.pins: dict[str, list[Place]] = {}  # 전화번호 → 주소록
        self.company_places: list[CompanyPlace] = []  # 백엔드가 활성 조건을 적용한 기업 검색 후보
        self.usage_types: dict[str, list[str]] = {}
        self.payment_methods: dict[str, list[str]] = {}  # 전화번호 → availablePaymentMethods
        self.recent: dict[str, tuple[Place, Place]] = {}  # 전화번호 → 이전 접수(출발지, 도착지)
        self.call_sessions: dict[int, str] = {}  # callSessionSeq → 발신번호
        self.call_numbers: dict[str, int] = {}   # providerCallId → callSessionSeq
        self.results: list[dict] = []  # 받은 통화 결과(본문 + 결과)
        self.keys: dict[str, dict] = {}  # Idempotency-Key → 결과 data
        self.calls: set[str] = set()  # 주문이 연결된 providerCallId
        self.dver_status = "ACCEPTED"  # 후불 주문의 디버 접수 결과 흉내(테스트에서 바꾼다)
        self._seq = itertools.count(1)
        self.personas: dict[str, dict] = {}  # "ACTIVE"·"PENDING" → 백엔드 응답 data 모양
        self.faqs: dict[int, dict] | None = None  # 명시적으로 설정한 테스트 원문만 조회한다.
        self.unanswered: dict[str, dict] = {}  # eventId → {seq, body}
        # 주문(최근 것이 뒤): {orderSeq, phone, status, parcels: [{orderParcelSeq, status, destination: {name, roadAddress}}]}
        self.orders: list[dict] = []
        self.ended: set[int] = set()
        self.drafts: dict[int, dict] = {}
        self.draft_keys: dict[tuple[int, str], tuple[dict, int]] = {}
        self.intakes: dict[int, dict] = {}
        self.insights_enabled = True
        self.events: dict[int, dict[int, dict]] = {}  # callSessionSeq → eventOrder → 이벤트
        self.analyses: dict[int, dict] = {}  # callSessionSeq → 분석
        self.dashboard: dict[tuple[int, str], dict] = {}  # (callSessionSeq, 항목) → 대시보드 최종값

    async def close(self) -> None:
        pass

    def _intake(self, seq):
        return self.intakes.setdefault(seq, {"intakeVersion": 0})

    async def create_draft(self, call_seq, body):
        key = (call_seq, body["clientParcelId"])
        if prior := self.draft_keys.get(key):
            if body != prior[0]:
                raise BackendError("different create body", 409, "IDEMPOTENCY_KEY_REUSED")
            return copy.deepcopy(self.drafts[prior[1]])
        intake = self._intake(call_seq)
        if "complete" in intake:
            raise BackendError("intake sealed", 409, "INVALID_STATE")
        parcel = body.get("parcel", {})
        if source_seq := body.get("sourceDraftSeq"):
            source = await self.draft_detail(call_seq, source_seq)
            if source["status"] != "INCOMPLETE":
                raise BackendError("source already resumed", 409, "INVALID_STATE")
            self.drafts[source_seq]["status"] = "RESUMED"
            parcel = source["parcel"]
        draft_seq = next(self._seq)
        phone = self.call_sessions[call_seq]
        intake["intakeVersion"] += 1
        row = {"draftSeq": draft_seq, "version": 1, "intakeVersion": intake["intakeVersion"],
               "callSessionSeq": call_seq, "callerPhoneNumber": phone, "status": body["status"],
               "parcel": copy.deepcopy(parcel), "createdAt": datetime.now(timezone.utc).isoformat()}
        self.drafts[draft_seq] = row
        self.draft_keys[key] = (copy.deepcopy(body), draft_seq)
        return copy.deepcopy(row)

    async def patch_draft(self, call_seq, draft_seq, body):
        row, intake = self.drafts[draft_seq], self._intake(call_seq)
        if row["callSessionSeq"] != call_seq or "complete" in intake:
            raise BackendError("draft not writable", 409, "INVALID_STATE")
        if body["expectedVersion"] != row["version"]:
            raise BackendError("stale draft", 409, "VERSION_CONFLICT")
        action = body["action"]
        if action == "START_EDIT":
            for field in body["clearFields"]:
                keys = ("documentCount", "smallBoxCount", "mediumBoxCount", "bigBoxCount", "otherItemDescription") \
                    if field == "items" else (field,)
                for key in keys:
                    row["parcel"].pop(key, None)
            row["status"] = "EDITING"
        elif action == "SAVE":
            if row["status"] != "EDITING":
                raise BackendError("draft not editing", 409, "INVALID_STATE")
            row["parcel"].update(copy.deepcopy(body["parcel"]))
            row["status"] = body["status"]
        else:
            row["status"] = "CANCELLED"
        row["version"] += 1
        intake["intakeVersion"] += 1
        row["intakeVersion"] = intake["intakeVersion"]
        return copy.deepcopy(row)

    async def list_drafts(self, call_seq, status, *, same_call=False, limit=100):
        rows = [row for row in reversed(list(self.drafts.values())) if row["status"] == status
                and row["callerPhoneNumber"] == self.call_sessions[call_seq]
                and (not (same_call or call_seq in self.ended) or row["callSessionSeq"] == call_seq)]
        return copy.deepcopy(rows if same_call else rows[:limit])

    async def draft_detail(self, call_seq, draft_seq):
        row = self.drafts.get(draft_seq)
        if not row or row["callerPhoneNumber"] != self.call_sessions[call_seq]:
            raise BackendError("draft not found", 404, "NOT_FOUND")
        return copy.deepcopy(row)

    async def complete_intake(self, call_seq, body):
        intake = self._intake(call_seq)
        if "complete" in intake and intake["complete"] != body:
            raise BackendError("different complete body", 409, "EVENT_PAYLOAD_CONFLICT")
        if body["expectedIntakeVersion"] != intake["intakeVersion"]:
            raise BackendError("stale intake", 409, "VERSION_CONFLICT")
        intake["complete"] = copy.deepcopy(body)
        return await self.intake_detail(call_seq)

    async def intake_detail(self, call_seq):
        intake = self._intake(call_seq)
        data = {"intakeVersion": intake["intakeVersion"]}
        if "complete" not in intake:
            return data | {"status": "WAITING_AI" if call_seq in self.ended else "COLLECTING"}
        if call_seq not in self.ended:
            return data | {"status": "WAITING_PBX"}
        if "result" not in intake:
            rows = [r for r in self.drafts.values() if r["callSessionSeq"] == call_seq]
            ready = [r for r in rows if r["status"] == "READY"]
            for row in rows:
                if row["status"] == "EDITING":
                    row["status"] = "INCOMPLETE"
            result = {"status": "NO_ORDER"}
            if ready:
                status = "notPaid" if intake["complete"]["paymentMethodType"] == "billing" else self.dver_status
                order_seq = next(self._seq)
                parcels = [dict(row["parcel"], orderParcelSeq=next(self._seq), status="ACTIVE") for row in ready]
                order = {"orderSeq": order_seq, "status": status, "phone": self.call_sessions[call_seq], "parcels": parcels}
                self.orders.append(order)
                result = {"status": "FINALIZED", "orderSeq": order_seq, "order": order, "parcelMappings": [
                    {"draftSeq": row["draftSeq"], "orderParcelSeq": p["orderParcelSeq"]} for row, p in zip(ready, parcels)]}
            intake["result"] = result
        return data | copy.deepcopy(intake["result"])

    async def search_company_places(self, query, limit=20, offset=0):
        if not query.strip() or not 1 <= limit <= 100 or offset < 0:
            raise BackendError("기업 배송지 검색 인수 오류", code="ARGUMENT_INVALID")
        terms = unicodedata.normalize("NFC", query).casefold().split()
        matches = []
        for place in self.company_places:
            text = " ".join((place.label(), place.phone, place.geo.jibun_address if place.geo else "",
                             place.geo.dong_name if place.geo else "", place.geo.postal_code if place.geo else ""))
            if all(term in unicodedata.normalize("NFC", text).casefold() for term in terms):
                matches.append(place)
        return CompanyDirectoryPage(matches[offset:offset + limit], offset + limit < len(matches), len(matches))

    # 원본 app/mock_backend.py의 FAQ 메서드 그대로(파싱은 RAG 쪽 app.rag.faq_source)
    async def faq_entries(self, ids):
        from app.rag.faq_source import parse_faq_lookup, validate_faq_ids

        requested = validate_faq_ids(ids)
        if self.faqs is None:
            # 가짜 원문을 준비하지 않은 상태를 전체 삭제로 해석하지 않는다.
            raise BackendError('FAQ_MOCK_NOT_CONFIGURED')
        rows = [self.faqs[value] for value in requested if value in self.faqs]
        return parse_faq_lookup({'data': rows, 'hasNext': False, 'total_count': len(rows)}, list(requested))

    async def initial_faq_entries(self):
        from app.rag.faq_source import parse_initial_faqs

        if self.faqs is None:
            raise BackendError('FAQ_MOCK_NOT_CONFIGURED')
        rows = [self.faqs[key] for key in sorted(self.faqs)]
        return parse_initial_faqs({'data': rows, 'hasNext': False, 'total_count': len(rows)})

    # --- 페르소나: ACTIVE·PENDING 하나씩, 회신 검증만 흉내 낸다 ---

    def use_prompt(self, prompt: str, application_id: str = "mock-prompt") -> None:
        """관리자가 이 지시문을 ACTIVE로 올려 둔 백엔드처럼(음성은 세션 설정의 기본값)."""
        self.personas["ACTIVE"] = {"aiPersonaVersionSeq": 1, "applicationId": application_id, "promptText": prompt,
                                   "voiceId": None, "speakingRate": None, "turnWaitLevel": "NORMAL",
                                   "status": "ACTIVE", "applyErrorCode": None}

    async def persona_config(self, status):
        found = self.personas.get(status)
        return dict(found) if found else None

    async def persona_result(self, body):
        personas = self.personas
        pending = personas.get("PENDING")
        active = personas.get("ACTIVE")
        if active and active["applicationId"] == body["applicationId"] and body["result"] == "APPLIED":
            return dict(active)  # 같은 성공 회신은 반복 가능
        if not pending or pending["applicationId"] != body["applicationId"] \
                or pending["aiPersonaVersionSeq"] != body["aiPersonaVersionSeq"]:
            return None  # 409 VERSION_CONFLICT
        if body["result"] == "FAILED":
            pending["applyErrorCode"] = body["errorCode"]
            return dict(pending)
        personas["ACTIVE"] = {**personas.pop("PENDING"), "status": "ACTIVE", "applyErrorCode": None}
        return dict(personas["ACTIVE"])

    # --- 통화 기록·분석: 같은 순번에 다른 내용이면 409 흉내 ---

    async def send_call_events(self, call_session_seq, body):
        saved = self.events.setdefault(call_session_seq, {})
        for event in body["events"]:
            if saved.get(event["eventOrder"], event) != event:
                raise BackendError("/events 409 EVENT_PAYLOAD_CONFLICT", 409, "EVENT_PAYLOAD_CONFLICT")
        saved.update({e["eventOrder"]: e for e in body["events"]})

    async def send_call_analysis(self, call_session_seq, body):
        for k in ("result", "customerType", "shipmentLookupCount", "endReason", "handoff", "offsetMs"):
            if k in body:  # 최신 규약 §4: 분석 입력이 아님
                raise BackendError(f"/analysis 400 INVALID_REQUEST {k}", 400, "INVALID_REQUEST")
        if self.analyses.setdefault(call_session_seq, body) != body:
            raise BackendError("/analysis 409 EVENT_PAYLOAD_CONFLICT", 409, "EVENT_PAYLOAD_CONFLICT")

    def _dashboard(self, call_session_seq, item: str, body: dict, keys: set[str]) -> None:
        if call_session_seq not in self.analyses:
            raise BackendError(f"/{item} 409 INVALID_STATE", 409, "INVALID_STATE")
        if set(body) != keys:
            raise BackendError(f"/{item} 400 INVALID_REQUEST", 400, "INVALID_REQUEST")
        if self.dashboard.setdefault((call_session_seq, item), body) != body:
            raise BackendError(f"/{item} 409 EVENT_PAYLOAD_CONFLICT", 409, "EVENT_PAYLOAD_CONFLICT")

    async def send_stage_metrics(self, call_session_seq, body):
        self._dashboard(call_session_seq, "stage-metrics", body, {"providerCallId", "dropoffStage"})

    async def send_wait_metrics(self, call_session_seq, body):
        self._dashboard(call_session_seq, "response-wait-metrics", body,
                        {"providerCallId", "totalWaitMs", "latencyStats"})

    async def send_unanswered(self, body):
        found = self.unanswered.setdefault(body["eventId"], {"seq": next(self._seq), "body": body})
        if found["body"] != body:
            raise BackendError("/unanswered 409 EVENT_PAYLOAD_CONFLICT", 409, "EVENT_PAYLOAD_CONFLICT")
        return found["seq"]

    # --- 테스트 준비 ---

    def add_customer(self, phone: str, name: str, pins: list[Place] = (), status: str = "ACTIVE",
                     usage_types: list[str] = ("PERSONAL",), recent: tuple[Place, Place] | None = None,
                     payment_methods: list[str] = ("billing",), default_origin: Place | None = None) -> int:
        seq = next(self._seq)
        self.customers[phone] = {"seq": seq, "name": name, "status": status, "default_origin": default_origin}
        self.pins[phone] = list(pins)
        self.usage_types[phone] = list(usage_types)
        self.payment_methods[phone] = list(payment_methods)
        if recent:
            self.recent[phone] = recent
        return seq

    def add_order(self, phone: str, status: str, receivers: list[tuple[str, str]]) -> int:
        """받는 분(이름, 도로명주소)마다 상세 하나인 주문. 주문 번호를 돌려준다."""
        seq = next(self._seq)
        self.orders.append({"orderSeq": seq, "phone": phone, "status": status, "parcels": [
            {"orderParcelSeq": next(self._seq), "status": "ACTIVE", "destination": {"name": n, "roadAddress": a}}
            for n, a in receivers]})
        return seq

    # --- 고객 확인 ---

    async def caller_context(self, phone, call=None, recent_limit=5):
        session = None
        if call:
            provider_id = call["providerCallId"]
            session = self.call_numbers.get(provider_id)
            if session is None:
                session = self.call_numbers[provider_id] = next(self._seq)
            self.call_sessions[session] = phone
        c = self.customers.get(phone)
        if c is None:
            return CallerContext(call_session_seq=session)
        if c["status"] == "WITHDRAWN":
            return CallerContext(status="WITHDRAWN", call_session_seq=session)
        ctx = CallerContext(status="REGISTERED", customer_seq=c["seq"], name=c["name"],
                            default_origin=c.get("default_origin").model_copy(update={"name": c["name"], "phone": phone})
                            if c.get("default_origin") else None,
                            places=list(self.pins.get(phone, [])), usage_types=self.usage_types.get(phone, []),
                            call_session_seq=session, payment_methods=self.payment_methods.get(phone, []))
        if session and recent_limit:  # 실제 클라이언트처럼 주소 이력 API로 읽는다
            origins = await self.address_history(session, c["seq"], "ORIGIN", 1)
            ctx.recent_origin = origins[0] if origins else None
            ctx.recent_destinations = await self.address_history(session, c["seq"], "DESTINATION", recent_limit)
        return ctx

    async def address_history(self, call_session_seq, customer_seq, direction, limit):
        phone = self._phone(call_session_seq)
        if self.customers.get(phone, {}).get("seq") != customer_seq:
            raise BackendError("/api/customers/addresses 403 FORBIDDEN", 403, "FORBIDDEN")  # 통화 고객의 이력만
        place = self.recent.get(phone, (None, None))[0 if direction == "ORIGIN" else 1]
        return [place][:limit] if place else []

    async def create_customer(self, name, phone, address=None):
        if phone in self.customers:
            return None  # 409 DUPLICATE_RESOURCE
        if address and ("name" in address or "phoneNumber" in address or "latitude" in address):
            raise BackendError("/api/customers 400 INVALID_REQUEST", 400, "INVALID_REQUEST")  # 내 주소에 이름·번호·좌표 없음
        seq = self.add_customer(phone, name)
        self.customers[phone]["address"] = address
        return seq

    async def customer_detail(self, customer_seq):
        """B/customers.md Customer. 없거나 탈퇴면 404 → None."""
        for phone, c in self.customers.items():
            if c["seq"] == customer_seq and c["status"] == "ACTIVE":
                return {"customerSeq": c["seq"], "name": c["name"], "phoneNumber": phone, "status": c["status"],
                        "monthlyBillingEnabled": False, "address": c.get("address")}
        return None

    async def update_customer(self, customer_seq, call_session_seq, fields):
        phone = self._phone(call_session_seq)
        if self.customers.get(phone, {}).get("seq") != customer_seq:
            raise BackendError("/api/customers 403 FORBIDDEN", 403, "FORBIDDEN")  # 진행 중 본인 통화만
        address = fields.get("address") or {}
        if not fields or set(fields) - {"name", "address"} or "name" in address or "phoneNumber" in address \
                or "latitude" in address or ("name" in fields and not str(fields["name"] or "").strip()):
            raise BackendError("/api/customers 400 INVALID_REQUEST", 400, "INVALID_REQUEST")
        if "name" in fields:
            self.customers[phone]["name"] = fields["name"].strip()
        if "address" in fields:
            self.customers[phone]["address"] = dict(address)

    async def create_pin(self, call_session_seq, customer_seq, order, role, label):
        phone = self._phone(call_session_seq)
        if self.customers.get(phone, {}).get("seq") != customer_seq:
            raise BackendError("/api/customers/pins 403 FORBIDDEN", 403, "FORBIDDEN")  # 통화 고객의 주소록만
        place = order.place(role)
        if place and place not in self.pins[phone]:
            self.pins[phone].append(place)

    # --- 통화 중 조회·취소(통화 고객 범위) ---

    def _phone(self, call_session_seq):
        if call_session_seq not in self.call_sessions:
            raise BackendError("/api/orders 400 INVALID_REQUEST", 400, "INVALID_REQUEST")  # 통화 번호 없음·잘못됨
        return self.call_sessions[call_session_seq]

    def _order(self, call_session_seq, order_seq):
        phone = self._phone(call_session_seq)
        return next((o for o in self.orders if o["orderSeq"] == order_seq and o["phone"] == phone), None)

    async def find_parcels(self, call_session_seq, limit):
        phone = self._phone(call_session_seq)
        mine = [o for o in reversed(self.orders) if o["phone"] == phone][:limit]
        return [p for o in mine for p in _parcels(o)]

    async def order_detail(self, call_session_seq, order_seq):
        order = self._order(call_session_seq, order_seq)
        return {k: v for k, v in order.items() if k != "phone"} if order else None

    async def parcel(self, call_session_seq, order_seq, order_parcel_seq):
        detail = await self.order_detail(call_session_seq, order_seq)
        return next((p for p in _parcels(detail or {}) if p["order_parcel_seq"] == order_parcel_seq), None)

    async def cancel_parcels(self, call_session_seq, order_seq, order_parcel_seqs):
        order = self._order(call_session_seq, order_seq)
        targets = [p for p in (order or {}).get("parcels", []) if p["orderParcelSeq"] in order_parcel_seqs]
        if not order or len(targets) != len(set(order_parcel_seqs)):
            return "not_found"
        if order["status"] not in CANCELLABLE:
            return "conflict"  # 결제 완료 이후·이미 전체 취소
        for p in targets:
            p["status"] = "CANCELLED"  # 같은 상세를 다시 취소해도 204
        if all(p["status"] == "CANCELLED" for p in order["parcels"]):
            order["status"] = "CANCELLED"
        return "ok"

    async def cancel_order(self, call_session_seq, order_seq):
        order = self._order(call_session_seq, order_seq)
        if not order:
            return "not_found"
        if order["status"] not in CANCELLABLE:
            return "conflict"  # 결제 완료 이후·전체 재요청
        for p in order["parcels"]:
            p["status"] = "CANCELLED"
        order["status"] = "CANCELLED"
        return "ok"

    def _collecting(self, call_session_seq, order_seq, expected_version, path):
        order = self._order(call_session_seq, order_seq)
        if not order:
            raise BackendError(f"{path} 404 NOT_FOUND", 404, "NOT_FOUND")
        if order["status"] != "COLLECTING":
            raise BackendError(f"{path} 409 INVALID_STATE", 409, "INVALID_STATE")
        if expected_version != order.setdefault("version", 1):
            raise BackendError(f"{path} 409 VERSION_CONFLICT", 409, "VERSION_CONFLICT")
        return order

    async def update_collecting_order(self, call_session_seq, order_seq, body):
        order = self._collecting(call_session_seq, order_seq, body.get("expectedVersion"), "/api/orders/{id}")
        order["version"] += 1  # shortcut: 변경 내용은 반영하지 않고 버전만 올린다(지금 통화 흐름이 부르지 않음)
        return order["version"]

    async def submit_order(self, call_session_seq, order_seq, expected_version):
        order = self._collecting(call_session_seq, order_seq, expected_version, "/api/orders/{id}/submit")
        order["status"] = "notPaid"
        return {"status": "notPaid"}

    def _pin_rows(self, phone):
        return [{"personalPinSeq": i, "customerSeq": self.customers[phone]["seq"], "label": None, "version": 1,
                 "addressData": {"name": p.name, "phoneNumber": p.phone, "roadAddress": p.address,
                                 "detailAddress": p.address_detail}}
                for i, p in enumerate(self.pins.get(phone, []), 1)]

    async def list_pins(self, call_session_seq, customer_seq, q=None, limit=20, offset=0):
        phone = self._phone(call_session_seq)
        if self.customers.get(phone, {}).get("seq") != customer_seq:
            raise BackendError("/api/customers/pins 403 FORBIDDEN", 403, "FORBIDDEN")
        rows = [r for r in self._pin_rows(phone) if not q or q in str(r["addressData"])]
        return {"data": rows[offset:offset + limit], "hasNext": offset + limit < len(rows), "total_count": len(rows)}

    async def update_pin(self, call_session_seq, pin_seq, fields):
        phone = self._phone(call_session_seq)
        if not fields or set(fields) - {"label", "addressData"}:
            raise BackendError("/api/pins/{id} 400 INVALID_REQUEST", 400, "INVALID_REQUEST")
        if not 1 <= pin_seq <= len(self.pins.get(phone, [])):
            raise BackendError("/api/pins/{id} 404 NOT_FOUND", 404, "NOT_FOUND")  # 통화 고객의 PIN만
        return 2  # shortcut: 주소 교체는 반영하지 않는다(지금 통화 흐름이 부르지 않음)

    # --- 통화 결과 ---

    async def submit_result(self, body: dict, idempotency_key: str) -> dict:
        if idempotency_key in self.keys:
            return self.keys[idempotency_key]  # 같은 키: 본문을 다시 적용하지 않는다
        _no_coordinates("/api/orders", *(p.get(side) for p in body.get("parcels", []) for side in ("origin", "destination")))
        call = body["call"]
        if call["providerCallId"] in self.calls:
            raise BackendError("/api/orders 409 INVALID_STATE", 409, "INVALID_STATE")  # 통화 한 건에 주문 한 건
        if body["outcome"] != "COMPLETE" and _no_order_info(body):  # BE NO_ORDER(empty-ai-order-results.md)
            data = {"orderSeq": None, "version": None, "status": "NO_ORDER", "totalAmount": None,
                    "callSessionSeq": next(self._seq), "parcelNo": None, "paymentRequest": None}
            self.calls.add(call["providerCallId"])
            self.keys[idempotency_key] = data
            self.results.append({"body": body, "key": idempotency_key, **data})
            return data
        if body["outcome"] == "COMPLETE":
            _check_complete(body)
            if body["paymentMethodType"] not in self._allowed(call["callerPhoneNumber"], body):
                raise BackendError("/api/orders 403 FORBIDDEN", 403, "FORBIDDEN")  # 결제 방식 사용 자격 없음
            status = "notPaid" if body["paymentMethodType"] == "billing" else self.dver_status
        else:
            status = {"INCOMPLETE": "COLLECTING", "CANCELLED": "CANCELLED"}[body["outcome"]]
        order_seq = self.add_order(call["callerPhoneNumber"], status,
                                   [(p.get("destination", {}).get("name"), p.get("destination", {}).get("roadAddress"))
                                    for p in body.get("parcels", [])])
        data = {"orderSeq": order_seq, "version": 1, "status": status, "totalAmount": body.get("totalAmount"),
                "callSessionSeq": next(self._seq), "parcelNo": "TEST0001" if status == "ACCEPTED" else None,
                "paymentRequest": None}
        if status == "notPaid":
            data["paymentRequest"] = {"paymentRequestId": "mock", "amount": body["totalAmount"]}
        self.calls.add(call["providerCallId"])
        self.keys[idempotency_key] = data
        self.results.append({"body": body, "key": idempotency_key, **data})
        return data

    def _allowed(self, phone: str, body: dict) -> list[str]:
        """신규 고객(이름·전화번호로 등록)은 개인 카드만."""
        return self.payment_methods.get(phone, []) if "customerSeq" in body else ["billing"]

    # --- 보류한 수정 도구·관제 화면(옛 계약) ---

    async def update_order(self, caller, order_no, values):
        return "not_found"  # 수정 보류: 새 계약의 수정(COLLECTING PATCH)은 쓰지 않는다

    async def recent_orders(self, limit):
        return [{"order_no": r["orderSeq"], "status": r["status"], "outcome": r["body"]["outcome"],
                 "parcels": len(r["body"].get("parcels", []))} for r in reversed(self.results)][:limit]


def _check_complete(body: dict) -> None:
    """백엔드 COMPLETE 검증(order-submission.validation.ts·order-pricing.ts)의 주요 부분. 어기면 422처럼 실패."""
    if "customerSeq" not in body and "customer" not in body:
        raise BackendError("/api/orders 400 INVALID_REQUEST", 400, "INVALID_REQUEST")
    missing = [k for k in ("paymentMethodType",) if not body.get(k)]  # 수거 시각은 호환 선택값(BE가 결제 + 1시간)
    if not body.get("parcels"):
        missing.append("parcels")
    for i, p in enumerate(body.get("parcels", [])):
        for side in ("origin", "destination"):
            missing += [f"parcels.{i}.{side}.{k}" for k in ADDRESS_REQUIRED if p.get(side, {}).get(k) in (None, "")]
        counts = [p.get(k, 0) for k in ("documentCount", "smallBoxCount", "mediumBoxCount", "bigBoxCount")]
        if not any(counts) and not p.get("otherItemDescription"):
            missing.append(f"parcels.{i}.items")
        if p.get("itemPrice") is None:
            missing.append(f"parcels.{i}.itemPrice")
        if not isinstance(p.get("notifiedPrice"), int) or p["notifiedPrice"] <= 0:
            missing.append(f"parcels.{i}.notifiedPrice")
    if body.get("totalAmount") != sum(p.get("notifiedPrice") or 0 for p in body.get("parcels", [])):
        missing.append("totalAmount")  # 미취소 상세 배송비의 합계와 같아야 한다
    if missing:
        raise BackendError(f"/api/orders 422 VALIDATION_FAILED {missing}", 422, "VALIDATION_FAILED")


def _no_order_info(body: dict) -> bool:
    """BE NO_ORDER 조건: 결제 방식·수거 시각·합계가 없고, 택배가 없거나 모두 빈 주소·수량 0·빈 설명·가격 없음."""
    if any(body.get(k) is not None for k in ("paymentMethodType", "pickupRequestedAt", "totalAmount")):
        return False
    for p in body.get("parcels") or []:
        addresses = [v for side in ("origin", "destination") for v in (p.get(side) or {}).values() if v not in (None, "")]
        counts = [p.get(k) for k in ("documentCount", "smallBoxCount", "mediumBoxCount", "bigBoxCount") if p.get(k)]
        if addresses or counts or p.get("otherItemDescription") or p.get("itemPrice") is not None:
            return False
    return True
