// 03 주문 내역 Model — 주문 목록 · 주문 추가 · 수정. React를 모르는 데이터 층
// 목록 = 실서버 GET /admin/orders (연동 상세명세 4.1, 11/01). 주문 추가 · 수정은 아직 shared/order 메모리 가짜 (다음 단계)
import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import { api, type ApiList } from '@/shared/api/client'
import { fetchAll, offsetOf } from '@/shared/api/paging'
import { addDays, type Ymd } from '@/shared/lib/dateRange'
import {
  addOrder,
  updateOrder,
  type OrderDetail,
  type Party,
  type PaymentMethod,
} from '@/shared/order/orderApi'

export type { OrderDetail, Party, PaymentMethod } from '@/shared/order/orderApi'

/** 실제 주문 상태 7개 (연동 상세명세 4.1). notPaid는 소문자 그대로 */
export type OrderStatus =
  | 'COLLECTING' // 접수 중 (AI 통화로 모으는 중, 저장된 것만 목록에 나옴)
  | 'notPaid' // 결제 대기
  | 'PAID' // 결제 완료
  | 'SUBMITTING' // 디버 접수 중
  | 'ACCEPTED' // 디버 접수 완료 — '접수 완료'는 이것만
  | 'SUBMISSION_FAILED' // 디버 접수 실패
  | 'CANCELLED' // 주문 취소

/** 화면 탭 5개 = 서버 statusGroup. '결제 완료' 탭에는 PAID · SUBMITTING · ACCEPTED · SUBMISSION_FAILED가 함께 */
export type StatusGroup = 'ALL' | 'COLLECTING' | 'notPaid' | 'PAID' | 'CANCELLED'

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

/** 화면 조건 (URL) — 날짜는 하루 단위, 종료일 포함 */
export interface OrderListQuery {
  q: string // 이름 · 전화번호 · 주소 (서버 검색, 주문 번호 검색 없음)
  from: Ymd
  to: Ymd
  group: StatusGroup
}

/** 화면 조건 → 서버 query. 날짜는 한국 시각 '시작일 00:00 ~ 종료일 다음 날 00:00'(to는 미포함, 명세 1장) · 전체 탭은 statusGroup 생략 */
export function toServerQuery(q: OrderListQuery) {
  return {
    q: q.q.trim() || undefined,
    statusGroup: q.group === 'ALL' ? undefined : q.group,
    from: `${q.from}T00:00:00+09:00`,
    to: `${addDays(q.to, 1)}T00:00:00+09:00`,
  }
}

export const orderQueries = {
  all: () => ['orders'] as const, // shared/order의 상세와 같은 뿌리 → 수정 · 추가 후 invalidate 한 번에 목록 · 상세 모두 갱신
  list: (query: OrderListQuery, page: number, size: number) =>
    queryOptions({
      queryKey: [...orderQueries.all(), 'list', query, page, size],
      queryFn: ({ signal }) =>
        api.get<ApiList<OrderListItem>>('/admin/orders', {
          query: { ...toServerQuery(query), limit: size, offset: offsetOf(page, size) },
          signal,
        }),
      placeholderData: keepPreviousData, // 쪽 · 필터를 바꾸는 동안 이전 목록을 그대로 (표가 깜빡이지 않게)
    }),
}

/** CSV 내보내기 — 지금 조건의 전체 (100건씩 끝까지, 공용 fetchAll 최대 2,000건) */
export const fetchAllOrders = (query: OrderListQuery): Promise<OrderListItem[]> =>
  fetchAll<OrderListItem>('/admin/orders', toServerQuery(query))

// ---------- 아래는 아직 가짜 (주문 추가 · 수정 단계에서 실서버로) ----------
const wait = () => new Promise((r) => setTimeout(r, 200)) // 가짜 응답 지연

/** 주문 추가(수기 접수) 본문 */
export interface OrderInput {
  sender: Party
  receiver: Party
  items: OrderDetail['items']
  declaredValue: number | null // 물품 가액 원 (선택)
  pickupAt: string | null // ISO 8601 (선택)
  paymentMethod: PaymentMethod
  request: string | null // 고객 요청 사항 (선택)
}

// 가짜도 BE에 요청한 규칙(10/31)대로: 같은 멱등키로 다시 오면 새로 만들지 않고 처음 결과를 돌려줌
// shortcut: 가짜는 본문 검증을 안 함 (화면 · CSV 검사가 먼저 거름) — 실제 422는 서버가 줌
const replay = new Map<string, number>()

const toNewOrder = (input: OrderInput, manualBy: string): Omit<OrderDetail, 'orderSeq'> => ({
  route: 'MANUAL',
  manualBy,
  acceptedAt: new Date().toISOString(),
  cancelled: false,
  sender: input.sender,
  receiver: input.receiver,
  items: input.items,
  pickupRequestedAt: input.pickupAt,
  itemPrice: input.declaredValue,
  clientComment: input.request,
  paymentMethod: input.paymentMethod,
  paymentState: 'UNPAID',
  relatedCalls: [],
})

/** 주문 추가(수기 접수) — 접수되면 결제 대기. 멱등키: 같은 본문을 다시 보낼 땐 같은 키 (명세서 1.2) */
export async function createOrder(
  input: OrderInput,
  idempotencyKey: string,
  manualBy: string,
): Promise<number> {
  await wait()
  const done = replay.get(idempotencyKey)
  if (done) return done
  const orderSeq = addOrder(toNewOrder(input, manualBy))
  replay.set(idempotencyKey, orderSeq)
  return orderSeq
}

/** 주문 수정 — 명세 ORD-04 PATCH /orders/{id} (응답 모양 확인 전). 수정은 재시도해도 결과가 같아 멱등키 없음 */
export async function saveOrder(orderSeq: number, input: OrderInput): Promise<void> {
  await wait()
  updateOrder(orderSeq, {
    sender: input.sender,
    receiver: input.receiver,
    items: input.items,
    pickupRequestedAt: input.pickupAt,
    itemPrice: input.declaredValue,
    clientComment: input.request,
    paymentMethod: input.paymentMethod,
  })
}
