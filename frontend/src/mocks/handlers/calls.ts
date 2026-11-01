import { http, HttpResponse } from 'msw'
import { API_BASE_URL } from '@/shared/api/client'
import { addDays, todayYmd, type Ymd } from '@/shared/lib/dateRange'
import { fmtDetailTime, fmtPhone } from '@/shared/lib/format'

// 가짜 통화 — 연동 상세명세 10/31 API-21~25 모양 그대로 (목록 · 상세 · 대화 · AI 동작 · 처리 결과)
// 장면 데이터는 features/call/api 에 있던 메모리 가짜를 그대로 옮긴 것 (와이어프레임 04 줄 + 06 세 장면). 아래 '명세 모양으로'에서 DTO로 바꿈
// 오늘 131통화 = 성공 96 · 실패 12 · 이관 5 · 주문 취소 1 · 문의 17, 불만 8 — 01 홈 · 02 대시보드가 total_count로 세는 숫자의 근원

// ---------- 장면 데이터용 옛 모양 (옮긴 코드가 그대로 돌아가게) ----------
type Outcome = 'HANDOFF' | 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'INQUIRY'
interface CallRow {
  callSessionSeq: number
  startedAt: string
  customerName: string
  callerNumber: string
  outcome: Outcome
  complaint: { kind: string; reason: string } | null
  durationSec: number
}
interface Complaint {
  kind: string
  reason: string
  fromSec: number
  toSec: number
}
interface Utterance {
  atSec: number
  speaker: 'AI' | 'CUSTOMER'
  text: string
}
/** AI 동작 '저장'이 채운 칸 → 읽기 쉬운 이름 (summaryText를 만들 때) */
const FIELD_LABEL = {
  'origin.name': '보내는 분 이름',
  'origin.phoneNumber': '보내는 분 전화번호',
  'origin.roadAddress': '보내는 분 주소',
  'origin.detailAddress': '보내는 분 상세주소',
  'destination.name': '받는 분 이름',
  'destination.phoneNumber': '받는 분 전화번호',
  'destination.roadAddress': '받는 분 주소',
  'destination.detailAddress': '받는 분 상세주소',
  pickupRequestedAt: '수거 희망 일시',
  parcels: '품목',
  itemPrice: '물품 가액',
  clientComment: '고객 요청 사항',
  paymentMethodType: '결제 방식',
} as const
type OrderField = keyof typeof FIELD_LABEL
type AiAction =
  | { atSec: number; kind: 'SAVE'; field: OrderField; value: string }
  | { atSec: number; kind: 'SEARCH' | 'CANCEL' | 'SEND'; text: string }
type ResultBlock =
  | { atSec: number; kind: 'ACCEPTED' | 'CANCELLED'; orderSeq: number }
  | { atSec: number; kind: 'UNANSWERED'; question: string }
interface CallDetail {
  callSessionSeq: number
  customerName: string
  outcome: Outcome
  startedAt: string
  durationSec: number
  callerNumber: string
  persona: { name: string; version: number }
  complaints: Complaint[]
  utterances: Utterance[]
  actions: AiAction[]
  results: ResultBlock[]
}

// ---------- 가짜 데이터: 오늘 131통화 + 지난 6일 ----------
// 날짜는 오늘 기준 (고정 날짜면 기본값 '오늘'에 아무것도 안 나옴). 시각 · 이름 · 결과는 와이어프레임 04 그대로
// 오늘 = 접수 성공 96 · 실패 12 · 이관 5 · 주문 취소 1 · 문의 17 (02 대시보드와 같은 숫자), 불만 8건 = 04 불만 통화 탭 8줄
// 06 가짜 장면이 있는 통화: 9101 강도윤 13:12 · 9104 (주)한빛상사 14:33 · 9105 박지호 14:35 (나머지 줄은 06에서 '찾을 수 없습니다')
const at = (day: Ymd, hm: string) => `${day}T${hm}:00+09:00`
const sec = (ms: string) => {
  const [m, s] = ms.split(':').map(Number)
  return m * 60 + s
}
type Fixed = [number, string, string, string, Outcome, string, [string, string]?]
const today = todayYmd()

const FIXED: Fixed[] = [
  [9110, '15:02', '강도윤', '01066382047', 'INQUIRY', '0:58'],
  [9109, '14:50', '윤재석', '01088123390', 'HANDOFF', '1:02'],
  [9105, '14:35', '박지호', '01041832290', 'CANCELLED', '0:44'],
  [9104, '14:33', '(주)한빛상사', '01055219032', 'INQUIRY', '1:10'],
  [9108, '14:31', '이서연', '01028174405', 'SUCCESS', '2:48'],
  [9107, '14:26', '(주)한빛상사', '01055219032', 'SUCCESS', '3:05'],
  [
    9103,
    '14:22',
    '박지호',
    '01041832290',
    'SUCCESS',
    '4:12',
    ['되묻기 반복', '같은 주소를 세 번 물었다고 말함'],
  ],
  [9106, '14:09', '연남베이커리', '01077241186', 'FAILED', '1:37'],
  [
    9102,
    '13:58',
    '정하은',
    '01033496021',
    'FAILED',
    '2:21',
    ['말이 빠름', '천천히 말해 달라고 두 번 요청'],
  ],
  [
    9101,
    '13:12',
    '강도윤',
    '01066382047',
    'SUCCESS',
    '3:40',
    ['되묻기 반복', '번호를 세 번 말하게 되자 짜증 냄'],
  ],
  [
    9111,
    '12:40',
    '윤서아',
    '01081573302',
    'HANDOFF',
    '2:05',
    ['못 알아들음', "'중간 박스'를 알아듣지 못함"],
  ],
  [
    9112,
    '11:47',
    '임준서',
    '01058031268',
    'SUCCESS',
    '3:58',
    ['답답함 · 느림', '대답이 늦다고 말함'],
  ],
  [
    9113,
    '11:05',
    '서지훈',
    '01058213307',
    'SUCCESS',
    '3:22',
    ['되묻기 반복', '상세주소를 두 번 다시 물음'],
  ],
  [
    9114,
    '10:31',
    '한소율',
    '01066041975',
    'SUCCESS',
    '2:47',
    ['말이 빠름', '요약을 다시 읽어 달라고 요청'],
  ],
  [
    9115,
    '09:47',
    '오민재',
    '01066271180',
    'HANDOFF',
    '0:52',
    ['AI라서 거부', '사람과 통화하겠다고 함'],
  ],
]

const NAMES = [
  '김서연',
  '이준호',
  '박민지',
  '최유진',
  '정우성',
  '(주)도담물류',
  '한지민',
  '오세훈',
  '신예린',
  '그린팜',
  '장동건',
  '윤하늘',
  '임수아',
  '(주)온누리전자',
  '조민혁',
  '배수지',
  '새봄치과',
  '홍길순',
  '권나래',
  '문태오',
]
// 결정적 가짜 난수 (새로고침해도 같은 목록)
let seed = 7
const rand = (n: number) => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed % n
}
const pad = (n: number) => String(n).padStart(2, '0')

/** 하루치 통화 n개를 09:00부터 span분 동안 흩어 만듦. outcomes 순서대로 결과를 줌 */
function makeDay(day: Ymd, outcomes: Outcome[], startId: number, span = 540): CallRow[] {
  return outcomes.map((outcome, i) => {
    const minute = 9 * 60 + Math.floor(((i + 0.5) * span) / outcomes.length)
    const dur =
      outcome === 'SUCCESS'
        ? 120 + rand(150)
        : outcome === 'INQUIRY'
          ? 40 + rand(60)
          : 50 + rand(80)
    return {
      callSessionSeq: startId + i,
      startedAt: at(day, `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`),
      customerName: NAMES[rand(NAMES.length)],
      callerNumber: `010${String(10000000 + rand(89999999)).padStart(8, '0')}`,
      outcome,
      complaint: null,
      durationSec: dur,
    }
  })
}

/** 결과 개수 → 섞인 결과 배열 */
const mix = (counts: Partial<Record<Outcome, number>>): Outcome[] => {
  const list = Object.entries(counts).flatMap(([o, n]) => Array<Outcome>(n ?? 0).fill(o as Outcome))
  for (let i = list.length - 1; i > 0; i--) {
    const j = rand(i + 1)
    ;[list[i], list[j]] = [list[j], list[i]]
  }
  return list
}

const ROWS: CallRow[] = [
  ...FIXED.map(([id, hm, name, phone, outcome, dur, complaint]) => ({
    callSessionSeq: id,
    startedAt: at(today, hm),
    customerName: name,
    callerNumber: phone,
    outcome,
    complaint: complaint ? { kind: complaint[0], reason: complaint[1] } : null,
    durationSec: sec(dur),
  })),
  // 오늘 나머지 116 = 성공 89 · 실패 10 · 이관 2 · 문의 15 (고정 15줄과 합쳐 131). 09:00 ~ 14:05 → 맨 위는 와이어프레임 줄(15:02 ~)
  ...makeDay(today, mix({ SUCCESS: 89, FAILED: 10, HANDOFF: 2, INQUIRY: 15 }), 9200, 305),
  // 지난 6일 (날짜 범위 확인용)
  ...[1, 2, 3, 4, 5, 6].flatMap((d) =>
    makeDay(
      addDays(today, -d),
      mix({ SUCCESS: 80 + d * 2, FAILED: 10, HANDOFF: 4, CANCELLED: 1, INQUIRY: 15 }),
      10000 + d * 1000,
    ),
  ),
]

// ---------- 가짜 데이터 = 와이어프레임 06 세 장면 (build_call_detail SCENES) ----------
const t = (hms: string) => `${todayYmd()}T${hms}+09:00`
const tomorrow = (hm: string) => `${addDays(todayYmd(), 1)}T${hm}:00+09:00`
const pickup = new Date(tomorrow('09:00')) // 강도윤이 말한 '내일 오전 9시'
const pickupSaid = `${pickup.getMonth() + 1}월 ${pickup.getDate()}일 ${'일월화수목금토'[pickup.getDay()]}요일 오전 9시`
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
    startedAt: t('13:12:00'), // = 목록(ROWS 13:12) 시각 — 상세 · 대화 · 09 미답변 · 주문 팝업이 같은 시각을 봄
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
      say(73, 'AI', `${pickupSaid} 맞으실까요?`),
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
      save(77, 'pickupRequestedAt', fmtDetailTime(tomorrow('09:00'))),
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
    startedAt: t('14:33:00'),
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
    startedAt: t('14:35:00'),
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

// ---------- 명세 모양으로 (DTO) ----------
const RESULT: Record<Outcome, string> = {
  SUCCESS: 'REGISTERED',
  FAILED: 'REGISTRATION_FAILED',
  HANDOFF: 'HANDOFF',
  CANCELLED: 'CANCELLED',
  INQUIRY: 'INQUIRY',
}
const COMPLAINT_TYPE: Record<string, string> = {
  '되묻기 반복': 'REPEATED_QUESTION',
  '말이 빠름': 'SPEAKING_TOO_FAST',
  '못 알아들음': 'RECOGNITION_FAILURE',
  '답답함 · 느림': 'SLOW_RESPONSE',
  'AI라서 거부': 'AI_REFUSAL',
}
const PERSONA_SEQ = 6 // 빠른 접수형 v6의 DB 번호 (07 가짜와 맞춤)
const UNANSWERED_SEQ: Record<number, number> = { 9101: 7019, 9104: 7008 } // 09 가짜 미답변 번호 (faq.ts UA_SEED 순서)
const iso = (s: string) => new Date(s).toISOString()
const plus = (s: string, sec: number) => new Date(Date.parse(s) + sec * 1000).toISOString()
const sceneOf = (id: number) => CALLS.find((c) => c.callSessionSeq === id)
const rowOf = (id: number) => ROWS.find((r) => r.callSessionSeq === id)

/** 통화 기본 (CallListItem · Call 공통 부분) */
function callOf(r: CallRow) {
  const scene = sceneOf(r.callSessionSeq)
  const order = scene?.results.find((x) => x.kind !== 'UNANSWERED')
  return {
    customerSeq: null,
    customerName: r.customerName,
    orderStatus: null,
    orderTotalAmount: null,
    callSessionSeq: r.callSessionSeq,
    providerCallId: `rtc_${r.callSessionSeq}`,
    callerPhoneNumber: r.callerNumber,
    orderSeq: order && 'orderSeq' in order ? order.orderSeq : null,
    startedAt: iso(r.startedAt),
    endedAt: plus(r.startedAt, r.durationSec),
    endReason: null,
    handoff:
      r.outcome === 'HANDOFF'
        ? {
            handoffRequestSeq: r.callSessionSeq,
            reason: '고객이 상담원 연결 요청',
            status: 'REQUESTED',
            assignedAdminUserSeq: null,
            summaryText: null,
            requestedAt: plus(r.startedAt, Math.max(0, r.durationSec - 5)),
          }
        : null,
  }
}

/** 분석 — 장면이 있으면 불만 구간(fromSec~toSec)을 발화 순번으로, 없으면 목록 줄의 불만 한 건 */
function analysisOf(r: CallRow) {
  const scene = sceneOf(r.callSessionSeq)
  const complaints = scene
    ? scene.complaints.map((c) => ({
        type: COMPLAINT_TYPE[c.kind] ?? 'REPEATED_QUESTION',
        evidenceText: c.reason,
        offsetSeconds: c.fromSec,
        utteranceOrders: scene.utterances
          .map((u, i) => (c.fromSec <= u.atSec && u.atSec <= c.toSec ? i + 1 : 0))
          .filter(Boolean),
      }))
    : r.complaint
      ? [
          {
            type: COMPLAINT_TYPE[r.complaint.kind] ?? 'REPEATED_QUESTION',
            evidenceText: r.complaint.reason,
            offsetSeconds: null,
            utteranceOrders: [],
          },
        ]
      : []
  return {
    result: RESULT[r.outcome],
    aiPersonaVersionSeq: PERSONA_SEQ,
    personaName: persona.name,
    personaVersion: persona.version,
    aiStartedAt: iso(r.startedAt),
    aiEndedAt: plus(r.startedAt, r.durationSec),
    repeatQuestionCount: complaints.some((c) => c.type === 'REPEATED_QUESTION') ? 3 : 0,
    hasComplaint: complaints.length > 0,
    complaints,
    analysedAt: plus(r.startedAt, r.durationSec + 20),
  }
}

/** 장면의 AI 동작 · 처리 결과를 통화 전체 순번(eventOrder) 하나로 */
function eventsOf(scene: CallDetail) {
  const startedAt = scene.startedAt
  const all = [
    ...scene.actions.map((a) => ({ at: a.atSec, action: a, result: null as ResultBlock | null })),
    ...scene.results.map((x) => ({ at: x.atSec, action: null as AiAction | null, result: x })),
  ].sort((a, b) => a.at - b.at)
  const base = (at: number, i: number) => ({
    eventId: `00000000-0000-4000-8000-${String(scene.callSessionSeq * 100 + i).padStart(12, '0')}`,
    eventOrder: i + 1,
    occurredAt: plus(startedAt, at),
    offsetSeconds: at,
  })
  const actions = all.flatMap((e, i) => {
    const a = e.action
    if (!a) return []
    const text =
      a.kind === 'SAVE'
        ? `${FIELD_LABEL[a.field]} = ${a.field.endsWith('phoneNumber') ? fmtPhone(a.value) : a.value}`
        : a.text
    const action =
      a.kind === 'SAVE'
        ? 'FIELD_SAVED'
        : a.kind === 'CANCEL'
          ? 'ORDER_CANCELLED'
          : a.kind === 'SEND'
            ? 'ORDER_SUBMITTED'
            : a.text.startsWith('FAQ')
              ? 'FAQ_SEARCH'
              : a.text.includes('주소')
                ? 'ADDRESS_SEARCH'
                : a.text.includes('주문')
                  ? 'PREVIOUS_ORDER_SEARCH'
                  : 'CUSTOMER_LOOKUP'
    return [{ ...base(e.at, i), summaryText: text, orderSeq: null, action }]
  })
  const results = all.flatMap((e, i) => {
    const x = e.result
    if (!x) return []
    const unanswered = x.kind === 'UNANSWERED'
    return [
      {
        ...base(e.at, i),
        summaryText: unanswered
          ? x.question
          : `${x.kind === 'ACCEPTED' ? '주문 접수' : '주문 취소'} (${x.orderSeq})`,
        orderSeq: unanswered ? null : x.orderSeq,
        action: unanswered
          ? 'QUESTION_UNANSWERED'
          : x.kind === 'ACCEPTED'
            ? 'ORDER_CREATED'
            : 'ORDER_CANCELLED',
        unansweredQuestionSeq: unanswered ? (UNANSWERED_SEQ[scene.callSessionSeq] ?? null) : null,
        questionText: unanswered ? x.question : null,
        answerText: null,
        faqEntrySeq: null,
        questionUtteranceOrder: null,
        answerUtteranceOrder: null,
      },
    ]
  })
  const utterances = scene.utterances.map((u, i) => ({
    callUtteranceSeq: scene.callSessionSeq * 1000 + i + 1,
    utteranceOrder: i + 1,
    speaker: u.speaker,
    utteranceText: u.text,
    lastSentenceSeq: 1,
    receivedAt: plus(startedAt, u.atSec),
    offsetSeconds: u.atSec,
  }))
  return { actions, results, utterances }
}

const pageOf = <T>(items: T[], url: URL) => {
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 20)))
  const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0))
  return {
    data: items.slice(offset, offset + limit),
    hasNext: offset + limit < items.length,
    total_count: items.length,
  }
}
const notFound = () =>
  HttpResponse.json(
    { error: { code: 'NOT_FOUND', message: '해당 통화 기록이 없습니다.', details: [] } },
    { status: 404 },
  )
const meta = () => ({ requestId: crypto.randomUUID() })
const SORTED = [...ROWS].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)) // PBX 시작 최신순

export const callHandlers = [
  // API-21 — q(이름 · 번호 부분 일치) · result · hasComplaint · aiPersonaVersionSeq · orderSeq · from(포함)/to(미포함)
  http.get(`${API_BASE_URL}/calls`, ({ request }) => {
    const url = new URL(request.url)
    const p = (k: string) => url.searchParams.get(k)
    const q = (p('q') ?? '').trim().toLowerCase()
    const result = p('result')
    const hasComplaint = p('hasComplaint')
    const personaSeq = p('aiPersonaVersionSeq')
    const orderSeq = p('orderSeq')
    const from = p('from')
    const to = p('to')
    const hit = SORTED.filter((r) => {
      const t = Date.parse(r.startedAt)
      const a = analysisOf(r)
      return (
        (!q || r.customerName.toLowerCase().includes(q) || r.callerNumber.includes(q)) &&
        (!result || a.result === result) &&
        (hasComplaint === null || String(a.hasComplaint) === hasComplaint) &&
        (!personaSeq || Number(personaSeq) === PERSONA_SEQ) &&
        (!orderSeq || callOf(r).orderSeq === Number(orderSeq)) &&
        (!from || t >= Date.parse(from)) &&
        (!to || t < Date.parse(to))
      )
    })
    return HttpResponse.json(
      pageOf(
        hit.map((r) => ({ ...callOf(r), analysis: analysisOf(r) })),
        url,
      ),
    )
  }),
  // API-22 — data.call · data.analysis · data.recordings(가짜엔 녹취 파일이 없어 빈 배열) · data.aiActionCount
  http.get(`${API_BASE_URL}/calls/:id`, ({ params }) => {
    const r = rowOf(Number(params.id))
    if (!r) return notFound()
    const scene = sceneOf(r.callSessionSeq)
    return HttpResponse.json({
      data: {
        call: callOf(r),
        analysis: analysisOf(r),
        aiActionCount: scene ? scene.actions.length : 0,
        recordings: [],
      },
      meta: meta(),
    })
  }),
  // API-23 · 24 · 25 — 장면이 없는 통화는 빈 목록 (무음이 아니라 미수집)
  http.get(`${API_BASE_URL}/calls/:id/transcript`, ({ request, params }) => {
    const scene = sceneOf(Number(params.id))
    if (!rowOf(Number(params.id))) return notFound()
    return HttpResponse.json(pageOf(scene ? eventsOf(scene).utterances : [], new URL(request.url)))
  }),
  http.get(`${API_BASE_URL}/calls/:id/actions`, ({ request, params }) => {
    const scene = sceneOf(Number(params.id))
    if (!rowOf(Number(params.id))) return notFound()
    return HttpResponse.json(pageOf(scene ? eventsOf(scene).actions : [], new URL(request.url)))
  }),
  http.get(`${API_BASE_URL}/calls/:id/processing-results`, ({ request, params }) => {
    const scene = sceneOf(Number(params.id))
    if (!rowOf(Number(params.id))) return notFound()
    return HttpResponse.json(pageOf(scene ? eventsOf(scene).results : [], new URL(request.url)))
  }),
]
