// 06 통화 상세 Model — 통화 하나 = 요약 · 스크립트 · 처리 내용(결과 블록 + AI 동작) / '주문 보기'용 주문 하나. React를 모르는 데이터 층
// 명세 초안(CALL-08/09 · ORD-03)에 고객 이름 · 통화 결과 · 처리 내용 · AI 동작이 없음 → BE가 명세를 짜서 주기로 함 (10/30)
// 지금은 네트워크 없이 메모리 가짜 데이터 (와이어프레임 06 세 장면). 명세가 오면 fetchCallDetail · fetchOrder 몸통만 바꾸면 됨
import { queryOptions } from '@tanstack/react-query'

/** 통화 결과 = 04와 같은 5개. 한 통화 = 결과 하나, 기록으로 우선순위: 이관 > 접수 성공 > 접수 실패 > 주문 취소 > 문의 */
export type Outcome = 'HANDOFF' | 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'INQUIRY'

export interface Complaint {
  kind: string // '되묻기 반복'
  reason: string // '번호를 세 번 말하게 되자 짜증 냄'
  fromSec: number // 스크립트에서 빨갛게 묶을 구간 (통화 안 초, 양 끝 포함)
  toSec: number
}

/** 말 한 줄 (스크립트) */
export interface Utterance {
  atSec: number // 통화 시작부터 초
  speaker: 'AI' | 'CUSTOMER'
  text: string
}

/** 저장할 수 있는 접수 칸 (AI 동작 '저장'이 무엇을 채웠는지) */
export type OrderField =
  | 'origin.name'
  | 'origin.phoneNumber'
  | 'origin.roadAddress'
  | 'origin.detailAddress'
  | 'destination.name'
  | 'destination.phoneNumber'
  | 'destination.roadAddress'
  | 'destination.detailAddress'
  | 'pickupRequestedAt'
  | 'parcels'
  | 'itemPrice'
  | 'clientComment'
  | 'paymentMethodType'

/** AI 동작 한 줄 (말이 아닌 것: 저장 · 검색 · 취소 · 전송). 저장은 칸 + 값, 나머지는 한 줄 글 */
export type AiAction =
  | { atSec: number; kind: 'SAVE'; field: OrderField; value: string }
  | { atSec: number; kind: 'SEARCH' | 'CANCEL' | 'SEND'; text: string }

/** 처리 내용 블록 — 이 통화가 한 일. 답한 질문은 안 나옴 (RAG라 기록 없음, 10/29) */
export type ResultBlock =
  | { atSec: number; kind: 'ACCEPTED' | 'CANCELLED'; orderSeq: number }
  | { atSec: number; kind: 'UNANSWERED'; question: string }

export interface CallDetail {
  callSessionSeq: number
  customerName: string
  outcome: Outcome
  startedAt: string // ISO 8601
  durationSec: number
  callerNumber: string // 숫자만
  persona: { name: string; version: number } // 이 통화를 받은 AI
  complaints: Complaint[]
  utterances: Utterance[]
  actions: AiAction[]
  results: ResultBlock[]
}

export interface Party {
  name: string
  phoneNumber: string // 숫자만
  roadAddress: string
  detailAddress: string | null
}

export type PaymentMethod = 'MONTHLY' | 'GROUP_CARD' | 'PERSONAL_CARD' // 월정산 · 그룹카드 · 개인카드 (디버 10/27)
export type PaymentState = 'PAID' | 'UNPAID' | 'CANCELLED_BEFORE_PAYMENT'

/** 주문 상세 (06 '주문 보기' 팝업 — 03 주문 상세와 같은 내용, 읽기 전용) */
export interface OrderDetail {
  orderSeq: number
  route: 'PHONE' | 'MANUAL' // 전화 · 수기
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

export const callQueries = {
  all: () => ['calls'] as const,
  detail: (id: number) =>
    queryOptions({
      queryKey: [...callQueries.all(), id],
      queryFn: () => fetchCallDetail(id),
    }),
}

export const orderQueries = {
  all: () => ['orders'] as const,
  detail: (id: number) =>
    queryOptions({
      queryKey: [...orderQueries.all(), id],
      queryFn: () => fetchOrder(id),
    }),
}

/** 찾는 통화 · 주문이 없을 때 (화면은 '찾을 수 없습니다') */
export class NotFoundError extends Error {}

const wait = () => new Promise((r) => setTimeout(r, 200)) // 가짜 응답 지연 ('불러오는 중' 확인용)

export async function fetchCallDetail(id: number): Promise<CallDetail> {
  await wait()
  const call = CALLS.find((c) => c.callSessionSeq === id)
  if (!call) throw new NotFoundError('통화를 찾을 수 없습니다.')
  return call
}

export async function fetchOrder(id: number): Promise<OrderDetail> {
  await wait()
  const order = ORDERS.find((o) => o.orderSeq === id)
  if (!order) throw new NotFoundError('주문을 찾을 수 없습니다.')
  return order
}

// ---------- 가짜 데이터 = 와이어프레임 06 세 장면 (build_call_detail SCENES) ----------
const t = (hm: string) => `2026-10-20T${hm}+09:00`
const say = (atSec: number, speaker: 'AI' | 'CUSTOMER', text: string): Utterance => ({
  atSec,
  speaker,
  text,
})
const save = (atSec: number, field: OrderField, value: string): AiAction => ({
  atSec,
  kind: 'SAVE',
  field,
  value,
})
const act = (atSec: number, kind: 'SEARCH' | 'CANCEL' | 'SEND', text: string): AiAction => ({
  atSec,
  kind,
  text,
})
const persona = { name: '빠른 접수형', version: 6 }

const CALLS: CallDetail[] = [
  // 9101 강도윤 10.20 13:12 — 접수 + 접수 중 문의를 AI가 답하지 못함 (한 통화 = 결과 둘). 불만 = 되묻기 반복
  {
    callSessionSeq: 9101,
    customerName: '강도윤',
    outcome: 'SUCCESS',
    startedAt: t('13:12:08'),
    durationSec: 220,
    callerNumber: '01066382047',
    persona,
    complaints: [
      { kind: '되묻기 반복', reason: '번호를 세 번 말하게 되자 짜증 냄', fromSec: 31, toSec: 42 },
    ],
    utterances: [
      say(0, 'AI', '안녕하세요, 디버 택배 접수입니다. 보내는 분 성함을 말씀해 주세요.'),
      say(5, 'CUSTOMER', '강도윤이요.'),
      say(7, 'AI', '물건을 가져갈 주소를 말씀해 주세요.'),
      say(11, 'CUSTOMER', '강남구 역삼로 150, 5층이에요.'),
      say(15, 'AI', '서울 강남구 역삼로 150, 5층 맞으실까요?'),
      say(19, 'CUSTOMER', '네.'),
      say(20, 'AI', '받는 분 성함과 전화번호를 말씀해 주세요.'),
      say(25, 'CUSTOMER', '이영희, 공일공 이삼사오 육칠팔구요.'),
      say(31, 'AI', '받는 분 전화번호를 다시 말씀해 주세요.'),
      say(34, 'CUSTOMER', '공일공 이삼사오 육칠팔구요.'),
      say(38, 'AI', '죄송합니다. 전화번호를 한 번 더 말씀해 주세요.'),
      say(42, 'CUSTOMER', '아니, 몇 번을 말해야 돼요? 공일공 이삼사오 육칠팔구라고요.'),
      say(49, 'AI', '받는 분 번호 010-2345-6789 맞으실까요?'),
      say(53, 'CUSTOMER', '네. 받는 곳은 마포구 독막로 301이에요.'),
      say(59, 'AI', '서울 마포구 독막로 301 맞으실까요? 상세주소가 있으면 말씀해 주세요.'),
      say(65, 'CUSTOMER', '402호요.'),
      say(67, 'AI', '물건은 언제 가져가면 될까요?'),
      say(71, 'CUSTOMER', '내일 오전 9시에 와 주세요.'),
      say(73, 'AI', '10월 21일 수요일 오전 9시 맞으실까요?'),
      say(77, 'CUSTOMER', '네.'),
      say(78, 'AI', '보내실 물건은 서류, 소박스, 중박스, 대박스 중 어떤 크기인가요?'),
      say(84, 'CUSTOMER', '서류 하나요.'),
      say(86, 'AI', '배송 요청 사항이 있으시면 말씀해 주세요.'),
      say(90, 'CUSTOMER', '경비실에 맡겨 주세요.'),
      say(92, 'AI', '경비실에 맡겨 달라고 적어 둘게요.'),
      say(94, 'CUSTOMER', '착불로 보내면 받는 사람이 얼마 내요?'),
      say(97, 'AI', '그 부분은 지금 바로 안내해 드리기 어려워요. 확인해서 다시 알려 드릴게요.'),
      say(102, 'CUSTOMER', '네, 알겠어요.'),
      say(104, 'AI', '보내시는 물건 값은 대략 얼마인가요?'),
      say(108, 'CUSTOMER', '3만 원 정도요.'),
      say(112, 'AI', '결제는 월정산으로 처리됩니다. 지금까지 말씀하신 내용으로 접수할까요?'),
      say(118, 'CUSTOMER', '네, 해 주세요.'),
      say(218, 'AI', '접수되었습니다. 내일 오전 9시에 기사님이 방문합니다.'),
    ],
    actions: [
      save(6, 'origin.name', '강도윤'),
      act(13, 'SEARCH', "주소 검색 '역삼로 150' → 1건"),
      save(14, 'origin.roadAddress', '서울 강남구 역삼로 150'),
      save(14, 'origin.detailAddress', '5층'),
      save(30, 'destination.name', '이영희'),
      save(48, 'destination.phoneNumber', '01023456789'),
      act(57, 'SEARCH', "주소 검색 '독막로 301' → 1건"),
      save(58, 'destination.roadAddress', '서울 마포구 독막로 301'),
      save(66, 'destination.detailAddress', '402호'),
      save(77, 'pickupRequestedAt', '10.21 (수) 09:00'),
      save(85, 'parcels', '서류 1'),
      save(91, 'clientComment', '경비실에 맡겨 주세요'),
      act(96, 'SEARCH', "FAQ 검색 '착불 요금' → 0건"),
      save(109, 'itemPrice', '30,000원'),
      save(215, 'paymentMethodType', '월정산'),
      act(217, 'SEND', '디버 접수 완료'),
    ],
    results: [
      { atSec: 217, kind: 'ACCEPTED', orderSeq: 10519 },
      { atSec: 94, kind: 'UNANSWERED', question: '착불로 보내면 받는 사람이 얼마 내요?' },
    ],
  },
  // 9104 (주)한빛상사 10.20 14:33 — 주문 없이 물었는데 AI가 답하지 못함 (= 09 AI 미답변 줄)
  {
    callSessionSeq: 9104,
    customerName: '(주)한빛상사',
    outcome: 'INQUIRY',
    startedAt: t('14:33:05'),
    durationSec: 70,
    callerNumber: '01055219032',
    persona,
    complaints: [],
    utterances: [
      say(0, 'AI', '안녕하세요, 디버 택배 접수입니다. 무엇을 도와드릴까요?'),
      say(4, 'CUSTOMER', '오늘 수거 접수했는데요, 기사님 오늘 몇 시쯤 도착하세요?'),
      say(11, 'AI', '죄송합니다. 기사님 도착 시간은 지금 바로 확인해 드리기 어려워요.'),
      say(17, 'AI', '수거 희망 시간은 내일 오전 10시로 접수되어 있어요.'),
      say(23, 'CUSTOMER', '아, 그래요? 알겠어요.'),
      say(26, 'AI', '더 궁금하신 점 있으실까요?'),
      say(29, 'CUSTOMER', '아니요, 됐어요.'),
      say(31, 'AI', '감사합니다. 좋은 하루 보내세요.'),
    ],
    actions: [
      act(9, 'SEARCH', '발신번호로 주문 검색 → 오늘 1건'),
      act(10, 'SEARCH', "FAQ 검색 '기사 도착 시간' → 0건"),
    ],
    results: [{ atSec: 4, kind: 'UNANSWERED', question: '기사님 오늘 몇 시쯤 도착하세요?' }],
  },
  // 9105 박지호 10.20 14:35 — 14:22에 접수한 10531(결제 전)을 취소만 하고 끊음
  {
    callSessionSeq: 9105,
    customerName: '박지호',
    outcome: 'CANCELLED',
    startedAt: t('14:35:20'),
    durationSec: 44,
    callerNumber: '01041832290',
    persona,
    complaints: [],
    utterances: [
      say(0, 'AI', '안녕하세요, 디버 택배 접수입니다. 무엇을 도와드릴까요?'),
      say(4, 'CUSTOMER', '아까 접수한 택배 취소하고 싶어요.'),
      say(9, 'AI', '오늘 오후 2시 22분에 접수하신, 조하은 님께 보내는 중박스 1개 맞으실까요?'),
      say(16, 'CUSTOMER', '네, 그거요.'),
      say(17, 'AI', '아직 결제 전이라 바로 취소할 수 있어요. 취소할까요?'),
      say(22, 'CUSTOMER', '네, 취소해 주세요.'),
      say(24, 'AI', '주문을 취소했습니다. 다시 보내실 때 전화 주세요.'),
      say(30, 'CUSTOMER', '네, 감사합니다.'),
      say(32, 'AI', '감사합니다. 좋은 하루 보내세요.'),
    ],
    actions: [
      act(8, 'SEARCH', '발신번호로 주문 검색 → 오늘 1건 (결제 대기)'),
      act(23, 'CANCEL', '주문 취소 (결제 전)'),
    ],
    results: [{ atSec: 23, kind: 'CANCELLED', orderSeq: 10531 }],
  },
]

const ORDERS: OrderDetail[] = [
  {
    orderSeq: 10519,
    route: 'PHONE',
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
    pickupRequestedAt: '2026-10-21T09:00:00+09:00',
    itemPrice: 30000,
    clientComment: '경비실에 맡겨 주세요',
    paymentMethod: 'MONTHLY',
    paymentState: 'PAID',
    relatedCalls: [{ callSessionSeq: 9101, startedAt: t('13:12:08'), kind: 'ACCEPT' }],
  },
  {
    orderSeq: 10531,
    route: 'PHONE',
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
    pickupRequestedAt: '2026-10-21T11:00:00+09:00',
    itemPrice: 50000,
    clientComment: null,
    paymentMethod: 'PERSONAL_CARD',
    paymentState: 'CANCELLED_BEFORE_PAYMENT',
    relatedCalls: [
      { callSessionSeq: 9103, startedAt: t('14:22:10'), kind: 'ACCEPT' }, // 접수 통화 — 가짜 데이터엔 없음
      { callSessionSeq: 9105, startedAt: t('14:35:20'), kind: 'CANCEL' },
    ],
  },
]
