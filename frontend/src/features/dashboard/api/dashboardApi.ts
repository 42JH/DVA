// 02 대시보드 Model — 기간 집계 · 버전별 기록. React를 모르는 데이터 층
// 명세 OPS-01은 주문 수 · 평균 상담 시간뿐 (통화 결과별 수 · 결과별 평균 · 되묻기 · 불만 · 미답변 · 버전 집계 없음) → BE가 명세를 짜서 주기로 함 (10/30)
// 지금은 네트워크 없이 메모리 가짜 데이터. 명세가 오면 fetchDashboard · fetchVersions · fetchVersionStats 몸통만 바꾸면 됨
import { queryOptions } from '@tanstack/react-query'
import { addDays, rangeDays, todayYmd, type Ymd } from '@/shared/lib/dateRange'

/** 통화 결과 (04 · 06과 같은 5개). feature끼리 import 금지라 여기 따로 둠 */
export type Outcome = 'SUCCESS' | 'FAILED' | 'HANDOFF' | 'CANCELLED' | 'INQUIRY'
export type ComplaintKind = 'REPEAT' | 'TOO_FAST' | 'MISHEARD' | 'SLOW' | 'REFUSED_AI'

/** 그 범위(기간 또는 버전)의 통화 집계 */
export interface Stats {
  counts: Record<Outcome, number>
  avgCallSec: number
  avgCallSecBy: { success: number; failed: number } // 게이지의 두 결과 통화만의 평균
  avgRepeat: number
  avgRepeatBy: { success: number; failed: number }
  complaints: Record<ComplaintKind, number>
  unanswered: { count: number; recent: { at: string; question: string }[] } // 최신순, 최대 8개
}

export interface Version {
  id: string // 'v6'
  personaName: string
  version: number
  active: boolean
  from: Ymd
  to: Ymd | null // 적용 중이면 null
  counts: Record<Outcome, number>
  avgCallSec: number
  avgRepeat: number
}

export const dashboardQueries = {
  all: () => ['dashboard'] as const,
  stats: (from: Ymd, to: Ymd) =>
    queryOptions({
      queryKey: [...dashboardQueries.all(), 'stats', from, to],
      queryFn: () => fetchDashboard(from, to),
    }),
  versions: () =>
    queryOptions({
      queryKey: [...dashboardQueries.all(), 'versions'],
      queryFn: fetchVersions,
    }),
  versionStats: (id: string) =>
    queryOptions({
      queryKey: [...dashboardQueries.all(), 'version', id],
      queryFn: () => fetchVersionStats(id),
    }),
}

const wait = () => new Promise((r) => setTimeout(r, 200)) // 가짜 응답 지연 ('불러오는 중' 확인용)

/** 기간 집계 (from · to 포함) — 날마다 집계를 더하고, 평균은 통화 수로 가중 */
export async function fetchDashboard(from: Ymd, to: Ymd): Promise<Stats> {
  await wait()
  const days = Array.from({ length: rangeDays(from, to) }, (_, i) => dayStats(addDays(from, i)))
  return merge(days)
}

/** 버전별 기록 — 최신 버전부터 최근 3개 (더 오래된 건 07 버전 히스토리) */
export async function fetchVersions(): Promise<Version[]> {
  await wait()
  return VERSIONS
}

/** 고른 버전의 아래 두 카드 (그 버전이 받은 통화 전체) */
export async function fetchVersionStats(id: string): Promise<Stats> {
  await wait()
  const v = VERSION_STATS[id]
  if (!v) throw new Error('버전을 찾을 수 없습니다.')
  return v
}

// ---------- 가짜 데이터 ----------
// 날짜는 오늘 기준. 오늘 = 04 통화 내역 가짜와 같은 숫자(131 = 96 · 12 · 5 · 1 · 17, 불만 8),
// 지난 날 = 04 가짜와 같은 규칙(성공 80 + 2d · 실패 10 · 이관 4 · 취소 1 · 문의 15) → 기간을 넓혀도 04 목록 건수와 맞음
const zeroComplaints = (): Record<ComplaintKind, number> => ({
  REPEAT: 0,
  TOO_FAST: 0,
  MISHEARD: 0,
  SLOW: 0,
  REFUSED_AI: 0,
})
const at = (day: Ymd, hm: string) => `${day}T${hm}:00+09:00`

// 오늘 AI 미답변 = 와이어프레임 02 오늘 목록 7줄 (09:47 반품 질문은 이미 FAQ로 추가돼 09 큐엔 없음 — 대시보드는 그 기간에 생긴 것 전부)
const TODAY_UA: [string, string][] = [
  ['14:33', '기사님 오늘 몇 시쯤 도착하세요?'],
  ['13:13', '착불로 보내면 받는 사람이 얼마 내요?'],
  ['13:05', '주말에도 수거 와요?'],
  ['12:48', '제주까지는 며칠 걸려요?'],
  ['12:48', '제주도로 보내면 추가 요금이 얼마나 붙어요?'],
  ['11:52', '문자를 다른 번호로 다시 보내 줄 수 있어요?'],
  ['09:47', '반품도 전화로 접수돼요?'],
]
const PAST_UA = [
  '박스를 따로 살 수 있나요?',
  '해외로도 보낼 수 있어요?',
  '포장 박스에 주소를 직접 써야 돼요?',
  '경비실에 맡겨 두면 가져가 주시나요?',
  '카드 말고 계좌이체로 해도 돼요?',
]

function dayStats(day: Ymd): Stats {
  const d = rangeDays(day, todayYmd()) - 1 // 오늘 = 0, 어제 = 1 …
  if (d === 0)
    return {
      counts: { SUCCESS: 96, FAILED: 12, HANDOFF: 5, CANCELLED: 1, INQUIRY: 17 },
      avgCallSec: 171,
      avgCallSecBy: { success: 192, failed: 85 },
      avgRepeat: 1.3,
      avgRepeatBy: { success: 1.1, failed: 2.4 },
      complaints: { REPEAT: 3, TOO_FAST: 2, MISHEARD: 1, SLOW: 1, REFUSED_AI: 1 },
      unanswered: {
        count: TODAY_UA.length,
        recent: TODAY_UA.map(([hm, q]) => ({ at: at(day, hm), question: q })),
      },
    }
  if (d < 0 || d > 6) return empty() // 오늘 이후 · 7일보다 옛날은 통화 없음 (04 가짜 목록과 같은 범위)
  const complaints = zeroComplaints()
  ;(['REPEAT', 'TOO_FAST', 'MISHEARD'] as const).forEach((k, i) => (complaints[k] = (d + i) % 3))
  return {
    counts: { SUCCESS: 80 + 2 * d, FAILED: 10, HANDOFF: 4, CANCELLED: 1, INQUIRY: 15 },
    avgCallSec: 160 + d * 2,
    avgCallSecBy: { success: 180 + d, failed: 80 + d },
    avgRepeat: 1.4,
    avgRepeatBy: { success: 1.2, failed: 2.6 },
    complaints,
    unanswered: {
      count: 4,
      recent: [17, 15, 13, 10].map((h, i) => ({
        at: at(day, `${h}:${String(10 + i * 11).padStart(2, '0')}`),
        question: PAST_UA[(d + i) % PAST_UA.length],
      })),
    },
  }
}

function empty(): Stats {
  return {
    counts: { SUCCESS: 0, FAILED: 0, HANDOFF: 0, CANCELLED: 0, INQUIRY: 0 },
    avgCallSec: 0,
    avgCallSecBy: { success: 0, failed: 0 },
    avgRepeat: 0,
    avgRepeatBy: { success: 0, failed: 0 },
    complaints: zeroComplaints(),
    unanswered: { count: 0, recent: [] },
  }
}

function merge(days: Stats[]): Stats {
  const out = empty()
  let calls = 0
  let success = 0
  let failed = 0
  for (const s of days) {
    const n = Object.values(s.counts).reduce((a, b) => a + b, 0)
    for (const k of Object.keys(out.counts) as Outcome[]) out.counts[k] += s.counts[k]
    for (const k of Object.keys(out.complaints) as ComplaintKind[])
      out.complaints[k] += s.complaints[k]
    out.avgCallSec += s.avgCallSec * n
    out.avgRepeat += s.avgRepeat * n
    out.avgCallSecBy.success += s.avgCallSecBy.success * s.counts.SUCCESS
    out.avgCallSecBy.failed += s.avgCallSecBy.failed * s.counts.FAILED
    out.avgRepeatBy.success += s.avgRepeatBy.success * s.counts.SUCCESS
    out.avgRepeatBy.failed += s.avgRepeatBy.failed * s.counts.FAILED
    out.unanswered.count += s.unanswered.count
    out.unanswered.recent.push(...s.unanswered.recent)
    calls += n
    success += s.counts.SUCCESS
    failed += s.counts.FAILED
  }
  const avg = (sum: number, n: number) => (n ? sum / n : 0)
  out.avgCallSec = Math.round(avg(out.avgCallSec, calls))
  out.avgRepeat = Math.round(avg(out.avgRepeat, calls) * 10) / 10
  out.avgCallSecBy = {
    success: Math.round(avg(out.avgCallSecBy.success, success)),
    failed: Math.round(avg(out.avgCallSecBy.failed, failed)),
  }
  out.avgRepeatBy = {
    success: Math.round(avg(out.avgRepeatBy.success, success) * 10) / 10,
    failed: Math.round(avg(out.avgRepeatBy.failed, failed) * 10) / 10,
  }
  out.unanswered.recent = out.unanswered.recent
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, 8)
  return out
}

// 버전별 기록 = 와이어프레임 02 페르소나별 (v6 적용 중 10.02 ~, v5 · v4는 끝난 버전). 운영 기간은 고정 날짜
const VERSIONS: Version[] = [
  {
    id: 'v6',
    personaName: '빠른 접수형',
    version: 6,
    active: true,
    from: '2026-10-02',
    to: null,
    counts: { SUCCESS: 1689, FAILED: 212, HANDOFF: 86, CANCELLED: 9, INQUIRY: 312 },
    avgCallSec: 173,
    avgRepeat: 1.4,
  },
  {
    id: 'v5',
    personaName: '빠른 접수형',
    version: 5,
    active: false,
    from: '2026-09-17',
    to: '2026-10-02',
    counts: { SUCCESS: 1205, FAILED: 173, HANDOFF: 78, CANCELLED: 7, INQUIRY: 251 },
    avgCallSec: 178,
    avgRepeat: 1.5,
  },
  {
    id: 'v4',
    personaName: '빠른 접수형',
    version: 4,
    active: false,
    from: '2026-09-01',
    to: '2026-09-17',
    counts: { SUCCESS: 932, FAILED: 149, HANDOFF: 66, CANCELLED: 5, INQUIRY: 198 },
    avgCallSec: 184,
    avgRepeat: 1.6,
  },
]

const versionStats = (
  v: Version,
  complaints: [number, number, number, number, number],
  unansweredCount: number,
  questions: [string, string][],
): Stats => ({
  counts: v.counts,
  avgCallSec: v.avgCallSec,
  avgCallSecBy: { success: v.avgCallSec + 20, failed: v.avgCallSec - 90 },
  avgRepeat: v.avgRepeat,
  avgRepeatBy: { success: v.avgRepeat - 0.2, failed: v.avgRepeat + 1.1 },
  complaints: {
    REPEAT: complaints[0],
    TOO_FAST: complaints[1],
    MISHEARD: complaints[2],
    SLOW: complaints[3],
    REFUSED_AI: complaints[4],
  },
  unanswered: {
    count: unansweredCount,
    recent: questions.map(([day, q]) => ({ at: `${day}T12:00:00+09:00`, question: q })),
  },
})
const today = todayYmd()
const VERSION_STATS: Record<string, Stats> = {
  v6: versionStats(VERSIONS[0], [34, 19, 12, 10, 6], 84, [
    [today, '기사님 오늘 몇 시쯤 도착하세요?'],
    [today, '착불로 보내면 받는 사람이 얼마 내요?'],
    [today, '주말에도 수거 와요?'],
    [today, '제주까지는 며칠 걸려요?'],
    [today, '제주도로 보내면 추가 요금이 얼마나 붙어요?'],
    [today, '문자를 다른 번호로 다시 보내 줄 수 있어요?'],
    [addDays(today, -1), '박스를 따로 살 수 있나요?'],
    [addDays(today, -2), '해외로도 보낼 수 있어요?'],
  ]),
  v5: versionStats(VERSIONS[1], [29, 17, 10, 8, 5], 71, [
    ['2026-10-01', '포장 박스에 주소를 직접 써야 돼요?'],
    ['2026-09-28', '경비실에 맡겨 두면 가져가 주시나요?'],
    ['2026-09-24', '카드 말고 계좌이체로 해도 돼요?'],
    ['2026-09-19', '반품도 전화로 접수돼요?'],
  ]),
  v4: versionStats(VERSIONS[2], [25, 15, 9, 7, 4], 66, [
    ['2026-09-15', '세금계산서 발행돼요?'],
    ['2026-09-09', '영수증 같은 거 문자로 받을 수 있나요?'],
    ['2026-09-03', '매주 같은 시간에 수거 오게 예약할 수 있어요?'],
  ]),
}
