"""메모리 가짜 백엔드. app.backend_api.BackendAPI와 같은 메서드. 테스트와 config/server.toml [backend] mock = true에서 쓴다.
새 계약(고객 확인·통화 결과)은 백엔드의 주요 검증(통화당 주문 한 건, 같은 키는 기존 결과, COMPLETE 필수값)만 흉내 낸다.
shortcut: 프로세스 메모리라 재시작·재배포하면 사라진다. 실제 백엔드를 쓰려면 mock = false."""

import itertools

from app.backend_api import BackendError, CallerContext
from app.order import Place

ADDRESS_REQUIRED = ("name", "phoneNumber", "roadAddress", "jibunAddress", "dongName", "postalCode", "latitude",
                    "longitude")


class MockBackend:
    def __init__(self):
        self.customers: dict[str, dict] = {}  # 전화번호 → {seq, name, status}
        self.pins: dict[str, list[Place]] = {}  # 전화번호 → 주소록
        self.usage_types: dict[str, list[str]] = {}
        self.results: list[dict] = []  # 받은 통화 결과(본문 + 결과)
        self.keys: dict[str, dict] = {}  # Idempotency-Key → 결과 data
        self.calls: set[str] = set()  # 주문이 연결된 providerCallId
        self.dver_status = "ACCEPTED"  # 디버 접수 결과 흉내(테스트에서 바꾼다)
        self._seq = itertools.count(1)
        self.personas: dict[str, dict] = {}  # "ACTIVE"·"PENDING" → 백엔드 응답 data 모양
        # 보류한 조회·수정·취소 도구용(옛 계약)
        self.orders: list[dict] = []

    async def close(self) -> None:
        pass

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
        if body["activeCallCount"] != 0:
            return None  # 409 INVALID_STATE
        personas["ACTIVE"] = {**personas.pop("PENDING"), "status": "ACTIVE", "applyErrorCode": None}
        return dict(personas["ACTIVE"])

    def add_customer(self, phone: str, name: str, pins: list[Place] = (), status: str = "ACTIVE",
                     usage_types: list[str] = ("PERSONAL",)) -> int:
        seq = next(self._seq)
        self.customers[phone] = {"seq": seq, "name": name, "status": status}
        self.pins[phone] = list(pins)
        self.usage_types[phone] = list(usage_types)
        return seq

    async def caller_context(self, phone):
        c = self.customers.get(phone)
        if c is None:
            return CallerContext()
        if c["status"] == "WITHDRAWN":
            return CallerContext(status="WITHDRAWN")
        return CallerContext(status="REGISTERED", customer_seq=c["seq"], name=c["name"],
                             places=list(self.pins.get(phone, [])), usage_types=self.usage_types.get(phone, []))

    async def submit_result(self, body: dict, idempotency_key: str) -> dict:
        if idempotency_key in self.keys:
            return self.keys[idempotency_key]  # 같은 키: 본문을 다시 적용하지 않는다
        call_id = body["call"]["providerCallId"]
        if call_id in self.calls:
            raise BackendError("/api/orders 409 INVALID_STATE")  # 통화 한 건에 주문 한 건
        if body["outcome"] == "COMPLETE":
            _check_complete(body)
        status = {"COMPLETE": self.dver_status, "INCOMPLETE": "COLLECTING", "CANCELLED": "CANCELLED"}[body["outcome"]]
        data = {"orderSeq": next(self._seq), "version": 1, "status": status, "callSessionSeq": next(self._seq),
                "parcelNo": "TEST0001" if status == "ACCEPTED" else None}
        self.calls.add(call_id)
        self.keys[idempotency_key] = data
        self.results.append({"body": body, "key": idempotency_key, **data})
        return data

    # --- 보류한 조회·수정·취소 도구(옛 계약) ---

    async def list_orders(self, caller, limit):
        mine = [o for o in reversed(self.orders) if o["caller_phone"] == caller]
        return [{k: o[k] for k in ("order_no", "receiver_name", "status")} for o in mine[:limit]]

    def _status(self, caller, order_no):
        o = next((o for o in self.orders if o["order_no"] == order_no and o["caller_phone"] == caller), None)
        return o["status"] if o else "not_found"

    async def update_order(self, caller, order_no, values):
        if self._status(caller, order_no) != "received":
            return self._status(caller, order_no)
        next(o for o in self.orders if o["order_no"] == order_no).update(values)
        return "ok"

    async def cancel_order(self, caller, order_no):
        if self._status(caller, order_no) != "received":
            return self._status(caller, order_no)
        next(o for o in self.orders if o["order_no"] == order_no)["status"] = "cancelled"
        return "ok"

    async def recent_orders(self, limit):
        return [{"order_no": r["orderSeq"], "status": r["status"], "outcome": r["body"]["outcome"],
                 "parcels": len(r["body"].get("parcels", []))} for r in reversed(self.results)][:limit]


def _check_complete(body: dict) -> None:
    """백엔드 COMPLETE 검증(order-submission.validation.ts)의 주요 부분. 어기면 422처럼 실패."""
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
    if missing:
        raise BackendError(f"/api/orders 422 VALIDATION_FAILED {missing}")
