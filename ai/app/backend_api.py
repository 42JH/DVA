"""백엔드 서버 API 클라이언트(spec/backend-api.md). 고객·주문·배송지는 AI 서버가 저장하지 않고 백엔드에서 읽고 쓴다.
HTTP는 openai에 딸린 httpx2. 전화번호는 URL에 넣지 않고 본문으로 보낸다(접근 로그에 개인정보가 남지 않게)."""

from dataclasses import dataclass, field
from urllib.parse import quote

import httpx2

from app.order import ORDER_FIELDS, Order, Place

PREFIX = "/internal/ai"


class BackendError(Exception):
    """예상하지 못한 응답(5xx, 형식 오류 등). 도구·판별 쪽에서 오류 결과로 바꾼다."""


@dataclass
class CallerContext:
    recent: Order | None = None  # 최근 배송(취소되지 않은 마지막 주문)
    places: dict[str, list[Place]] = field(default_factory=lambda: {"origin": [], "destination": []})


class BackendAPI:
    def __init__(self, base_url: str, timeout_sec: float, transport: httpx2.AsyncBaseTransport | None = None):
        self.http = httpx2.AsyncClient(base_url=base_url, timeout=timeout_sec, transport=transport)

    async def close(self) -> None:
        await self.http.aclose()

    async def _post(self, path: str, body: dict, ok=(200, 201), headers: dict | None = None) -> httpx2.Response:
        resp = await self.http.post(PREFIX + path, json=body, headers=headers)
        if resp.status_code not in ok:
            raise BackendError(f"{path} {resp.status_code}")
        return resp

    async def caller_context(self, phone: str) -> CallerContext:
        """통화 시작(accept 전)에 한 번. 최근 배송과 저장된 배송지를 한꺼번에 받는다."""
        data = (await self._post("/callers/context", {"phone": phone})).json()
        ctx = CallerContext()
        if data.get("recent_order"):
            ctx.recent = Order(**{f: data["recent_order"].get(f) for f in ORDER_FIELDS})
        for p in data.get("places") or []:
            if p.get("kind") in ctx.places:
                ctx.places[p["kind"]].append(Place(**{k: p[k] for k in ("name", "phone", "address", "address_detail")}))
        return ctx

    async def create_order(self, caller: str | None, session_id: str, order: Order, fare: int,
                           idempotency_key: str) -> str:
        """접수. 접수번호는 백엔드가 발급한다. 같은 Idempotency-Key로 다시 오면 같은 접수번호를 돌려줘야 한다."""
        body = {"caller_phone": caller, "session_id": session_id, "fare": fare,
                **{f: getattr(order, f) for f in ORDER_FIELDS}}
        resp = await self._post("/orders", body, headers={"Idempotency-Key": idempotency_key})
        return resp.json()["order_no"]

    async def list_orders(self, caller: str, limit: int) -> list[dict]:
        return (await self._post("/orders/search", {"caller_phone": caller, "limit": limit})).json()["orders"]

    async def _change(self, path: str, body: dict) -> str:
        """'ok' · 'not_found'(주문번호·발신번호 불일치) · 'cancelled'(취소된 주문)."""
        resp = await self._post(path, body, ok=(200, 404, 409))
        return {200: "ok", 404: "not_found", 409: "cancelled"}[resp.status_code]

    async def update_order(self, caller: str, order_no: str, values: dict[str, str]) -> str:
        changes = {k: v for k, v in values.items() if k in ORDER_FIELDS}
        # order_no는 모델이 만든 미신뢰 값: 경로 조각으로 인코딩(../ 등으로 다른 API를 부르지 못하게)
        return await self._change(f"/orders/{quote(order_no, safe='')}/update", {"caller_phone": caller, "changes": changes})

    async def cancel_order(self, caller: str, order_no: str) -> str:
        return await self._change(f"/orders/{quote(order_no, safe='')}/cancel", {"caller_phone": caller})

    async def save_places(self, owner: str, places: list[tuple[str, Place]]) -> int:
        body = {"owner_phone": owner, "places": [{"kind": k, **p.model_dump()} for k, p in places]}
        return (await self._post("/callers/places", body)).json()["saved"]

    async def recent_orders(self, limit: int) -> list[dict]:
        """관제 화면용 접수 주문 목록."""
        resp = await self.http.get(PREFIX + "/orders", params={"limit": limit})
        if resp.status_code != 200:
            raise BackendError(f"/orders {resp.status_code}")
        return resp.json()["orders"]
