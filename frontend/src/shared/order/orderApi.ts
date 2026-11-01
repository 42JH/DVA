// 주문 상세 — 03 주문 내역(팀원) · 06 통화 상세 '주문 보기'가 같이 씀 (10/30 공통으로 올림, shared/auth와 같은 예외)
// GET /orders/{id} (연동 상세명세 10/31 §4.2) → orderDto.toOrderDetail, 관련 통화는 GET /calls?orderSeq (§2 03_주문상세_전화)
// 아래 ORDERS 메모리 저장소는 03 주문 내역(팀원)의 가짜 목록 · 추가 · 수정용. MSW GET /orders/:id도 이 저장소를 읽음 (mocks/handlers/orders.ts)
// api 역할: React를 모른다. 화면용 값은 useOrderDetail.ts
import { queryOptions } from '@tanstack/react-query'
import { api, NotFoundError, type ApiItem } from '@/shared/api/client'
import { fetchAll } from '@/shared/api/paging'
import { addDays, todayYmd } from '@/shared/lib/dateRange'
import { toOrderDetail, type OrderDetailDto, type OrderStatusDto } from './orderDto'

export interface Party {
  name: string
  phoneNumber: string // 숫자만
  roadAddress: string
  detailAddress: string | null
  // 서버 주소의 나머지 칸 (실서버 응답에만, 11/01) — 고객정보 저장은 주소 전체가 필요해서
  jibunAddress?: string
  dongName?: string
  postalCode?: string
  hasCoords?: boolean // 위도 · 경도가 있는지 — 접수 중단 주문을 접수할 때 주소가 완성됐는지 보려고
}

// 월정산 · 그룹카드 · 개인카드 (디버 10/27) + 지점 방문(예전 주문 조회만 — 서버 cat, 새로 고를 수 없음)
export type PaymentMethod = 'MONTHLY' | 'GROUP_CARD' | 'PERSONAL_CARD' | 'BRANCH_VISIT'
export type PaymentState = 'PAID' | 'UNPAID' | 'CANCELLED_BEFORE_PAYMENT'

/** 주문 상세 (디자인 03_주문내역_주문상세 · _전화, 06 '주문 보기' 팝업과 같은 내용 · 읽기 전용) */
export interface OrderDetail {
  orderSeq: number
  route: 'PHONE' | 'MANUAL' // 전화 · 수기
  manualBy: string | null // 수기 접수한 관리자 이름 ('수기 접수 이재훈'). 전화 접수면 null
  acceptedAt: string
  cancelled: boolean
  sender: Party
  receiver: Party
  items: { document: number; small: number; medium: number; big: number; other: string | null }
  pickupRequestedAt: string | null // 수기 접수에서 비워 둘 수 있음 (10/31)
  itemPrice: number | null // 수기 접수에서 비워 둘 수 있음
  clientComment: string | null
  paymentMethod: PaymentMethod
  paymentState: PaymentState
  relatedCalls: { callSessionSeq: number; startedAt: string; kind: 'ACCEPT' | 'CANCEL' }[]
  /** 배송 상세마다 (03 목록 줄 = 상세 하나, 11/01). 위 sender · receiver · items는 첫 상세 · 합계(06 팝업 기본값)
   * 메모리 가짜 주문엔 없음 → 없으면 위 값 그대로 */
  parcels?: ParcelDetail[]
  /** 수정용 (03 주문 수정, 11/01) — 메모리 가짜 주문엔 없음 */
  version?: number // 다음 수정의 expectedVersion
  notifiedPrice?: number | null // 배송비 (첫 상세 · pickParcel이면 고른 상세) — 접수 중단 주문 접수에 필요
  customerSeq?: number | null // 주문 고객 — 보내는 분 수정을 고객정보에도 저장할 때 (미완료 주문은 null)
  status?: OrderStatusDto // 실제 상태 — 결제 방식은 COLLECTING에서만 바꿀 수 있음
}

/** 배송 상세 하나 — 보내는 분 1 + 받는 분 1 */
export interface ParcelDetail {
  orderParcelSeq: number
  cancelled: boolean
  sender: Party
  receiver: Party
  items: OrderDetail['items']
  itemPrice: number | null
  clientComment: string | null
  notifiedPrice: number | null
}

export const orderQueries = {
  all: () => ['orders'] as const,
  detail: (id: number) =>
    queryOptions({
      queryKey: [...orderQueries.all(), id],
      queryFn: ({ signal }) => fetchOrder(id, signal),
    }),
}

/** 통화 목록 줄 중 관련 통화에 필요한 칸만 (CallListItem §13) */
interface RelatedCallDto {
  callSessionSeq: number
  startedAt: string | null
  analysis: { result: string } | null
}

export async function fetchOrder(id: number, signal?: AbortSignal): Promise<OrderDetail> {
  const [res, calls] = await Promise.all([
    api.get<ApiItem<OrderDetailDto>>(`/orders/${id}`, { signal }),
    fetchAll<RelatedCallDto>('/calls', { orderSeq: id }, signal), // 응답에 관련 통화가 없어 통화 목록에서
  ])
  return {
    ...toOrderDetail(res.data),
    relatedCalls: calls
      .filter((c): c is RelatedCallDto & { startedAt: string } => c.startedAt !== null)
      .map((c) => ({
        callSessionSeq: c.callSessionSeq,
        startedAt: c.startedAt,
        kind: c.analysis?.result === 'CANCELLED' ? ('CANCEL' as const) : ('ACCEPT' as const),
      }))
      .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt)),
  }
}

// ---------- 가짜 데이터 — 날짜는 오늘 기준 (06 · 04 가짜 통화와 같은 날), 수거 희망 = 내일 ----------
// 10519 · 10531 = 06 장면의 주문, 10530 = 디자인 03_주문내역_주문상세(수기). 03 목록 가짜 줄을 만들면 여기에 같은 번호로 더함
const t = (hms: string) => `${todayYmd()}T${hms}+09:00`
const tomorrow = (hm: string) => `${addDays(todayYmd(), 1)}T${hm}:00+09:00`

const ORDERS: OrderDetail[] = [
  {
    orderSeq: 10519,
    route: 'PHONE',
    manualBy: null,
    acceptedAt: t('13:15:37'), // 통화 9101(13:12 시작)의 접수 시점 03:37 (mocks/handlers/calls.ts)
    cancelled: false,
    sender: {
      name: '강도윤',
      phoneNumber: '01066382047',
      roadAddress: '서울 강남구 역삼로 150',
      detailAddress: '5층',
    },
    receiver: {
      name: '이영희',
      phoneNumber: '01023456789',
      roadAddress: '서울 마포구 독막로 301',
      detailAddress: '402호',
    },
    items: { document: 1, small: 0, medium: 0, big: 0, other: null },
    pickupRequestedAt: tomorrow('09:00'),
    itemPrice: 30000,
    clientComment: '경비실에 맡겨 주세요',
    paymentMethod: 'MONTHLY',
    paymentState: 'PAID',
    relatedCalls: [{ callSessionSeq: 9101, startedAt: t('13:12:00'), kind: 'ACCEPT' }],
  },
  {
    orderSeq: 10530,
    route: 'MANUAL',
    manualBy: '이재훈',
    acceptedAt: t('14:15:00'),
    cancelled: false,
    sender: {
      name: '윤재석',
      phoneNumber: '01088123390',
      roadAddress: '서울 중구 을지로 100',
      detailAddress: '8층',
    },
    receiver: {
      name: '김도윤',
      phoneNumber: '01022318840',
      roadAddress: '대전 서구 둔산로 100',
      detailAddress: null,
    },
    items: { document: 0, small: 1, medium: 1, big: 0, other: null },
    pickupRequestedAt: t('16:00:00'),
    itemPrice: 150000,
    clientComment: null,
    paymentMethod: 'MONTHLY',
    paymentState: 'PAID',
    relatedCalls: [], // 수기 접수라 관련 통화 없음
  },
  {
    orderSeq: 10531,
    route: 'PHONE',
    manualBy: null,
    acceptedAt: t('14:26:00'), // 통화 9103(14:22 시작) 안에서 접수
    cancelled: true,
    sender: {
      name: '박지호',
      phoneNumber: '01041832290',
      roadAddress: '서울 동작구 상도로 55',
      detailAddress: null,
    },
    receiver: {
      name: '조하은',
      phoneNumber: '01033775120',
      roadAddress: '부산 해운대구 센텀중앙로 79',
      detailAddress: null,
    },
    items: { document: 0, small: 0, medium: 1, big: 0, other: null },
    pickupRequestedAt: tomorrow('11:00'),
    itemPrice: 50000,
    clientComment: null,
    paymentMethod: 'PERSONAL_CARD',
    paymentState: 'CANCELLED_BEFORE_PAYMENT',
    relatedCalls: [
      { callSessionSeq: 9103, startedAt: t('14:22:10'), kind: 'ACCEPT' }, // 접수 통화 — 06 가짜 장면은 없음
      { callSessionSeq: 9105, startedAt: t('14:35:00'), kind: 'CANCEL' },
    ],
  },
]

/** 03 주문 목록 · 주문 추가가 같은 가짜 저장소를 쓰도록 (목록 · 상세 · 06이 같은 주문을 봄). 명세가 오면 둘 다 지움 */
export const allOrders = (): readonly OrderDetail[] => ORDERS

export function addOrder(order: Omit<OrderDetail, 'orderSeq'>): number {
  const orderSeq = Math.max(...ORDERS.map((o) => o.orderSeq)) + 1
  ORDERS.push({ ...order, orderSeq })
  return orderSeq
}

/** 03 주문 수정 — 바꿀 수 있는 칸만 (경로 · 접수 시각 · 결제 상태 · 관련 통화는 그대로) */
export function updateOrder(
  orderSeq: number,
  patch: Pick<
    OrderDetail,
    | 'sender'
    | 'receiver'
    | 'items'
    | 'pickupRequestedAt'
    | 'itemPrice'
    | 'clientComment'
    | 'paymentMethod'
  >,
): void {
  const i = ORDERS.findIndex((o) => o.orderSeq === orderSeq)
  if (i < 0) throw new NotFoundError('주문을 찾을 수 없습니다.')
  ORDERS[i] = { ...ORDERS[i], ...patch }
}

// ---------- 03 목록 가짜 줄 (와이어프레임 03_주문내역 + 규칙 생성) ----------
// 위 3건(10519 · 10530 · 10531)과 합쳐 오늘 103건 + 지난 6일. 목록의 '접수 중' 1줄은 아직 주문이 아니라 03 목록 쪽에 따로 있음
const at = (day: string, hm: string) => `${day}T${hm}:00+09:00`
const p = (
  name: string,
  phoneNumber: string,
  roadAddress: string,
  detailAddress: string | null = null,
): Party => ({
  name,
  phoneNumber,
  roadAddress,
  detailAddress,
})
const phoneOrder = (
  orderSeq: number,
  hm: string,
  sender: Party,
  receiver: Party,
  pickup: string,
  items: Partial<OrderDetail['items']>,
  paymentState: PaymentState,
): OrderDetail => ({
  orderSeq,
  route: 'PHONE',
  manualBy: null,
  acceptedAt: t(`${hm}:00`),
  cancelled: false,
  sender,
  receiver,
  items: { document: 0, small: 0, medium: 0, big: 0, other: null, ...items },
  pickupRequestedAt: pickup,
  itemPrice: 30000,
  clientComment: null,
  paymentMethod: 'MONTHLY',
  paymentState,
  relatedCalls: [],
})

ORDERS.push(
  phoneOrder(
    10526,
    '14:31',
    p('이서연', '01028174405', '서울 마포구 독막로 301', '4층'),
    p('정하늘', '01055123388', '경기 성남시 판교역로 166', '3층'),
    tomorrow('14:00'),
    { small: 1 },
    'PAID',
  ),
  phoneOrder(
    10525,
    '14:26',
    p('김민준', '01031415926', '서울 송파구 올림픽로 300', '12층'),
    p('노하윤', '01090314420', '서울 서초구 반포대로 58'),
    tomorrow('10:00'),
    { document: 2 },
    'UNPAID',
  ),
  phoneOrder(
    10522,
    '14:03',
    p('최제훈', '01099200007', '경기 고양시 중앙로 1275'),
    p('류성민', '01062003145', '경기 수원시 광교로 107'),
    t('15:00:00'),
    { big: 1 },
    'UNPAID',
  ),
)

const NAMES = [
  '김하준',
  '이지우',
  '박서윤',
  '최도현',
  '정예은',
  '한시우',
  '오유진',
  '서민재',
  '신아린',
  '장우진',
  '임채원',
  '황지안',
]
const ROADS = [
  '서울 강서구 공항대로 247',
  '서울 성동구 왕십리로 83',
  '인천 연수구 송도과학로 32',
  '경기 부천시 길주로 210',
  '서울 노원구 동일로 1414',
  '대구 수성구 동대구로 220',
  '광주 서구 상무중앙로 70',
  '경기 안양시 평촌대로 120',
]
const BOX_KEYS = ['document', 'small', 'medium', 'big'] as const
const pad = (n: number) => String(n).padStart(2, '0')

/** 하루치 주문을 규칙으로 (난수 없이 번호로 골라 늘 같은 값). 4분 간격으로 거슬러 올라감 */
function makeDay(day: string, count: number, startSeq: number, endMinute: number): OrderDetail[] {
  return Array.from({ length: count }, (_, i) => {
    const n = startSeq + i
    const minute = endMinute - i * 4
    const cancelled = n % 8 === 6
    return {
      orderSeq: n,
      route: n % 5 === 0 ? 'MANUAL' : 'PHONE',
      manualBy: n % 5 === 0 ? '이재훈' : null,
      acceptedAt: at(day, `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`),
      cancelled,
      sender: p(
        NAMES[n % NAMES.length],
        `010${String(20000000 + n * 7919).slice(-8)}`,
        ROADS[n % ROADS.length],
      ),
      receiver: p(
        NAMES[(n + 5) % NAMES.length],
        `010${String(30000000 + n * 104729).slice(-8)}`,
        ROADS[(n + 3) % ROADS.length],
        `${(n % 9) + 1}층`,
      ),
      items: {
        document: 0,
        small: 0,
        medium: 0,
        big: 0,
        other: null,
        [BOX_KEYS[n % 4]]: 1 + (n % 3),
      },
      pickupRequestedAt: at(addDays(day, 1), `${pad(9 + (n % 8))}:00`),
      itemPrice: 10000 * (1 + (n % 10)),
      clientComment: n % 7 === 0 ? '경비실에 맡겨 주세요' : null,
      paymentMethod: (['MONTHLY', 'GROUP_CARD', 'PERSONAL_CARD'] as const)[n % 3],
      paymentState: cancelled ? 'CANCELLED_BEFORE_PAYMENT' : n % 8 === 3 ? 'UNPAID' : 'PAID',
      relatedCalls: [],
    }
  })
}

ORDERS.push(
  ...makeDay(todayYmd(), 103 - ORDERS.length, 10200, 13 * 60), // 오늘 = 위 고정 줄 + 생성 = 103 (+ 목록의 접수 중 1 = 104)
  ...[1, 2, 3, 4, 5, 6].flatMap((d) =>
    makeDay(addDays(todayYmd(), -d), 60 + d * 3, 9000 + d * 100, 18 * 60),
  ),
)
