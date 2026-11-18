"""메모리 가짜 백엔드. app.backend_api.BackendAPI와 같은 메서드. 테스트와 환경변수 BACKEND_MOCK=true에서 쓴다.
백엔드의 주요 검증만 흉내 낸다: 통화당 주문 한 건, 같은 키는 기존 결과, COMPLETE 필수값(배송비·합계 포함),
결제 방식별 상태(billing → notPaid, 후불 → 디버 접수), 통화 고객 범위의 조회·상세 취소(COLLECTING·notPaid만).
shortcut: 프로세스 메모리라 재시작·재배포하면 사라진다. 실제 백엔드를 쓰려면 BACKEND_MOCK을 비우거나 false."""

import itertools
import unicodedata

from app.backend_api import BackendError, CallerContext, CompanyDirectoryPage
from app.order import CompanyPlace, Place

ADDRESS_REQUIRED = ("name", "phoneNumber", "roadAddress", "jibunAddress", "dongName", "postalCode", "latitude",
                    "longitude")
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
        self.results: list[dict] = []  # 받은 통화 결과(본문 + 결과)
        self.keys: dict[str, dict] = {}  # Idempotency-Key → 결과 data
        self.calls: set[str] = set()  # 주문이 연결된 providerCallId
        self.dver_status = "ACCEPTED"  # 후불 주문의 디버 접수 결과 흉내(테스트에서 바꾼다)
        self._seq = itertools.count(1)
        self.personas: dict[str, dict] = {}  # "ACTIVE"·"PENDING" → 백엔드 응답 data 모양
        self.faqs: dict[int, dict] | None = None  # 명시적으로 설정한 테스트 원문만 조회한다.
        # 주문(최근 것이 뒤): {orderSeq, phone, status, parcels: [{orderParcelSeq, status, destination: {name, roadAddress}}]}
        self.orders: list[dict] = []
        self.insights_enabled = True
        self.events: dict[int, dict[int, dict]] = {}  # callSessionSeq → eventOrder → 이벤트
        self.analyses: dict[int, dict] = {}  # callSessionSeq → 분석

    async def close(self) -> None:
        pass

    async def search_company_places(self, query, limit=20, offset=0):
        if not query.strip() or not 1 <= limit <= 100 or offset < 0:
            raise BackendError("기업 배송지 검색 인수 오류")
        terms = unicodedata.normalize("NFC", query).casefold().split()
        matches = []
        for place in self.company_places:
            text = " ".join((place.label(), place.phone, place.geo.jibun_address if place.geo else "",
                             place.geo.dong_name if place.geo else "", place.geo.postal_code if place.geo else ""))
            if all(term in unicodedata.normalize("NFC", text).casefold() for term in terms):
                matches.append(place)
        return CompanyDirectoryPage(matches[offset:offset + limit], offset + limit < len(matches), len(matches))

    async def faq_entries(self, ids):
        from app.rag.faq_source import parse_faq_lookup, validate_faq_ids

        requested = validate_faq_ids(ids)
        if self.faqs is None:
            # 가짜 원문을 준비하지 않은 상태를 전체 삭제로 해석하지 않는다.
            raise BackendError('FAQ_MOCK_NOT_CONFIGURED')
        rows = [self.faqs[value] for value in requested if value in self.faqs]
        return parse_faq_lookup({'data': rows, 'hasNext': False, 'total_count': len(rows)}, list(requested))

    # --- 페르소나: ACTIVE·PENDING 하나씩, 회신 검증만 흉내 낸다 ---

    async def persona_config(self, status):
        found = self.personas.get(status)
        return dict(found) if found else None

    async def persona_result(self, body):
        personas = self.personas
        pending = personas.get("PENDING")
        active = personas.get("ACTIVE")
        if active and active["applicationId"] == body["applicationId"] and body["result"] == "APPLIED":
            return dict(active)  # 같은 성공 회신은 반복 가능
        if not pending or pending["applicationId"] != body["applicationId"]                 or pending["aiPersonaVersionSeq"] != body["aiPersonaVersionSeq"]:
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
                raise BackendError("/events 409 EVENT_PAYLOAD_CONFLICT")
        saved.update({e["eventOrder"]: e for e in body["events"]})

    async def send_call_analysis(self, call_session_seq, body):
        if self.analyses.setdefault(call_session_seq, body) != body:
            raise BackendError("/analysis 409 EVENT_PAYLOAD_CONFLICT")

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
            session = next((s for s, p in self.call_sessions.items() if p == phone), None) or next(self._seq)
            self.call_sessions[session] = phone
        c = self.customers.get(phone)
        if c is None:
            return CallerContext(call_session_seq=session)
        if c["status"] == "WITHDRAWN":
            return CallerContext(status="WITHDRAWN", call_session_seq=session)
        origin, destination = self.recent.get(phone, (None, None))
        return CallerContext(status="REGISTERED", customer_seq=c["seq"], name=c["name"],
                             default_origin=c.get("default_origin").model_copy(update={"name": c["name"], "phone": phone})
                             if c.get("default_origin") else None,
                             places=list(self.pins.get(phone, [])), usage_types=self.usage_types.get(phone, []),
                             call_session_seq=session, payment_methods=self.payment_methods.get(phone, []),
                             recent_origin=origin if session else None,
                             recent_destinations=[destination] if session and destination else [])

    async def create_customer(self, name, phone):
        if phone in self.customers:
            return None  # 409 DUPLICATE_RESOURCE
        return self.add_customer(phone, name)

    async def create_pin(self, call_session_seq, customer_seq, order, role, label):
        phone = self._phone(call_session_seq)
        if self.customers.get(phone, {}).get("seq") != customer_seq:
            raise BackendError("/api/customers/pins 403 FORBIDDEN")  # 통화 고객의 주소록만
        place = order.place(role)
        if place and place not in self.pins[phone]:
            self.pins[phone].append(place)

    # --- 통화 중 조회·취소(통화 고객 범위) ---

    def _phone(self, call_session_seq):
        if call_session_seq not in self.call_sessions:
            raise BackendError("/api/orders 400 INVALID_REQUEST")  # 통화 번호 없음·잘못됨
        return self.call_sessions[call_session_seq]

    def _order(self, call_session_seq, order_seq):
        phone = self._phone(call_session_seq)
        return next((o for o in self.orders if o["orderSeq"] == order_seq and o["phone"] == phone), None)

    @staticmethod
    def _parcels(order):
        return [{"order_seq": order["orderSeq"], "order_parcel_seq": p["orderParcelSeq"],
                 "receiver_name": p["destination"]["name"], "receiver_address": p["destination"]["roadAddress"],
                 "status": "CANCELLED" if p["status"] == "CANCELLED" else order["status"]} for p in order["parcels"]]

    async def find_parcels(self, call_session_seq, limit):
        phone = self._phone(call_session_seq)
        mine = [o for o in reversed(self.orders) if o["phone"] == phone][:limit]
        return [p for o in mine for p in self._parcels(o)]

    async def parcel(self, call_session_seq, order_seq, order_parcel_seq):
        order = self._order(call_session_seq, order_seq)
        return next((p for p in self._parcels(order) if p["order_parcel_seq"] == order_parcel_seq), None) \
            if order else None

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

    # --- 통화 결과 ---

    async def submit_result(self, body: dict, idempotency_key: str) -> dict:
        if idempotency_key in self.keys:
            return self.keys[idempotency_key]  # 같은 키: 본문을 다시 적용하지 않는다
        call = body["call"]
        if call["providerCallId"] in self.calls:
            raise BackendError("/api/orders 409 INVALID_STATE")  # 통화 한 건에 주문 한 건
        if body["outcome"] == "COMPLETE":
            _check_complete(body)
            if body["paymentMethodType"] not in self._allowed(call["callerPhoneNumber"], body):
                raise BackendError("/api/orders 403 FORBIDDEN")  # 결제 방식 사용 자격 없음
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
        raise BackendError("/api/orders 400 INVALID_REQUEST")
    missing = [k for k in ("paymentMethodType", "pickupRequestedAt") if not body.get(k)]
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
        raise BackendError(f"/api/orders 422 VALIDATION_FAILED {missing}")
