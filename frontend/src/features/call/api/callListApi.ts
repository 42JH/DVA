// 04 통화 내역 Model — 통화 목록. 검색 · 날짜 · 통화 결과 · 불만으로 거르고 쪽을 나눠 { items, totalCount }. React를 모르는 데이터 층
// 명세 초안 CALL-07에 고객 이름 · 통화 결과 · 불만 · totalCount가 없음 → BE가 명세를 짜서 주기로 함 (10/30)
// 지금은 네트워크 없이 메모리 가짜 데이터 — 서버가 할 거르기 · 쪽 나누기도 여기서 흉내. 명세가 오면 fetchCalls · fetchAllCalls 몸통만 바꾸면 됨
import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import { addDays, todayYmd, ymd, type Ymd } from '@/shared/lib/dateRange'
import type { Outcome } from './callApi'

export interface CallRow {
  callSessionSeq: number
  startedAt: string // ISO 8601
  customerName: string
  callerNumber: string // 숫자만
  outcome: Outcome
  complaint: { kind: string; reason: string } | null
  durationSec: number
}

export interface CallListQuery {
  q: string // 이름 · 전화번호
  from: Ymd // 포함
  to: Ymd // 포함 (서버로 보낼 땐 다음 날 미포함으로 — 명세 1.2)
  outcome: Outcome | 'ALL'
  complaintOnly: boolean // [불만 통화] 탭
}

export const callListQueries = {
  all: () => ['calls', 'list'] as const,
  list: (query: CallListQuery, page: number, size: number) =>
    queryOptions({
      queryKey: [...callListQueries.all(), query, page, size],
      queryFn: () => fetchCalls(query, page, size),
      placeholderData: keepPreviousData, // 쪽 · 필터를 바꾸는 동안 이전 목록을 그대로 (표가 깜빡이지 않게)
    }),
}

const wait = () => new Promise((r) => setTimeout(r, 200)) // 가짜 응답 지연 ('불러오는 중' 확인용)

/** 조건에 맞는 통화, 최신순 (서버가 할 일) */
function filtered(query: CallListQuery): CallRow[] {
  const needle = query.q.trim().toLowerCase()
  const digits = query.q.replace(/\D/g, '')
  return ROWS.filter((r) => {
    const day = ymd(new Date(r.startedAt))
    return (
      day >= query.from &&
      day <= query.to &&
      (query.outcome === 'ALL' || r.outcome === query.outcome) &&
      (!query.complaintOnly || r.complaint !== null) &&
      (!needle ||
        r.customerName.toLowerCase().includes(needle) ||
        (digits !== '' && r.callerNumber.includes(digits)))
    )
  }).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
}

export async function fetchCalls(
  query: CallListQuery,
  page: number,
  size: number,
): Promise<{ items: CallRow[]; totalCount: number }> {
  await wait()
  const all = filtered(query)
  return { items: all.slice((page - 1) * size, page * size), totalCount: all.length }
}

/** CSV 내보내기 — 지금 조건의 전체 쪽 */
export async function fetchAllCalls(query: CallListQuery): Promise<CallRow[]> {
  await wait()
  return filtered(query)
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
