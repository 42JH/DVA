// 주문 상세 API 응답 (Swagger `GET /api/orders/{id}` → OrderDetailDto, 10/31 받음) 과 화면 데이터(OrderDetail) 사이의 변환
// React를 모르는 순수 함수 (실행해서 확인: orderDto.test.ts). 실제 연결 때 fetchOrder가 api.get 결과를 toOrderDetail로 넘기면 됨
// 화면은 주문 하나 = 보내는 분 · 받는 분 한 쌍으로 그림 → 상세(parcel) 여러 건이면 첫 상세의 주소, 품목 · 가액은 취소 안 된 상세 합계
import type { OrderDetail, Party, PaymentMethod, PaymentState } from './orderApi'

/** 주문 상태 (서버). COLLECTING 수집 중 · notPaid 결제 대기 · PAID 결제 완료 · SUBMITTING 디버 접수 중
 * · SUBMITTING_FAILED 디버 접수 실패(자동 재시도 중, 11/03) · ACCEPTED 디버 접수 완료 · SUBMISSION_FAILED 디버 접수 최종 실패 · CANCELLED 취소 */
export type OrderStatusDto =
  | 'COLLECTING'
  | 'notPaid'
  | 'PAID'
  | 'SUBMITTING'
  | 'SUBMITTING_FAILED'
  | 'ACCEPTED'
  | 'SUBMISSION_FAILED'
  | 'CANCELLED'

/** 결제 방식 (서버). cat = 예전 지점 방문 결제(조회만) */
export type PaymentMethodDto = 'cat' | 'billing' | 'credit' | 'groupBilling'

export interface OrderAddressDto {
  name: string | null
  phoneNumber: string | null // 숫자만
  roadAddress: string | null
  jibunAddress: string | null
  detailAddress: string | null
  dongName: string | null
  postalCode: string | null
}

export interface OrderParcelDto {
  status: 'ACTIVE' | 'CANCELLED'
  orderParcelSeq: number
  orderSeq: number
  parcelPosition: number
  origin: OrderAddressDto
  destination: OrderAddressDto
  originPin: { scope: 'PERSONAL' | 'COMPANY'; pinSeq: number } | null
  documentCount: number
  smallBoxCount: number
  mediumBoxCount: number
  bigBoxCount: number
  otherItemDescription: string // 없으면 ''
  clientComment: string // 없으면 ''
  notifiedPrice: number | null // 배송비
  itemPrice: number | null // 물품 가액
}

export interface OrderDetailDto {
  orderSeq: number
  customerSeq: number | null
  status: OrderStatusDto
  paymentMethodType: PaymentMethodDto
  creationSource: 'AI' | 'ADMIN' | 'UNKNOWN'
  pickupRequestedAt: string | null
  createdAt: string
  paymentDueAt: string | null
  paidAt: string | null
  totalAmount: number | null
  billingOrganizationSeq: number | null
  billingOrganizationName: string | null
  billingDepartmentSeq: number | null
  billingDepartmentName: string | null
  paymentRequest: {
    notificationStatus: 'PENDING' | 'SENDING' | 'SENT' | 'FAILED' | 'UNKNOWN'
    paymentRequestId: string
    amount: number
    expiresAt: string
  } | null
  version: number // 다음 수정의 expectedVersion
  parcelNo: string | null
  dverReceivedAt: string | null
  updatedAt: string
  parcels: OrderParcelDto[]
}

const PAYMENT_METHOD: Record<PaymentMethodDto, PaymentMethod> = {
  credit: 'MONTHLY',
  groupBilling: 'GROUP_CARD',
  billing: 'PERSONAL_CARD',
  cat: 'BRANCH_VISIT',
}

// 화면 '결제' 칸: 결제 뒤 단계(디버 접수 중 · 완료 · 실패)는 모두 '결제 완료'. 취소는 결제 전에만 가능(Swagger: 결제 완료 후 취소 거절)
const PAYMENT_STATE: Record<OrderStatusDto, PaymentState> = {
  COLLECTING: 'UNPAID',
  notPaid: 'UNPAID',
  PAID: 'PAID',
  SUBMITTING: 'PAID',
  SUBMITTING_FAILED: 'PAID',
  ACCEPTED: 'PAID',
  SUBMISSION_FAILED: 'PAID',
  CANCELLED: 'CANCELLED_BEFORE_PAYMENT',
}

const party = (a: OrderAddressDto | undefined): Party => ({
  name: a?.name ?? '',
  phoneNumber: a?.phoneNumber ?? '',
  roadAddress: a?.roadAddress ?? a?.jibunAddress ?? '', // 도로명이 없으면 지번
  detailAddress: a?.detailAddress || null,
  jibunAddress: a?.jibunAddress ?? undefined,
  dongName: a?.dongName ?? undefined,
  postalCode: a?.postalCode ?? undefined,
})

const sum = (xs: (number | null)[]) =>
  xs.some((x) => x !== null) ? xs.reduce<number>((t, x) => t + (x ?? 0), 0) : null

/** 서버 주문 상세 → 화면 주문 상세 */
export function toOrderDetail(dto: OrderDetailDto): OrderDetail {
  const live = dto.parcels.filter((p) => p.status === 'ACTIVE')
  const counted = live.length ? live : dto.parcels // 전부 취소된 주문도 무엇을 보내려 했는지는 보여 줌
  const first = counted[0]
  const others = counted.map((p) => p.otherItemDescription.trim()).filter(Boolean)
  const comments = [...new Set(counted.map((p) => p.clientComment.trim()).filter(Boolean))]
  return {
    orderSeq: dto.orderSeq,
    route: dto.creationSource === 'ADMIN' ? 'MANUAL' : 'PHONE', // UNKNOWN(예전 출처 미확인)은 전화로 봄
    manualBy: null, // shortcut: 응답에 수기 접수 관리자가 없음 — BE에 요청 (backend-todo 3)
    acceptedAt: dto.createdAt,
    cancelled: dto.status === 'CANCELLED',
    sender: party(first?.origin),
    receiver: party(first?.destination),
    items: {
      document: counted.reduce((t, p) => t + p.documentCount, 0),
      small: counted.reduce((t, p) => t + p.smallBoxCount, 0),
      medium: counted.reduce((t, p) => t + p.mediumBoxCount, 0),
      big: counted.reduce((t, p) => t + p.bigBoxCount, 0),
      other: others.length ? others.join(', ') : null,
    },
    pickupRequestedAt: dto.pickupRequestedAt,
    itemPrice: sum(counted.map((p) => p.itemPrice)),
    clientComment: comments.length ? comments.join(' / ') : null,
    paymentMethod: PAYMENT_METHOD[dto.paymentMethodType],
    paymentState: PAYMENT_STATE[dto.status],
    relatedCalls: [], // shortcut: 응답에 관련 통화가 없음 — 통화 API(calls)에서 orderSeq로 찾거나 BE에 요청
    version: dto.version,
    customerSeq: dto.customerSeq,
    status: dto.status,
    parcels: dto.parcels.map((p) => ({
      orderParcelSeq: p.orderParcelSeq,
      cancelled: p.status === 'CANCELLED',
      sender: party(p.origin),
      receiver: party(p.destination),
      items: {
        document: p.documentCount,
        small: p.smallBoxCount,
        medium: p.mediumBoxCount,
        big: p.bigBoxCount,
        other: p.otherItemDescription.trim() || null,
      },
      itemPrice: p.itemPrice,
      clientComment: p.clientComment.trim() || null,
      notifiedPrice: p.notifiedPrice,
    })),
    notifiedPrice: first?.notifiedPrice ?? null,
  }
}
