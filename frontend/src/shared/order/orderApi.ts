// 주문 상세 — 03 주문 내역(팀원) · 06 통화 상세 '주문 보기'가 같이 씀 (10/30 공통으로 올림, shared/auth와 같은 예외)
// 명세 ORD-03 GET /orders/{id} — 응답 모양이 정해지면 fetchOrder 몸통만 바꿈. 지금은 네트워크 없이 메모리 가짜 데이터
// api 역할: React를 모른다. 화면용 값은 useOrderDetail.ts
import { queryOptions } from '@tanstack/react-query'
import { NotFoundError } from '@/shared/api/client'
import { addDays, todayYmd } from '@/shared/lib/dateRange'

export interface Party {
  name: string
  phoneNumber: string // 숫자만
  roadAddress: string
  detailAddress: string | null
}

export type PaymentMethod = 'MONTHLY' | 'GROUP_CARD' | 'PERSONAL_CARD' // 월정산 · 그룹카드 · 개인카드 (디버 10/27)
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
  pickupRequestedAt: string
  itemPrice: number
  clientComment: string | null
  paymentMethod: PaymentMethod
  paymentState: PaymentState
  relatedCalls: { callSessionSeq: number; startedAt: string; kind: 'ACCEPT' | 'CANCEL' }[]
}

export const orderQueries = {
  all: () => ['orders'] as const,
  detail: (id: number) =>
    queryOptions({
      queryKey: [...orderQueries.all(), id],
      queryFn: () => fetchOrder(id),
    }),
}

const wait = () => new Promise((r) => setTimeout(r, 200)) // 가짜 응답 지연 ('불러오는 중' 확인용)

export async function fetchOrder(id: number): Promise<OrderDetail> {
  await wait()
  const order = ORDERS.find((o) => o.orderSeq === id)
  if (!order) throw new NotFoundError('주문을 찾을 수 없습니다.')
  return order
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
    acceptedAt: t('13:12:00'),
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
    relatedCalls: [{ callSessionSeq: 9101, startedAt: t('13:12:08'), kind: 'ACCEPT' }],
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
    acceptedAt: t('14:22:00'),
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
      { callSessionSeq: 9105, startedAt: t('14:35:20'), kind: 'CANCEL' },
    ],
  },
]
