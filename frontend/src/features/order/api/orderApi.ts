// 03 주문 내역 Model — 주문 목록 · 주문 추가. React를 모르는 데이터 층
// 명세 확인 전 (04 · 09와 같은 방식, 10/30) → 지금은 네트워크 없이 메모리 가짜 데이터. 서버가 할 거르기 · 쪽 나누기도 여기서 흉내
// 가짜 주문은 shared/order(주문 상세 · 06과 공용)의 저장소 하나만 씀 → 목록에서 누른 주문이 상세에도 그대로 있음
// 명세가 오면 fetchOrders · fetchAllOrders · createOrder 몸통만 api 호출로 바꾸면 됨 (훅 · 화면은 그대로)
import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import { todayYmd, ymd, type Ymd } from '@/shared/lib/dateRange'
import { matchKo, phoneDigits } from '@/shared/lib/search'
import {
  addOrder,
  allOrders,
  updateOrder,
  type OrderDetail,
  type Party,
  type PaymentMethod,
} from '@/shared/order/orderApi'

export type { OrderDetail, Party, PaymentMethod } from '@/shared/order/orderApi'

/** 접수 중(통화가 아직 주문을 만드는 중) · 결제 대기 · 결제 완료 · 주문 취소 */
export type OrderStatus = 'IN_PROGRESS' | 'PAYMENT_PENDING' | 'PAID' | 'CANCELLED'

/** 품목 4종 (와이어프레임 03 · 디버 FAQ '박스 크기') — 주문 상세의 items 키와 같은 순서. 그 밖은 '기타 품목' 글로 */
export const BOX_TYPES = [
  { key: 'document', label: '서류' },
  { key: 'small', label: '소박스' },
  { key: 'medium', label: '중박스' },
  { key: 'big', label: '대박스' },
] as const
export type BoxKey = (typeof BOX_TYPES)[number]['key']

export interface OrderRow {
  orderSeq: number
  status: OrderStatus
  receivedAt: string // 접수 시각 (ISO 8601)
  sender: Party
  receiver: Party
  pickupAt: string | null // 접수 중이거나 수기 접수에서 비워 두면 없음
  items: OrderDetail['items'] | null // 접수 중이면 null
  itemPrice: number | null // 아래 셋은 CSV 내보내기용 (접수 중이면 null)
  paymentMethod: PaymentMethod | null
  clientComment: string | null
}

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

export interface OrderListQuery {
  q: string // 이름 · 전화번호 · 주소 · 주문 번호
  from: Ymd // 포함
  to: Ymd // 포함
  status: OrderStatus | 'ALL'
}

export const orderQueries = {
  all: () => ['orders'] as const, // shared/order의 상세와 같은 뿌리 → 접수 후 invalidate 한 번에 목록 · 상세 모두 갱신
  list: (query: OrderListQuery, page: number, size: number) =>
    queryOptions({
      queryKey: [...orderQueries.all(), 'list', query, page, size],
      queryFn: () => fetchOrders(query, page, size),
      placeholderData: keepPreviousData, // 쪽 · 필터를 바꾸는 동안 이전 목록을 그대로 (표가 깜빡이지 않게)
    }),
}

const wait = () => new Promise((r) => setTimeout(r, 200)) // 가짜 응답 지연 ('불러오는 중' 확인용)

const statusOf = (o: OrderDetail): OrderStatus =>
  o.cancelled ? 'CANCELLED' : o.paymentState === 'PAID' ? 'PAID' : 'PAYMENT_PENDING'

const toRow = (o: OrderDetail): OrderRow => ({
  orderSeq: o.orderSeq,
  status: statusOf(o),
  receivedAt: o.acceptedAt,
  sender: o.sender,
  receiver: o.receiver,
  pickupAt: o.pickupRequestedAt,
  items: o.items,
  itemPrice: o.itemPrice,
  paymentMethod: o.paymentMethod,
  clientComment: o.clientComment,
})

const matchParty = (p: Party, q: string, digits: string) =>
  matchKo(p.name, q) ||
  matchKo(`${p.roadAddress} ${p.detailAddress ?? ''}`, q) ||
  (digits !== '' && p.phoneNumber.includes(digits))

/** 조건에 맞는 주문, 최신순 (서버가 할 일) */
function filtered(query: OrderListQuery): OrderRow[] {
  const digits = phoneDigits(query.q) // 숫자만 쳤을 때만 번호로
  return [...allOrders().map(toRow), ...IN_PROGRESS]
    .filter((o) => {
      const day = ymd(new Date(o.receivedAt))
      return (
        day >= query.from &&
        day <= query.to &&
        (query.status === 'ALL' || o.status === query.status) &&
        (matchParty(o.sender, query.q, digits) ||
          matchParty(o.receiver, query.q, digits) ||
          (digits !== '' && String(o.orderSeq) === digits))
      )
    })
    .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt))
}

export async function fetchOrders(
  query: OrderListQuery,
  page: number,
  size: number,
): Promise<{ items: OrderRow[]; totalCount: number }> {
  await wait()
  const all = filtered(query)
  return { items: all.slice((page - 1) * size, page * size), totalCount: all.length }
}

/** CSV 내보내기 — 지금 조건의 전체 쪽 */
export async function fetchAllOrders(query: OrderListQuery): Promise<OrderRow[]> {
  await wait()
  return filtered(query)
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

// '접수 중' = AI가 아직 통화로 주문을 만드는 중 (상세 · 품목 · 수거 일시 없음 → 목록에서 눌러도 안 열림). 와이어프레임 03의 강서윤 13:44
const IN_PROGRESS: OrderRow[] = [
  {
    orderSeq: 10521,
    status: 'IN_PROGRESS',
    receivedAt: `${todayYmd()}T13:44:00+09:00`,
    sender: {
      name: '강서윤',
      phoneNumber: '01077812290',
      roadAddress: '경기 용인시 포은대로 435',
      detailAddress: null,
    },
    receiver: {
      name: '이준호',
      phoneNumber: '01027182818',
      roadAddress: '서울 동작구 상도로 55',
      detailAddress: null,
    },
    pickupAt: null,
    items: null,
    itemPrice: null,
    paymentMethod: null,
    clientComment: null,
  },
]
