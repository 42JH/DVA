"""백엔드 서버 API 클라이언트(spec/backend-api.md). 고객·주문·배송지는 AI 서버가 저장하지 않고 백엔드에서 읽고 쓴다.
HTTP는 openai에 딸린 httpx2. 전화번호는 URL에 넣지 않고 본문으로 보낸다(접근 로그에 개인정보가 남지 않게).

AI가 부르는 것은 둘: 통화 시작의 고객 확인(POST /api/customers/context)과 통화 결과 한 번(POST /api/orders).
조회·수정·취소(/internal/ai/...)는 새 백엔드에 AI용 API가 없어 도구 사용을 보류했다(코드는 둔다)."""

import asyncio
import logging
import time
from dataclasses import dataclass, field
from urllib.parse import quote

import httpx2

from app.order import COUNT_FIELDS, ORDER_FIELDS, Geo, Order, Place

log = logging.getLogger(__name__)

PREFIX = "/internal/ai"  # 보류한 조회·수정·취소 도구용(옛 계약)
# 결과가 불확실해 같은 키로 다시 확인할 응답: 처리 중(202), 게이트웨이 시간 초과(504), 같은 키 처리 중(409)
RETRY_STATUS = (202, 504)
IN_PROGRESS = "REQUEST_IN_PROGRESS"


class BackendError(Exception):
    """예상하지 못한 응답(5xx, 형식 오류 등). 도구·판별 쪽에서 오류 결과로 바꾼다."""


@dataclass
class CallerContext:
    status: str = "UNREGISTERED"  # REGISTERED · UNREGISTERED · WITHDRAWN
    customer_seq: int | None = None
    name: str | None = None
    places: list[Place] = field(default_factory=list)  # 개인·기업 주소록(출발지·도착지 모두에 쓴다)
    usage_types: list[str] = field(default_factory=list)  # PERSONAL · COMPANY


def _pin_place(data: dict) -> Place | None:
    """주소록 addressData → 배송지. 주소 9개 항목이 다 있으면 좌표 등도 그대로 쓴다(다시 찾지 않게)."""
    if not (data.get("name") and data.get("phoneNumber") and data.get("roadAddress")):
        return None
    geo = None
    if all(data.get(k) not in (None, "") for k in ("jibunAddress", "dongName", "postalCode", "latitude", "longitude")):
        geo = Geo(jibun_address=data["jibunAddress"], dong_name=data["dongName"], postal_code=data["postalCode"],
                  latitude=data["latitude"], longitude=data["longitude"])
    return Place(name=data["name"], phone=data["phoneNumber"], address=data["roadAddress"],
                 address_detail=data.get("detailAddress") or "", geo=geo)


def _address(order: Order, role: str) -> dict:
    """주문의 보내는 곳·받는 곳 → 백엔드 주소. 모르는 값은 넣지 않는다(미완료 결과는 아는 것만)."""
    out = {"name": getattr(order, f"{role}_name"), "phoneNumber": getattr(order, f"{role}_phone"),
           "roadAddress": getattr(order, f"{role}_address"), "detailAddress": getattr(order, f"{role}_address_detail")}
    if geo := getattr(order, f"{role}_geo"):
        out |= {"jibunAddress": geo.jibun_address, "dongName": geo.dong_name, "postalCode": geo.postal_code,
                "latitude": geo.latitude, "longitude": geo.longitude}
    return {k: v for k, v in out.items() if v is not None}


def _camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(w.title() for w in rest)


def parcel_body(order: Order) -> dict:
    out = {"origin": _address(order, "sender"), "destination": _address(order, "receiver")}
    out |= {_camel(f): getattr(order, f) for f in COUNT_FIELDS if getattr(order, f) is not None}
    if order.other_item is not None:
        out["otherItemDescription"] = order.other_item
    if order.client_comment is not None:
        out["clientComment"] = order.client_comment
    if order.item_price is not None:
        out["itemPrice"] = order.item_price
    return {k: v for k, v in out.items() if v != {}}


def result_body(outcome: str, call: dict, customer_seq: int | None, customer_name: str | None, caller: str,
                payment: str | None, pickup_at: str | None, parcels: list[Order]) -> dict:
    """통화 결과 본문. call = {providerCallId, callerPhoneNumber, incomingAt}. 고객은 번호(등록) 또는 이름·발신번호(미등록)."""
    body: dict = {"outcome": outcome, "call": call}
    if customer_seq is not None:
        body["customerSeq"] = customer_seq
    elif customer_name:
        body["customer"] = {"name": customer_name, "phoneNumber": caller}
    if payment:
        body["paymentMethodType"] = payment
    if pickup_at:
        body["pickupRequestedAt"] = pickup_at
    if parcels:
        body["parcels"] = [parcel_body(p) for p in parcels]
    return body


class BackendAPI:
    def __init__(self, base_url: str, timeout_sec: float, transport: httpx2.AsyncBaseTransport | None = None,
                 submit_timeout_sec: float = 15.0, submit_retry_sec: float = 40.0, retry_interval_sec: float = 2.0):
        self.http = httpx2.AsyncClient(base_url=base_url, timeout=timeout_sec, transport=transport)
        self.submit_timeout_sec = submit_timeout_sec
        self.submit_retry_sec = submit_retry_sec
        self.retry_interval_sec = retry_interval_sec

    async def close(self) -> None:
        await self.http.aclose()

    async def _post(self, path: str, body: dict, ok=(200, 201), headers: dict | None = None) -> httpx2.Response:
        resp = await self.http.post(PREFIX + path, json=body, headers=headers)
        if resp.status_code not in ok:
            raise BackendError(f"{path} {resp.status_code}")
        return resp

    async def caller_context(self, phone: str) -> CallerContext:
        """통화 시작(accept 전)에 한 번. 등록·미등록·탈퇴와 주소록을 받는다. 고객·통화를 만들지 않는다."""
        resp = await self.http.post("/api/customers/context", json={"phoneNumber": phone})
        if resp.status_code != 200:
            raise BackendError(f"/api/customers/context {resp.status_code}")
        data = resp.json()["data"]
        customer = data.get("customer") or {}
        places = []
        for pin in [*(data.get("personalPins") or []), *(data.get("companyPins") or [])]:
            if (p := _pin_place(pin.get("addressData") or {})) and p not in places:
                places.append(p)
        return CallerContext(status=data["lookupStatus"], customer_seq=customer.get("customerSeq"),
                             name=customer.get("name"), places=places,
                             usage_types=list(data.get("availableUsageTypes") or []))

    async def submit_result(self, body: dict, idempotency_key: str) -> dict:
        """통화 결과 한 번. 결과가 불확실하면(연결 실패·504·202·409 처리 중) 같은 키·같은 본문으로 다시 확인한다.
        같은 키는 백엔드가 본문을 다시 적용하지 않고 기존 결과를 돌려준다. 돌려주는 것은 응답의 data
        (status가 ACCEPTED일 때만 접수 성공). 시간 안에 확정되지 않으면 마지막 data(SUBMITTING) 또는 BackendError."""
        deadline = time.monotonic() + self.submit_retry_sec
        last: dict | None = None
        while True:
            try:
                resp = await self.http.post("/api/orders", json=body, headers={"Idempotency-Key": idempotency_key},
                                            timeout=self.submit_timeout_sec)
            except httpx2.TransportError as e:
                log.warning("결과 전송 연결 실패, 다시 확인: %s", type(e).__name__)
            else:
                data = _data(resp)
                if resp.status_code == 201:
                    return data
                code = _error_code(resp)
                if resp.status_code not in RETRY_STATUS and not (resp.status_code == 409 and code == IN_PROGRESS):
                    raise BackendError(f"/api/orders {resp.status_code} {code}")
                last = data or last
                log.info("결과 처리 중(%s), 같은 키로 다시 확인", resp.status_code)
            if time.monotonic() + self.retry_interval_sec > deadline:
                if last:
                    return last
                raise BackendError("/api/orders 결과 확인 시간 초과")
            await asyncio.sleep(self.retry_interval_sec)

    # --- 보류: 조회·수정·취소 도구(옛 계약, 새 백엔드에 AI용 API 없음) ---

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

    async def recent_orders(self, limit: int) -> list[dict]:
        """관제 화면용 접수 주문 목록(옛 계약). shortcut: 새 백엔드는 관리자 세션이 필요해 실제 백엔드에서는 실패한다."""
        resp = await self.http.get(PREFIX + "/orders", params={"limit": limit})
        if resp.status_code != 200:
            raise BackendError(f"/orders {resp.status_code}")
        return resp.json()["orders"]


def _data(resp: httpx2.Response) -> dict | None:
    try:
        return resp.json().get("data")
    except ValueError:
        return None


def _error_code(resp: httpx2.Response) -> str | None:
    try:
        return (resp.json().get("error") or {}).get("code")
    except ValueError:
        return None
