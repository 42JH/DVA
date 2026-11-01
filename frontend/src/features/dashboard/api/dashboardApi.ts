// 02 대시보드 Model — 통계 API가 없음(연동 상세명세 10/31 §10) → 목록의 total_count를 조합해 건수만 셈. React를 모르는 데이터 층
//   통화: API-21 GET /calls (result · hasComplaint · aiPersonaVersionSeq · from/to) / 미답변: API-26 / 버전: API-60 · 64 (최고 관리자 전용)
//   평균 통화 시간 · 되묻기는 줄 수 없음 → 화면에서 '집계 API 없음' (성공하는 척 금지, §10)
// 개발 중엔 MSW 가짜(mocks/handlers/calls.ts · faq.ts · personas.ts)가 같은 모양으로 응답
import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import { api, type ApiList } from '@/shared/api/client'
import { fetchAll } from '@/shared/api/paging'
import { addDays, kstDayStart, ymd, type Ymd } from '@/shared/lib/dateRange'

/** 통화 결과 (04 · 06과 같은 5개). feature끼리 import 금지라 여기 따로 둠 */
export type Outcome = 'SUCCESS' | 'FAILED' | 'HANDOFF' | 'CANCELLED' | 'INQUIRY'
/** 불만 유형 — 서버 CallComplaint.type 그대로 */
export type ComplaintKind =
  'REPEATED_QUESTION' | 'SPEAKING_TOO_FAST' | 'RECOGNITION_FAILURE' | 'SLOW_RESPONSE' | 'AI_REFUSAL'
const OUTCOMES: Outcome[] = ['SUCCESS', 'FAILED', 'HANDOFF', 'CANCELLED', 'INQUIRY']
/** 버전별 기록 표의 세 결과 (= 게이지) */
export type GaugeOutcome = 'SUCCESS' | 'FAILED' | 'HANDOFF'
export const GAUGE: GaugeOutcome[] = ['SUCCESS', 'FAILED', 'HANDOFF']
const RESULT: Record<Outcome, string> = {
  SUCCESS: 'REGISTERED',
  FAILED: 'REGISTRATION_FAILED',
  HANDOFF: 'HANDOFF',
  CANCELLED: 'CANCELLED',
  INQUIRY: 'INQUIRY',
}
const KINDS: ComplaintKind[] = [
  'REPEATED_QUESTION',
  'SPEAKING_TOO_FAST',
  'RECOGNITION_FAILURE',
  'SLOW_RESPONSE',
  'AI_REFUSAL',
]

/** 그 범위(기간 또는 버전)의 통화 건수 */
export interface Stats {
  total: number // 결과 필터 없는 전체 (분석이 아직 안 온 통화도 포함) = 04 '전체'와 같은 수
  counts: Record<Outcome, number>
  complaintCalls: number // 불만이 확인된 통화 수 (analysis.complaints 가 있는 통화)
  complaints: Record<ComplaintKind, number> // 유형별 — 한 통화에 여러 유형이면 각각 셈 (합 ≥ complaintCalls)
  // 평균 통화 시간(초) — 통계 API가 없어 목록의 startedAt · endedAt 으로 화면에서 냄 (11/01 사용자). 통화가 없으면 null
  avgDurationSec: number | null
  avgBy: Record<GaugeOutcome, number | null> // 결과별 평균 (접수 성공 · 실패 · 이관)
  avgSampled: boolean // 목록을 2,000건까지만 받아서 평균을 냈음 (fetchAll 상한) → 화면에 '최근 2,000건 기준'
  avgRepeat: number | null // 평균 되묻기 횟수 = analysis.repeatQuestionCount 의 평균 (측정된 통화만, 없으면 null)
  unanswered: { count: number; recent: { at: string; question: string }[] } // 처리 안 된(OPEN) 질문, 최신순 (날짜별 8개 · 페르소나별 6개)
}

export interface Version {
  id: string // aiPersonaVersionSeq (서버 DB 번호 — 화면 'v6'의 6과 다를 수 있음)
  personaName: string
  version: number
  active: boolean
  from: Ymd // 적용된 날
  to: Ymd | null // 다음 버전이 적용된 날 (적용 중이면 null)
  counts: Record<GaugeOutcome, number> // 표의 통화 · 성공 · 실패 · 이관
}

export const dashboardQueries = {
  all: () => ['dashboard'] as const,
  stats: (from: Ymd, to: Ymd) =>
    queryOptions({
      queryKey: [...dashboardQueries.all(), 'stats', from, to],
      queryFn: ({ signal }) => fetchDashboard(from, to, signal),
      placeholderData: keepPreviousData, // 날짜를 바꿔도 이전 카드가 남아 '불러오는 중'으로 깜빡이지 않음 (04와 같음)
    }),
  versions: () =>
    queryOptions({
      queryKey: [...dashboardQueries.all(), 'versions'],
      queryFn: ({ signal }) => fetchVersions(signal),
    }),
  versionStats: (id: string) =>
    queryOptions({
      queryKey: [...dashboardQueries.all(), 'version', id],
      queryFn: ({ signal }) => fetchVersionStats(id, signal),
      placeholderData: keepPreviousData,
    }),
}

type Query = Record<string, string | number | boolean | undefined>
/** 1건만 받아 total_count (검색 · 필터 후 전체 건수) */
async function count(path: string, query: Query, signal?: AbortSignal): Promise<number> {
  return (
    await api.get<ApiList<unknown>>(path, { query: { ...query, limit: 1, offset: 0 }, signal })
  ).total_count
}

/** 목록 한 줄에서 쓰는 것만 (API-21 CallListItem) */
interface CallRowDto {
  callSessionSeq: number
  startedAt: string | null
  endedAt: string | null
  analysis: {
    result: string
    repeatQuestionCount: number | null
    complaints: { type: ComplaintKind }[]
  } | null
}
const RESULT_OF: Record<string, GaugeOutcome> = {
  REGISTERED: 'SUCCESS',
  REGISTRATION_FAILED: 'FAILED',
  HANDOFF: 'HANDOFF',
}
const durationSec = (r: CallRowDto) =>
  r.startedAt && r.endedAt ? (Date.parse(r.endedAt) - Date.parse(r.startedAt)) / 1000 : null
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
interface UnansweredDto {
  callStartedAt: string | null
  occurredAt: string
  questionText: string
}

/** 범위 하나의 건수들 — 통화 1 + 결과 5 + 불만 목록 + 미답변 1~2 요청. recent = 미답변 카드 줄 수 */
async function statsOf(
  calls: Query,
  unanswered: Query,
  signal?: AbortSignal,
  recent = 8,
): Promise<Stats> {
  const [total, ...byResult] = await Promise.all([
    count('/calls', calls, signal),
    ...OUTCOMES.map((o) => count('/calls', { ...calls, result: RESULT[o] }, signal)),
  ])
  // 범위의 통화 목록을 다 받아 불만 유형과 평균 통화 시간을 셈 (하루 ~130건 = 2요청. ponytail: 2,000건 상한 — 넘으면 '최근 2,000건 기준')
  const rows = await fetchAll<CallRowDto>('/calls', calls, signal)
  const complaints = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<ComplaintKind, number>
  let complaintCalls = 0
  for (const r of rows) {
    const kinds = new Set((r.analysis?.complaints ?? []).map((c) => c.type))
    if (kinds.size) complaintCalls++
    for (const k of kinds) if (k in complaints) complaints[k]++
  }
  const secsOf = (pick: (r: CallRowDto) => boolean) =>
    rows
      .filter(pick)
      .map(durationSec)
      .filter((s): s is number => s !== null && s >= 0)
  const avgBy = Object.fromEntries(
    GAUGE.map((o) => [o, avg(secsOf((r) => RESULT_OF[r.analysis?.result ?? ''] === o))]),
  ) as Record<GaugeOutcome, number | null>
  // 미답변: 서버가 오래된 순이라 끝 recent개를 받아 뒤집음
  const first = await api.get<ApiList<UnansweredDto>>('/unanswered-questions', {
    query: { ...unanswered, limit: recent, offset: 0 },
    signal,
  })
  const tail =
    first.total_count > recent
      ? (
          await api.get<ApiList<UnansweredDto>>('/unanswered-questions', {
            query: { ...unanswered, limit: recent, offset: first.total_count - recent },
            signal,
          })
        ).data
      : first.data
  return {
    total,
    counts: Object.fromEntries(OUTCOMES.map((o, i) => [o, byResult[i]])) as Record<Outcome, number>,
    complaintCalls,
    complaints,
    avgDurationSec: avg(secsOf(() => true)),
    avgBy,
    avgSampled: rows.length < total,
    avgRepeat: avg(
      rows
        .map((r) => r.analysis?.repeatQuestionCount ?? null)
        .filter((n): n is number => n !== null),
    ),
    unanswered: {
      count: first.total_count,
      recent: [...tail]
        .reverse()
        .map((u) => ({ at: u.callStartedAt ?? u.occurredAt, question: u.questionText })),
    },
  }
}

/** 기간 집계 (from · to 포함 → 서버엔 KST 자정 · to 미포함으로) */
export function fetchDashboard(from: Ymd, to: Ymd, signal?: AbortSignal): Promise<Stats> {
  const bounds = { from: kstDayStart(from), to: kstDayStart(addDays(to, 1)) }
  return statsOf(bounds, bounds, signal)
}

interface PersonaVersionDto {
  aiPersonaSeq: number
  aiPersonaVersionSeq: number
  version: number
  name: string
  status: 'ACTIVE' | 'PENDING' | 'INACTIVE'
  appliedAt: string | null
}
interface PersonaDto {
  aiPersonaSeq: number
}

/** 버전별 기록 — 적용된 적 있는 버전(appliedAt 있음)만, 최근 적용 순 3개. 운영 기간 = 적용일 ~ 다음 버전 적용일 (명세에 기간 필드 없음)
 * API-60 · 64는 최고 관리자 전용 — 훅이 isSystemAdmin일 때만 부름 */
export async function fetchVersions(signal?: AbortSignal): Promise<Version[]> {
  const personas = await fetchAll<PersonaDto>('/personas', {}, signal)
  const versions = (
    await Promise.all(
      personas.map((p) =>
        fetchAll<PersonaVersionDto>(`/personas/${p.aiPersonaSeq}/versions`, {}, signal),
      ),
    )
  ).flat()
  const top = pickVersions(versions).slice(0, 3)
  const counts = await Promise.all(top.map((v) => fetchVersionCounts(v.id, signal)))
  return top.map((v, i) => ({ ...v, counts: counts[i] }))
}

/** 순수 함수 (dashboardApi.test.ts) — 적용된 버전을 최근 적용 순으로, 기간은 사슬로 */
export function pickVersions(versions: PersonaVersionDto[]): Omit<Version, 'counts'>[] {
  const applied = versions
    .filter((v): v is PersonaVersionDto & { appliedAt: string } => v.appliedAt !== null)
    .sort((a, b) => Date.parse(b.appliedAt) - Date.parse(a.appliedAt))
  return applied.map((v, i) => ({
    id: String(v.aiPersonaVersionSeq),
    personaName: v.name,
    version: v.version,
    active: v.status === 'ACTIVE',
    from: ymd(new Date(v.appliedAt)),
    to: v.status === 'ACTIVE' || i === 0 ? null : ymd(new Date(applied[i - 1].appliedAt)),
  }))
}

/** 고른 버전의 건수 (그 버전이 받은 통화 전체 — 기간 제한 없음). 미답변 6줄 (10/29 노트 — 8줄이면 1024 화면에서 스크롤) */
export async function fetchVersionStats(id: string, signal?: AbortSignal): Promise<Stats> {
  const q = { aiPersonaVersionSeq: Number(id) }
  return statsOf(q, q, signal, 6)
}

/** 버전별 기록 표의 결과 건수 (버전마다 게이지 결과 3개 = 3요청) */
async function fetchVersionCounts(
  id: string,
  signal?: AbortSignal,
): Promise<Record<GaugeOutcome, number>> {
  const q = { aiPersonaVersionSeq: Number(id) }
  const n = await Promise.all(
    GAUGE.map((o) => count('/calls', { ...q, result: RESULT[o] }, signal)),
  )
  return Object.fromEntries(GAUGE.map((o, i) => [o, n[i]])) as Record<GaugeOutcome, number>
}
