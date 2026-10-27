"""메모리 가짜 백엔드. app.backend_api.BackendAPI와 같은 메서드, 발신번호 기준으로만 보이고 고친다.
테스트와, 백엔드 DB 연동 전 배포(config/server.toml [backend] mock = true)에서 쓴다.
shortcut: 프로세스 메모리라 재시작·재배포하면 주문·배송지가 사라진다. 백엔드 API가 준비되면 mock = false."""

import itertools

from app.backend_api import CallerContext
from app.order import ORDER_FIELDS, Order, Place


class MockBackend:
    def __init__(self):
        self.orders: list[dict] = []
        self.places: dict[str, list[tuple[str, Place]]] = {}  # 소유자 → [(종류, 배송지)]
        self.keys: dict[str, str] = {}  # Idempotency-Key → 접수번호
        self._seq = itertools.count(1)

    async def close(self) -> None:
        pass

    def places_of(self, owner, kind):
        return [p for k, p in self.places.get(owner, []) if k == kind]

    async def caller_context(self, phone):
        recent = next((o for o in reversed(self.orders) if o["caller_phone"] == phone and o["status"] == "received"),
                      None)
        return CallerContext(
            recent=Order(**{f: recent[f] for f in ORDER_FIELDS}) if recent else None,
            places={kind: self.places_of(phone, kind) for kind in ("origin", "destination")})

    async def create_order(self, caller, session_id, order: Order, fare, idempotency_key):
        if idempotency_key in self.keys:
            return self.keys[idempotency_key]
        no = f"Q{next(self._seq):06d}"
        self.orders.append({"order_no": no, "caller_phone": caller, "session_id": session_id, "fare": fare,
                            "status": "received", **order.model_dump()})
        if idempotency_key:
            self.keys[idempotency_key] = no
        return no

    async def list_orders(self, caller, limit):
        mine = [o for o in reversed(self.orders) if o["caller_phone"] == caller]
        return [{k: o[k] for k in ("order_no", "receiver_name", "item", "status")} for o in mine[:limit]]

    def _status(self, caller, order_no):
        o = next((o for o in self.orders if o["order_no"] == order_no and o["caller_phone"] == caller), None)
        return o["status"] if o else "not_found"

    async def update_order(self, caller, order_no, values):
        if self._status(caller, order_no) != "received":
            return self._status(caller, order_no)
        o = next(o for o in self.orders if o["order_no"] == order_no)
        o.update({k: v for k, v in values.items() if k in ORDER_FIELDS})
        return "ok"

    async def cancel_order(self, caller, order_no):
        if self._status(caller, order_no) != "received":
            return self._status(caller, order_no)
        next(o for o in self.orders if o["order_no"] == order_no)["status"] = "cancelled"
        return "ok"

    async def save_places(self, owner, places):
        mine = self.places.setdefault(owner, [])
        new = [kp for kp in places if kp not in mine]
        mine.extend(new)
        return len(new)

    async def recent_orders(self, limit):
        return list(reversed(self.orders))[:limit]
