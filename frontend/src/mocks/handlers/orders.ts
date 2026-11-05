import { http, HttpResponse } from 'msw'
import { API_BASE_URL } from '@/shared/api/client'
import { allOrders, type OrderDetail } from '@/shared/order/orderApi'
import type {
  OrderAddressDto,
  OrderDetailDto,
  OrderStatusDto,
  PaymentMethodDto,
} from '@/shared/order/orderDto'

// 가짜 주문 상세 GET /orders/{id} (연동 상세명세 10/31 §4.2) · 목록 GET /admin/orders (§4.1) — 모양 그대로
// 데이터는 shared/order/orderApi.ts의 메모리 저장소(03 주문 내역 가짜 목록 · 추가 · 수정이 쓰는 것)를 그대로 읽어 DTO로 바꿈
//   → 03에서 추가한 주문도 06 '주문 보기' 팝업에서 같은 내용으로 보임. 화면 → DTO 변환은 orderDto.toOrderDetail의 반대
const METHOD: Record<OrderDetail['paymentMethod'], PaymentMethodDto> = {
  MONTHLY: 'credit',
  GROUP_CARD: 'groupBilling',
  PERSONAL_CARD: 'billing',
  BRANCH_VISIT: 'cat',
}
const STATUS: Record<OrderDetail['paymentState'], OrderStatusDto> = {
  PAID: 'ACCEPTED',
  UNPAID: 'notPaid',
  CANCELLED_BEFORE_PAYMENT: 'CANCELLED',
}
/** 목록 칩을 다 볼 수 있게 결제 완료 몇 건을 번호로 미완료 · 접수 실패로 섞음 (상세도 같은 상태) */
const statusOf = (o: OrderDetail): OrderStatusDto =>
  o.cancelled
    ? 'CANCELLED'
    : o.paymentState !== 'PAID'
      ? STATUS[o.paymentState]
      : o.orderSeq % 11 === 4
        ? 'COLLECTING'
        : o.orderSeq % 13 === 5
          ? 'SUBMISSION_FAILED'
          : 'ACCEPTED'
const address = (p: OrderDetail['sender']) => ({
  name: p.name || null,
  phoneNumber: p.phoneNumber || null,
  roadAddress: p.roadAddress || null,
  jibunAddress: null,
  detailAddress: p.detailAddress,
  dongName: null,
  postalCode: null,
})

/** 화면 주문 → 서버 DTO (상세 parcel 하나짜리) */
function toDto(o: OrderDetail): OrderDetailDto {
  return {
    orderSeq: o.orderSeq,
    customerSeq: null,
    status: statusOf(o),
    paymentMethodType: METHOD[o.paymentMethod],
    creationSource: o.route === 'MANUAL' ? 'ADMIN' : 'AI',
    pickupRequestedAt: o.pickupRequestedAt ? new Date(o.pickupRequestedAt).toISOString() : null,
    createdAt: new Date(o.acceptedAt).toISOString(),
    paymentDueAt: null,
    paidAt: o.paymentState === 'PAID' ? new Date(o.acceptedAt).toISOString() : null,
    totalAmount: null,
    billingOrganizationSeq: null,
    billingOrganizationName: null,
    billingDepartmentSeq: null,
    billingDepartmentName: null,
    paymentRequest: null,
    version: 1,
    parcelNo: null,
    dverReceivedAt: null,
    updatedAt: new Date(o.acceptedAt).toISOString(),
    parcels: [
      {
        status: o.cancelled ? 'CANCELLED' : 'ACTIVE',
        orderParcelSeq: o.orderSeq * 10 + 1,
        orderSeq: o.orderSeq,
        parcelPosition: 1,
        origin: address(o.sender),
        destination: address(o.receiver),
        originPin: null,
        documentCount: o.items.document,
        smallBoxCount: o.items.small,
        mediumBoxCount: o.items.medium,
        bigBoxCount: o.items.big,
        otherItemDescription: o.items.other ?? '',
        clientComment: o.clientComment ?? '',
        notifiedPrice: null,
        itemPrice: o.itemPrice,
      },
    ],
  }
}

/** 목록 한 건 (AdminOrderListItem) — 상세 하나짜리 */
function toListItem(o: OrderDetail) {
  const { parcels, ...dto } = toDto(o)
  const party = ({
    name,
    phoneNumber,
    roadAddress,
    jibunAddress,
    detailAddress,
  }: OrderAddressDto) => ({
    name,
    phoneNumber,
    roadAddress,
    jibunAddress,
    detailAddress,
  })
  return {
    orderSeq: dto.orderSeq,
    status: dto.status,
    createdAt: dto.createdAt,
    pickupRequestedAt: dto.pickupRequestedAt,
    parcels: parcels.map((p) => ({
      ...p,
      origin: party(p.origin),
      destination: party(p.destination),
    })),
  }
}

// 서버 statusGroup 규칙 (admin-order-list.dto): 결제 완료 = PAID · SUBMITTING · ACCEPTED, 접수 실패 = 재시도 중 실패 · 최종 실패
const GROUP: Record<string, OrderStatusDto[]> = {
  PAID: ['PAID', 'SUBMITTING', 'ACCEPTED'],
  SUBMISSION_FAILED: ['SUBMITTING_FAILED', 'SUBMISSION_FAILED'],
}

export const orderHandlers = [
  // q = 보내는 분 · 받는 분의 이름 · 전화번호 · 주소 부분 검색 · from 포함 · to 미포함 · 접수 최신순
  http.get(`${API_BASE_URL}/admin/orders`, ({ request }) => {
    const u = new URL(request.url).searchParams
    const q = u.get('q')?.toLowerCase()
    const group = u.get('statusGroup')
    const from = u.get('from') ? Date.parse(u.get('from')!) : -Infinity
    const to = u.get('to') ? Date.parse(u.get('to')!) : Infinity
    const limit = Number(u.get('limit') ?? 20)
    const offset = Number(u.get('offset') ?? 0)
    const rows = allOrders()
      .map(toListItem)
      .filter((o) => {
        const at = Date.parse(o.createdAt)
        return (
          at >= from &&
          at < to &&
          (!group || (GROUP[group] ?? [group]).includes(o.status)) &&
          (!q ||
            o.parcels.some((p) =>
              [p.origin, p.destination].some((x) =>
                Object.values(x).some((v) => v?.toLowerCase().includes(q)),
              ),
            ))
        )
      })
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.orderSeq - a.orderSeq)
    return HttpResponse.json({
      data: rows.slice(offset, offset + limit),
      hasNext: offset + limit < rows.length,
      total_count: rows.length,
    })
  }),
  http.get(`${API_BASE_URL}/orders/:id`, ({ params }) => {
    const o = allOrders().find((x) => x.orderSeq === Number(params.id))
    if (!o)
      return HttpResponse.json(
        { error: { code: 'NOT_FOUND', message: '주문이 없습니다.', details: [] } },
        { status: 404 },
      )
    return HttpResponse.json({ data: toDto(o), meta: { requestId: crypto.randomUUID() } })
  }),
]
