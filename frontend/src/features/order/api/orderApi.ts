// 03 주문 내역 Model — 주문 목록. 검색 · 날짜 · 상태로 거르고 쪽을 나눠 { items, totalCount }. React를 모르는 데이터 층
// 명세 확인 전 (04 · 09와 같은 방식, 10/30) → 지금은 네트워크 없이 메모리 가짜 데이터. 서버가 할 거르기 · 쪽 나누기도 여기서 흉내
// 명세가 오면 fetchOrders · fetchAllOrders 몸통만 api.get으로 바꾸면 됨 (훅 · 화면은 그대로)
import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import { addDays, todayYmd, ymd, type Ymd } from '@/shared/lib/dateRange'
import { matchKo, phoneDigits } from '@/shared/lib/search'

/** 접수 중(통화가 아직 주문을 만드는 중) · 결제 대기 · 결제 완료 · 주문 취소 */
export type OrderStatus = 'IN_PROGRESS' | 'PAYMENT_PENDING' | 'PAID' | 'CANCELLED'

export interface OrderParty {
  name: string
  phone: string // 숫자만
  address: string // 도로명 + 상세
}

export interface OrderRow {
  orderSeq: number
  status: OrderStatus
  receivedAt: string // 접수 시각 (ISO 8601)
  sender: OrderParty
  receiver: OrderParty
  pickupAt: string | null // 수거 희망 일시. 접수 중이거나 수기 접수에서 비워 두면 없음
  items: { box: BoxType; count: number }[] // 접수 중이면 빈 배열
}

/** 품목 4종 (와이어프레임 03 · 디버 FAQ '박스 크기'). 그 밖은 '기타 품목' 글로 */
export const BOX_TYPES = ['서류', '소박스', '중박스', '대박스'] as const
export type BoxType = (typeof BOX_TYPES)[number]

/** 결제 방식 — 06 주문 상세와 같은 코드 (credit = 월정산 · groupBilling = 그룹카드 · billing = 개인카드) */
export type PaymentMethod = 'credit' | 'groupBilling' | 'billing'

/** 주문 추가(수기 접수) 본문 */
export interface OrderInput {
  sender: { name: string; phone: string; roadAddress: string; detailAddress: string }
  receiver: { name: string; phone: string; roadAddress: string; detailAddress: string }
  items: { box: BoxType; count: number }[] // 0개인 품목은 뺌
  etcItem: string // 기타 품목 (선택)
  declaredValue: number | null // 물품 가액 원 (선택)
  pickupAt: string | null // ISO 8601 (선택)
  paymentMethod: PaymentMethod
  request: string // 고객 요청 사항 (선택)
}

export interface OrderListQuery {
  q: string // 이름 · 전화번호 · 주소 · 주문 번호
  from: Ymd // 포함
  to: Ymd // 포함
  status: OrderStatus | 'ALL'
}

export const orderQueries = {
  all: () => ['orders'] as const,
  list: (query: OrderListQuery, page: number, size: number) =>
    queryOptions({
      queryKey: [...orderQueries.all(), 'list', query, page, size],
      queryFn: () => fetchOrders(query, page, size),
      placeholderData: keepPreviousData, // 쪽 · 필터를 바꾸는 동안 이전 목록을 그대로 (표가 깜빡이지 않게)
    }),
}

const wait = () => new Promise((r) => setTimeout(r, 200)) // 가짜 응답 지연 ('불러오는 중' 확인용)

const matchParty = (p: OrderParty, q: string, digits: string) =>
  matchKo(p.name, q) || matchKo(p.address, q) || (digits !== '' && p.phone.includes(digits))

/** 조건에 맞는 주문, 최신순 (서버가 할 일) */
function filtered(query: OrderListQuery): OrderRow[] {
  const digits = phoneDigits(query.q) // 숫자만 쳤을 때만 번호로
  return ROWS.filter((o) => {
    const day = ymd(new Date(o.receivedAt))
    return (
      day >= query.from &&
      day <= query.to &&
      (query.status === 'ALL' || o.status === query.status) &&
      (matchParty(o.sender, query.q, digits) ||
        matchParty(o.receiver, query.q, digits) ||
        (digits !== '' && String(o.orderSeq) === digits))
    )
  }).sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt))
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

/** 주문 추가(수기 접수) — 접수되면 결제 대기. 멱등키: 같은 본문을 다시 보낼 땐 같은 키 (명세서 1.2)
 * shortcut: 가짜는 키를 확인하지 않음 — BE가 오면 같은 키 + 같은 본문이면 새로 만들지 않음 */
export async function createOrder(input: OrderInput, idempotencyKey: string): Promise<void> {
  void idempotencyKey
  await wait()
  const full = (p: OrderInput['sender']) =>
    party(p.name, p.phone, [p.roadAddress, p.detailAddress].filter(Boolean).join(' '))
  ROWS.push({
    orderSeq: Math.max(...ROWS.map((o) => o.orderSeq)) + 1,
    status: 'PAYMENT_PENDING',
    receivedAt: new Date().toISOString(),
    sender: full(input.sender),
    receiver: full(input.receiver),
    pickupAt: input.pickupAt,
    items: input.items,
  })
}

// ---------- 가짜 데이터: 오늘 104건 + 지난 6일 ----------
// 날짜는 오늘 기준 (고정 날짜면 기본값 '오늘'에 아무것도 안 나옴). 위 7줄은 와이어프레임 03 그대로
// 10519 강도윤 13:12 = 06 통화 상세 9101 장면의 주문 (받는 분 1402호로 수정된 뒤)
const today = todayYmd()
const at = (day: Ymd, hm: string) => `${day}T${hm}:00+09:00`
const tomorrow = addDays(today, 1)
const party = (name: string, phone: string, address: string): OrderParty => ({
  name,
  phone,
  address,
})

const FIXED: OrderRow[] = [
  {
    orderSeq: 10526,
    status: 'PAID',
    receivedAt: at(today, '14:31'),
    sender: party('이서연', '01028174405', '서울 마포구 독막로 301 4층'),
    receiver: party('정하늘', '01055123388', '경기 성남시 판교역로 166 3층'),
    pickupAt: at(tomorrow, '14:00'),
    items: [{ box: '소박스', count: 1 }],
  },
  {
    orderSeq: 10525,
    status: 'PAYMENT_PENDING',
    receivedAt: at(today, '14:26'),
    sender: party('김민준', '01031415926', '서울 송파구 올림픽로 300 12층'),
    receiver: party('노하윤', '01090314420', '서울 서초구 반포대로 58'),
    pickupAt: at(tomorrow, '10:00'),
    items: [{ box: '서류', count: 2 }],
  },
  {
    orderSeq: 10524,
    status: 'CANCELLED',
    receivedAt: at(today, '14:22'),
    sender: party('박지호', '01041832290', '서울 동작구 상도로 55'),
    receiver: party('조하은', '01033775120', '부산 해운대구 센텀중앙로 79'),
    pickupAt: at(tomorrow, '11:00'),
    items: [{ box: '중박스', count: 1 }],
  },
  {
    orderSeq: 10523,
    status: 'PAID',
    receivedAt: at(today, '14:15'),
    sender: party('윤재석', '01088123390', '서울 중구 을지로 100 8층'),
    receiver: party('김도윤', '01022318840', '대전 서구 둔산로 100'),
    pickupAt: at(today, '16:00'),
    items: [
      { box: '소박스', count: 1 },
      { box: '중박스', count: 1 },
    ],
  },
  {
    orderSeq: 10522,
    status: 'PAYMENT_PENDING',
    receivedAt: at(today, '14:03'),
    sender: party('최제훈', '01099200007', '경기 고양시 중앙로 1275'),
    receiver: party('류성민', '01062003145', '경기 수원시 광교로 107'),
    pickupAt: at(today, '15:00'),
    items: [{ box: '대박스', count: 1 }],
  },
  {
    orderSeq: 10521,
    status: 'IN_PROGRESS',
    receivedAt: at(today, '13:44'),
    sender: party('강서윤', '01077812290', '경기 용인시 포은대로 435'),
    receiver: party('이준호', '01027182818', '서울 동작구 상도로 55'),
    pickupAt: null,
    items: [],
  },
  {
    orderSeq: 10519,
    status: 'PAID',
    receivedAt: at(today, '13:12'),
    sender: party('강도윤', '01066382047', '서울 강남구 역삼로 150 5층'),
    receiver: party('이영희', '01023456789', '서울 마포구 독막로 301 1402호'),
    pickupAt: at(tomorrow, '09:00'),
    items: [{ box: '서류', count: 1 }],
  },
]

// 나머지는 규칙으로 만듦 (같은 값이 나오게 난수 없이 번호로 고름)
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
const ADDRS = [
  '서울 강서구 공항대로 247',
  '서울 성동구 왕십리로 83',
  '인천 연수구 송도과학로 32',
  '경기 부천시 길주로 210',
  '서울 노원구 동일로 1414',
  '대구 수성구 동대구로 220',
  '광주 서구 상무중앙로 70',
  '경기 안양시 평촌대로 120',
]
const STATUS_CYCLE: OrderStatus[] = [
  'PAID',
  'PAID',
  'PAID',
  'PAYMENT_PENDING',
  'PAID',
  'PAID',
  'CANCELLED',
  'PAID',
]
const pad = (n: number) => String(n).padStart(2, '0')

function makeDay(day: Ymd, count: number, startSeq: number, endMinute: number): OrderRow[] {
  return Array.from({ length: count }, (_, i) => {
    const n = startSeq + i
    const minute = endMinute - i * 4 // 4분 간격으로 거슬러 올라감
    const hm = `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`
    return {
      orderSeq: n,
      status: STATUS_CYCLE[n % STATUS_CYCLE.length],
      receivedAt: at(day, hm),
      sender: party(
        NAMES[n % NAMES.length],
        `010${String(20000000 + n * 7919).slice(-8)}`,
        ADDRS[n % ADDRS.length],
      ),
      receiver: party(
        NAMES[(n + 5) % NAMES.length],
        `010${String(30000000 + n * 104729).slice(-8)}`,
        ADDRS[(n + 3) % ADDRS.length],
      ),
      pickupAt: at(addDays(day, 1), `${pad(9 + (n % 8))}:00`),
      items: [{ box: BOX_TYPES[n % BOX_TYPES.length], count: 1 + (n % 3) }],
    }
  })
}

const ROWS: OrderRow[] = [
  ...FIXED,
  ...makeDay(today, 104 - FIXED.length, 10200, 13 * 60), // 13:00부터 거슬러 (위 고정 줄보다 이른 시각)
  ...[1, 2, 3, 4, 5, 6].flatMap((d) =>
    makeDay(addDays(today, -d), 60 + d * 3, 9000 + d * 100, 18 * 60),
  ),
]
