import { http, HttpResponse } from 'msw'
import { API_BASE_URL } from '@/shared/api/client'
import { allOrders, type OrderDetail } from '@/shared/order/orderApi'
import type { OrderDetailDto, OrderStatusDto, PaymentMethodDto } from '@/shared/order/orderDto'

// 가짜 주문 상세 — API-? GET /orders/{id} (연동 상세명세 10/31 §4.2) 모양 그대로
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
const address = (p: OrderDetail['sender']) => ({
  name: p.name || null,
  phoneNumber: p.phoneNumber || null,
  roadAddress: p.roadAddress || null,
  jibunAddress: null,
  detailAddress: p.detailAddress,
  dongName: null,
  postalCode: null,
  latitude: null,
  longitude: null,
})

/** 화면 주문 → 서버 DTO (상세 parcel 하나짜리) */
function toDto(o: OrderDetail): OrderDetailDto {
  return {
    orderSeq: o.orderSeq,
    customerSeq: null,
    status: o.cancelled ? 'CANCELLED' : STATUS[o.paymentState],
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

export const orderHandlers = [
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
