// 03 주문 내역 Model — 주문 목록 · 주문 추가 · 수정. React를 모르는 데이터 층
// 목록 GET /admin/orders · 추가 POST /admin/orders · 수정 PATCH /orders/{id} — 모두 실서버 (연동 상세명세 4장, 11/01)
// 11/04 디자인: 고른 날짜에서 시작하는 무한 스크롤 — 하루씩 받음 (shared/lib/useDayFeed가 아래 두 함수로)
import { api, type ApiItem } from '@/shared/api/client'
import { buildCreateOrder } from './orderCreate'
import type { CustomerPatch, OrderPatch } from './orderPatch'
import type { OrderDetail, Party, PaymentMethod } from '@/shared/order/orderApi'
import type { OrderGroup } from '@/shared/order/labels'

export type { OrderDetail, Party, PaymentMethod } from '@/shared/order/orderApi'

/** 실제 주문 상태 8개 (연동 상세명세 4.1 · 서버 11/03 재시도 중 실패 추가). notPaid는 소문자 그대로 */
export type OrderStatus =
  | 'COLLECTING' // 미완료 (AI 통화로 모으다 끊김, 저장된 것만 목록에 나옴)
  | 'notPaid' // 결제 대기
  | 'PAID' // 결제 완료
  | 'SUBMITTING' // 디버 접수 중
  | 'SUBMITTING_FAILED' // 디버 접수 실패 — 서버가 자동으로 다시 시도하는 중
  | 'ACCEPTED' // 디버 접수 완료 — '접수 완료'는 이것만
  | 'SUBMISSION_FAILED' // 디버 접수 최종 실패 (상세에서 [다시 접수])
  | 'CANCELLED' // 주문 취소

/** '주문 상태' 고르기 = 서버 statusGroup (11/01): 결제 완료 = PAID · SUBMITTING · ACCEPTED, 접수 실패 = SUBMITTING_FAILED · SUBMISSION_FAILED */
export type StatusGroup = 'ALL' | OrderGroup

/** 품목 4종 (와이어프레임 03 · 디버 FAQ '박스 크기') — 주문 상세의 items 키와 같은 순서. 그 밖은 '기타 품목' 글로 */
export const BOX_TYPES = [
  { key: 'document', label: '서류' },
  { key: 'small', label: '소박스' },
  { key: 'medium', label: '중박스' },
  { key: 'big', label: '대박스' },
] as const
export type BoxKey = (typeof BOX_TYPES)[number]['key']

/** OrderListParty — 수집 중이면 칸마다 null일 수 있음 */
export interface ListParty {
  name: string | null
  phoneNumber: string | null // 숫자만, 앞 0 보존
  roadAddress: string | null
  jibunAddress: string | null
  detailAddress: string | null
}

/** OrderListParcel — 배송 상세 하나 = 보내는 분 1 + 받는 분 1 (화면 한 줄, 11/01 결정) */
export interface ListParcel {
  orderParcelSeq: number
  status: 'ACTIVE' | 'CANCELLED' // 상세 취소 여부 (결제 · 접수 완료와 무관)
  origin: ListParty
  destination: ListParty
  documentCount: number
  smallBoxCount: number
  mediumBoxCount: number
  bigBoxCount: number
  otherItemDescription: string // 없으면 ''
}

/** AdminOrderListItem — 주문 하나. 금액 · 결제 수단 · 좌표는 목록에 없음(상세에서) */
export interface OrderListItem {
  orderSeq: number
  status: OrderStatus
  createdAt: string // 주문 생성 시각 (화면 '접수 시각')
  pickupRequestedAt: string | null
  parcels: ListParcel[] // 상세 순번대로, 취소된 상세도 포함
}

export const orderQueries = {
  all: () => ['orders'] as const, // shared/order의 상세와 같은 뿌리 → 수정 · 추가 후 invalidate 한 번에 목록 · 상세 모두 갱신
}

// ---------- 주문 추가 · 수정 ----------
/** 주문 추가(수기 접수) 본문 */
/** 주소 검색으로 고른 주소의 나머지 칸 — 서버 주소는 지번 · 동 이름 · 우편번호 · 좌표가 필수 (명세 4.4) */
export interface PickedAddress {
  jibunAddress: string
  dongName: string
  postalCode: string // 5자리 문자열 (앞 0 보존)
}

/** 창에서 보내는 사람 — 주소를 새로 골랐으면 picked가 있음 */
export type PartyInput = Party & { picked?: PickedAddress }

export interface OrderInput {
  sender: PartyInput
  receiver: PartyInput
  items: OrderDetail['items']
  declaredValue: number | null // 물품 가액 원 (11/01 필수)
  shippingFee?: number | null // 배송비 — 접수 중단 주문을 수정해 접수할 때만 (추가는 createOrder 인자로)
  pickupAt: string | null // ISO 8601 (선택)
  paymentMethod: PaymentMethod | null // null = 미정 그대로 (수정에서 안 고름)
  request: string | null // 고객 요청 사항 (선택)
}

/** 주문 추가(수기 접수) — POST /admin/orders (연동 상세명세 4.4). 본문은 buildCreateOrder
 * 멱등키: 한 번의 접수 의도에 UUID 하나, 재시도에도 같은 키 → 같은 키 재요청은 새 주문을 만들지 않고 처음 결과를 돌려줌
 * 201이어도 결제 대기 · 접수 실패일 수 있음, 202는 처리 중 → 목록 태그로 보임 */
export const createOrder = (
  input: OrderInput,
  shippingFee: number,
  idempotencyKey: string,
): Promise<ApiItem<{ orderSeq: number; status: OrderStatus }>> =>
  api.post('/admin/orders', { body: buildCreateOrder(input, shippingFee), idempotencyKey })

/** 주문 수정 — PATCH /orders/{id} (연동 상세명세 4.3). 본문은 buildOrderPatch(바뀐 칸만 + expectedVersion)
 * 성공 200 { data: { version } } → 화면은 상세를 다시 받음. 버전이 낡았으면 409 VERSION_CONFLICT (자동 덮어쓰기 금지) */
export const saveOrder = (
  orderSeq: number,
  patch: OrderPatch,
): Promise<ApiItem<{ version: number }>> => api.patch(`/orders/${orderSeq}`, { body: patch })

/** 고객정보에도 저장 — PATCH /customers/{customerSeq}, 204 본문 없음. 주문 PATCH가 성공한 뒤에만 (별도 트랜잭션) */
export const patchCustomer = (customerSeq: number, body: CustomerPatch): Promise<void> =>
  api.patch(`/customers/${customerSeq}`, { body })

/** 주문 전체 취소 — POST /orders/{id}/cancel, 본문 없음 · 204. 결제 전(COLLECTING · notPaid)만 (명세 4.5) */
export const cancelOrder = (orderSeq: number): Promise<void> =>
  api.post(`/orders/${orderSeq}/cancel`)

/** 디버 재접수 — POST /admin/orders/{id}/retry, 본문 없음. 다시 결제하지 않음. 응답 status로 결과 확인
 * 주의(백엔드): 디버 접수는 됐는데 DB 저장만 실패했을 수 있음 → 확인 창에서 디버 쪽을 먼저 확인하라고 안내 */
export const retryOrder = (orderSeq: number): Promise<ApiItem<{ status: OrderStatus }>> =>
  api.post(`/admin/orders/${orderSeq}/retry`)

/** 접수 중단 주문 최종 접수 — POST /orders/{id}/submit { expectedVersion }. 200 = 결과(ACCEPTED만 접수 완료), 202 = 처리 중
 * expectedVersion은 직전 PATCH 응답의 version (프론트에서 +1 하지 않음) */
export const submitOrder = (
  orderSeq: number,
  expectedVersion: number,
): Promise<ApiItem<{ status: OrderStatus }>> =>
  api.post(`/orders/${orderSeq}/submit`, { body: { expectedVersion } })
