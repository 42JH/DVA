"""백엔드 서버 API 클라이언트(spec/backend-api.md). 고객·주문·배송지는 AI 서버가 저장하지 않고 백엔드에서 읽고 쓴다.
HTTP는 openai에 딸린 httpx2. 전화번호는 URL에 넣지 않고 본문으로 보낸다(접근 로그에 개인정보가 남지 않게).

AI가 부르는 것: 통화 시작의 고객 확인(POST /api/customers/context, 통화 번호 callSessionSeq를 받는다)과 최근 접수 주소,
통화 중 조회·취소(GET /api/orders, GET /api/orders/{id}, POST /api/orders/{id}/parcels/cancel), 통화 결과 한 번(POST /api/orders).
통화 번호는 주문 조회·취소·주소 이력 요청의 call_session_seq 헤더로 보낸다(인증 토큰이 아니라 고객 범위 확인용).
통화가 끝나면 통화 기록·분석(POST /api/ai/calls/{id}/events·analysis)을 보낸다.
FAQ 변경 알림 처리에서는 최신 원문(GET /api/ai/faqs)을 별도로 조회한다.
보류한 수정 도구와 관제 화면 주문 목록만 옛 계약(/internal/ai/...)이다."""

import asyncio
import logging
import time
from dataclasses import dataclass, field
from urllib.parse import quote

import httpx2

from app.order import COUNT_FIELDS, ORDER_FIELDS, Geo, Order, Place
from app.rag.faq_source import FaqLookup, parse_faq_lookup, parse_initial_faqs, validate_faq_ids

log = logging.getLogger(__name__)

PREFIX = "/internal/ai"  # 보류한 수정 도구·관제 화면 주문 목록용(옛 계약)
# 결과가 불확실해 같은 키로 다시 확인할 응답: 처리 중(202), 게이트웨이 시간 초과(504), 같은 키 처리 중(409)
RETRY_STATUS = (202, 504)
IN_PROGRESS = "REQUEST_IN_PROGRESS"
INSIGHTS_ATTEMPTS = 3  # 통화 기록 전송 시도 횟수(연결 실패·5xx)


class BackendError(Exception):
    """예상하지 못한 응답(5xx, 형식 오류 등). 도구·판별 쪽에서 오류 결과로 바꾼다."""


@dataclass
class CallerContext:
    status: str = "UNREGISTERED"  # REGISTERED · UNREGISTERED · WITHDRAWN
    customer_seq: int | None = None
    name: str | None = None
    default_origin: Place | None = None  # 현재 고객 기본주소. 개인 PIN·주문 이력과 독립
    places: list[Place] = field(default_factory=list)  # 개인·기업 주소록(출발지·도착지 모두에 쓴다)
    usage_types: list[str] = field(default_factory=list)  # PERSONAL · COMPANY
    call_session_seq: int | None = None  # DB 통화 번호. 주문 조회·취소·주소 이력 요청의 call_session_seq 헤더
    payment_methods: list[str] = field(default_factory=list)  # 지금 쓸 수 있는 billing · credit · groupBilling
    # 이전 접수(ACCEPTED)의 출발지 1건·도착지 최근 것부터({기존 출발지}, "이번에도 {도착지 주소}로", 최근 핀)
    recent_origin: Place | None = None
    recent_destinations: list[Place] = field(default_factory=list)


def _pin_place(data: dict) -> Place | None:
    """주소록 addressData → 배송지. 주소 9개 항목이 다 있으면 좌표 등도 그대로 쓴다(다시 찾지 않게)."""
    if not (data.get("name") and data.get("phoneNumber") and data.get("roadAddress")):
        return None
    geo = None
    if all(data.get(k) not in (None, "") for k in ("jibunAddress", "dongName", "postalCode", "latitude", "longitude")):
        lat, lon = data["latitude"], data["longitude"]
        if lat != 1 and lon != 1 and -90 <= lat <= 90 and -180 <= lon <= 180:
            geo = Geo(jibun_address=data["jibunAddress"], dong_name=data["dongName"], postal_code=data["postalCode"],
                      latitude=lat, longitude=lon)
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


def parcel_body(order: Order, fare: int | None = None) -> dict:
    """택배 하나. fare = 이 택배의 배송비(notifiedPrice, 서버 요금표). 모르면 넣지 않는다."""
    out = {"origin": _address(order, "sender"), "destination": _address(order, "receiver")}
    out |= {_camel(f): getattr(order, f) for f in COUNT_FIELDS if getattr(order, f) is not None}
    if order.other_item is not None:
        out["otherItemDescription"] = order.other_item
    if order.client_comment is not None:
        out["clientComment"] = order.client_comment
    if order.item_price is not None:
        out["itemPrice"] = order.item_price
    if fare is not None:
        out["notifiedPrice"] = fare
    return {k: v for k, v in out.items() if v != {}}


def result_body(outcome: str, call: dict, customer_seq: int | None, customer_name: str | None, caller: str,
                payment: str | None, pickup_at: str | None, parcels: list[Order],
                fares: list[int | None] | None = None) -> dict:
    """통화 결과 본문. call = {providerCallId, callerPhoneNumber, incomingAt}. 고객은 번호(등록) 또는 이름·발신번호(미등록).
    fares = 택배별 배송비. 다 알 때만 totalAmount(합계)를 넣는다(백엔드가 합계와 상세 배송비가 같은지 검사한다)."""
    body: dict = {"outcome": outcome, "call": call}
    if customer_seq is not None:
        body["customerSeq"] = customer_seq
    elif customer_name:
        body["customer"] = {"name": customer_name, "phoneNumber": caller}
    if payment:
        body["paymentMethodType"] = payment
    if pickup_at:
        body["pickupRequestedAt"] = pickup_at
    fares = fares or [None] * len(parcels)
    if parcels:
        body["parcels"] = [parcel_body(p, f) for p, f in zip(parcels, fares)]
    if parcels and all(f is not None for f in fares):
        body["totalAmount"] = sum(fares)
    return body


def _parcels(detail: dict) -> list[dict]:
    """주문 상세 → 조회·취소(C 흐름)가 쓰는 택배 단위. status는 취소한 상세면 CANCELLED, 아니면 주문 상태."""
    out = []
    for p in detail.get("parcels") or []:
        dest = p.get("destination") or {}
        out.append({"order_seq": detail["orderSeq"], "order_parcel_seq": p["orderParcelSeq"],
                    "receiver_name": dest.get("name"), "receiver_address": dest.get("roadAddress"),
                    "status": "CANCELLED" if p.get("status") == "CANCELLED" else detail.get("status")})
    return out


def _call(call_session_seq: int) -> dict:
    return {"call_session_seq": str(int(call_session_seq))}


class BackendAPI:
    def __init__(self, base_url: str, timeout_sec: float, transport: httpx2.AsyncBaseTransport | None = None,
                 submit_timeout_sec: float = 15.0, submit_retry_sec: float = 40.0, retry_interval_sec: float = 2.0,
                 persona_token: str | None = None, insights_token: str | None = None):
        self.http = httpx2.AsyncClient(base_url=base_url, timeout=timeout_sec, transport=transport)
        self.persona_token = persona_token  # 페르소나 API 전용 서비스 토큰(주문·고객 API에는 보내지 않는다)
        self.insights_token = insights_token  # 통화 기록·분석 API 전용 서비스 토큰(spec/insights.md)
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

    async def caller_context(self, phone: str, call: dict | None = None, recent_limit: int = 5) -> CallerContext:
        """통화 시작(accept 전)에 한 번. 등록·미등록·탈퇴, 주소록, 결제 자격을 받는다. call = {providerCallId, incomingAt}을
        보내면 백엔드가 통화를 만들거나 다시 쓰고 통화 번호(callSessionSeq)를 준다. 고객·주문은 만들지 않는다.
        등록 고객이면 이전 접수의 출발지 1건·도착지 recent_limit건도 읽는다(실패해도 고객 확인은 그대로)."""
        body = {"phoneNumber": phone} | ({"call": call} if call else {})
        resp = await self.http.post("/api/customers/context", json=body)
        if resp.status_code != 200:
            raise BackendError(f"/api/customers/context {resp.status_code} {_error_code(resp)}")
        data = resp.json()["data"]
        customer = data.get("customer") or {}
        places = []
        for pin in [*(data.get("personalPins") or []), *(data.get("companyPins") or [])]:
            if (p := _pin_place(pin.get("addressData") or {})) and p not in places:
                places.append(p)
        ctx = CallerContext(status=data["lookupStatus"], customer_seq=customer.get("customerSeq"),
                            name=customer.get("name"), places=places,
                            default_origin=_pin_place({**(customer.get("address") or {}),
                                                       "name": customer.get("name"), "phoneNumber": phone}),
                            usage_types=list(data.get("availableUsageTypes") or []),
                            call_session_seq=data.get("callSessionSeq"),
                            payment_methods=list(data.get("availablePaymentMethods") or []))
        if ctx.status == "REGISTERED" and ctx.customer_seq and ctx.call_session_seq and recent_limit:
            try:
                origins = await self.address_history(ctx.call_session_seq, ctx.customer_seq, "ORIGIN", 1)
                ctx.recent_origin = origins[0] if origins else None
                ctx.recent_destinations = await self.address_history(ctx.call_session_seq, ctx.customer_seq,
                                                                     "DESTINATION", recent_limit)
            except (BackendError, httpx2.TransportError) as e:
                log.warning("이전 접수 주소 조회 실패: %s", e)  # 최근 접수 없이 진행(출발지 없이 인사)
        return ctx

    async def create_customer(self, name: str, phone: str) -> int | None:
        """신규 고객 등록(POST /api/customers, ACTIVE). 고객 번호. 이미 등록된 번호면(409) None."""
        resp = await self.http.post("/api/customers", json={"name": name, "phoneNumber": phone})
        if resp.status_code == 409:
            return None
        if resp.status_code != 201:
            raise BackendError(f"/api/customers {resp.status_code} {_error_code(resp)}")
        return _data(resp)["customerSeq"]

    async def create_pin(self, call_session_seq: int, customer_seq: int, order: Order, role: str, label: str) -> None:
        """주문의 보내는 곳(role=sender)·받는 곳을 그 고객의 개인 주소록에 저장한다. 같은 주소가 이미 있으면(409) 그대로."""
        resp = await self.http.post(f"/api/customers/{int(customer_seq)}/pins",
                                    json={"label": label, "addressData": _address(order, role)},
                                    headers=_call(call_session_seq))
        if resp.status_code not in (200, 201, 409):
            raise BackendError(f"/api/customers/pins {resp.status_code} {_error_code(resp)}")

    async def address_history(self, call_session_seq: int, customer_seq: int, direction: str, limit: int) -> list[Place]:
        """이전 접수(ACCEPTED) 주문의 출발지(ORIGIN)·도착지(DESTINATION) 스냅샷, 최근 것부터. 같은 곳은 한 번만."""
        resp = await self.http.get(f"/api/customers/{int(customer_seq)}/addresses",
                                   params={"direction": direction, "limit": limit}, headers=_call(call_session_seq))
        if resp.status_code != 200:
            raise BackendError(f"/api/customers/addresses {resp.status_code} {_error_code(resp)}")
        out: list[Place] = []
        for row in resp.json().get("data") or []:
            if (p := _pin_place(row.get("address") or {})) and p not in out:
                out.append(p)
        return out

    # --- 통화 중 조회·취소(C 흐름). 통화 고객의 주문만(call_session_seq 헤더) ---

    async def find_parcels(self, call_session_seq: int, limit: int) -> list[dict]:
        """통화 고객의 최근 주문 limit건을 택배(주문 상세) 단위로, 최근 것부터. 목록에는 받는 분이 없어 주문마다 상세를 읽는다.
        받는 분 성함으로 거르는 것은 부르는 쪽(Call.find_orders)이 한다: 이름을 URL(recipientName)에 넣지 않게."""
        resp = await self.http.get("/api/orders", params={"limit": limit}, headers=_call(call_session_seq))
        if resp.status_code != 200:
            raise BackendError(f"/api/orders {resp.status_code} {_error_code(resp)}")
        orders = resp.json().get("data") or []
        details = await asyncio.gather(*(self.order_detail(call_session_seq, o["orderSeq"]) for o in orders))
        return [p for d in details if d for p in _parcels(d)]

    async def order_detail(self, call_session_seq: int, order_seq: int) -> dict | None:
        """주문 상세(상태·금액·결제 요청·상세 목록). 없거나 다른 고객의 주문이면 None."""
        resp = await self.http.get(f"/api/orders/{int(order_seq)}", headers=_call(call_session_seq))
        if resp.status_code == 404:
            return None
        if resp.status_code != 200:
            raise BackendError(f"/api/orders/{{id}} {resp.status_code} {_error_code(resp)}")
        return _data(resp)

    async def parcel(self, call_session_seq: int, order_seq: int, order_parcel_seq: int) -> dict | None:
        """택배 하나의 지금 상태(취소 전 확인·취소 뒤 확인)."""
        detail = await self.order_detail(call_session_seq, order_seq)
        return next((p for p in _parcels(detail or {}) if p["order_parcel_seq"] == order_parcel_seq), None)

    async def cancel_parcels(self, call_session_seq: int, order_seq: int, order_parcel_seqs: list[int]) -> str:
        """주문 상세 취소. 'ok'(204, 같은 상세를 다시 취소해도 204) · 'not_found'(404) · 'conflict'(409: 결제 완료·처리 중 등,
        지금 상태는 다시 조회해서 본다)."""
        resp = await self.http.post(f"/api/orders/{int(order_seq)}/parcels/cancel",
                                    json={"orderParcelSeqs": [int(s) for s in order_parcel_seqs]},
                                    headers=_call(call_session_seq))
        result = {204: "ok", 404: "not_found", 409: "conflict"}.get(resp.status_code)
        if result is None:
            raise BackendError(f"/api/orders/{{id}}/parcels/cancel {resp.status_code} {_error_code(resp)}")
        return result

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
                if resp.status_code in (200, 201):  # 같은 키의 재요청은 기존 주문의 현재 결과(200)
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

    # --- FAQ 최신 원문(spec/faq-sync.md) ---

    async def initial_faq_entries(self):
        request = httpx2.Request('GET', self.http.base_url.join('/api/ai/faqs'),
            params={'limit':100, 'offset':0}, headers={'Accept':'application/json'})
        try:
            response = await self.http.send(request, auth=None, follow_redirects=False)
        except httpx2.TransportError:
            raise BackendError('FAQ_FETCH_FAILED') from None
        if response.status_code != 200:
            raise BackendError(f'FAQ_HTTP_ERROR:{response.status_code}')
        try:
            return parse_initial_faqs(response.json())
        except (ValueError, TypeError):
            raise BackendError('FAQ_INITIAL_INVALID_OR_INCOMPLETE') from None

    async def faq_entries(self, ids: list[int]) -> FaqLookup:
        requested = validate_faq_ids(ids)
        # 별도 Request를 만들어 고객/관리자 쿠키·페르소나 토큰·통화 헤더를 상속하지 않는다.
        request = httpx2.Request('GET', self.http.base_url.join('/api/ai/faqs'),
            params={'faqEntrySeqs': ','.join(map(str, requested)), 'limit': 100, 'offset': 0},
            headers={'Accept': 'application/json'})
        try:
            response = await self.http.send(request, auth=None, follow_redirects=False)
        except httpx2.TransportError:
            raise BackendError('FAQ_FETCH_FAILED') from None
        if response.status_code != 200:
            raise BackendError(f'FAQ_HTTP_ERROR:{response.status_code}')
        try:
            return parse_faq_lookup(response.json(), list(requested))
        except (ValueError, TypeError):
            # 파싱 예외에는 원문이 들어갈 수 있어 외부에 연결하지 않는다.
            raise BackendError('FAQ_INVALID_RESPONSE') from None

    # --- 페르소나(spec/persona.md, 계약 spec/ai-persona-next-call.md) ---

    def _persona_headers(self) -> dict:
        return {"Authorization": f"Bearer {self.persona_token}"}

    async def persona_config(self, status: str) -> dict | None:
        """서비스 전체의 ACTIVE 또는 PENDING 한 버전. 없으면 None."""
        resp = await self.http.get("/api/ai/config", params={"status": status}, headers=self._persona_headers())
        if resp.status_code == 404:
            return None
        if resp.status_code != 200:
            raise BackendError(f"/api/ai/config {resp.status_code} {_error_code(resp)}")
        return _data(resp)

    async def persona_result(self, body: dict) -> dict | None:
        """적용 결과 회신. 응답 data(status로 실제 적용 여부 확인). 409(교체됨·통화 중)는 None."""
        try:
            resp = await self.http.post("/api/ai/config/apply-result", json=body, headers=self._persona_headers())
        except httpx2.TransportError as e:
            raise BackendError(f"/api/ai/config/apply-result {type(e).__name__}") from e
        if resp.status_code == 409:
            return None
        if resp.status_code != 200:
            raise BackendError(f"/api/ai/config/apply-result {resp.status_code} {_error_code(resp)}")
        return _data(resp)

    # --- 통화 기록·분석(spec/insights.md) ---

    @property
    def insights_enabled(self) -> bool:
        return bool(self.insights_token)

    async def _insights(self, path: str, body: dict) -> None:
        """204면 성공(같은 내용 재전송도 204). 연결 실패·5xx는 같은 본문으로 몇 번 다시, 그 밖(400·403·404·409 등)은 실패."""
        headers = {"Authorization": f"Bearer {self.insights_token}"}
        for attempt in range(INSIGHTS_ATTEMPTS):
            try:
                resp = await self.http.post(path, json=body, headers=headers)
            except httpx2.TransportError as e:
                error = f"{path} {type(e).__name__}"
            else:
                if resp.status_code == 204:
                    return
                error = f"{path} {resp.status_code} {_error_code(resp)}"
                if resp.status_code < 500:
                    raise BackendError(error)
            if attempt + 1 < INSIGHTS_ATTEMPTS:
                await asyncio.sleep(self.retry_interval_sec)
        raise BackendError(error)

    async def send_call_events(self, call_session_seq: int, body: dict) -> None:
        await self._insights(f"/api/ai/calls/{int(call_session_seq)}/events", body)

    async def send_call_analysis(self, call_session_seq: int, body: dict) -> None:
        await self._insights(f"/api/ai/calls/{int(call_session_seq)}/analysis", body)

    # --- 보류한 수정 도구(옛 계약). shortcut: 새 백엔드의 수정은 COLLECTING 주문의 PATCH뿐이라 쓰지 못한다(수정 보류) ---

    async def update_order(self, caller: str, order_no: str, values: dict[str, str]) -> str:
        """'ok' · 'not_found'(주문번호·발신번호 불일치) · 'cancelled'(취소된 주문)."""
        changes = {k: v for k, v in values.items() if k in ORDER_FIELDS}
        # order_no는 모델이 만든 미신뢰 값: 경로 조각으로 인코딩(../ 등으로 다른 API를 부르지 못하게)
        resp = await self._post(f"/orders/{quote(order_no, safe='')}/update", {"caller_phone": caller, "changes": changes},
                                ok=(200, 404, 409))
        return {200: "ok", 404: "not_found", 409: "cancelled"}[resp.status_code]

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
