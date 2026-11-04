// 04 통화 내역 Model — GET /calls (연동 명세 11/04 §3). React를 모르는 데이터 층
// 개발 중엔 MSW 가짜(mocks/handlers/calls.ts)가 같은 모양으로 응답. 서버 DTO → 화면 모양은 callDto.ts
// 11/04 디자인: 고른 날짜에서 시작하는 무한 스크롤 — 하루씩 받음. 아래로 = 더 지난 날(통화가 있는 날로 건너뜀), 위로 = 다음 날(오늘까지)
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query'
import { api, type ApiList } from '@/shared/api/client'
import { fetchAll } from '@/shared/api/paging'
import { addDays, kstDayStart, todayYmd, ymd, type Ymd } from '@/shared/lib/dateRange'
import { phoneDigits } from '@/shared/lib/search'
import { toCallRow, type CallListItemDto, type CallRow } from './callDto'

export type { CallKind, CallRow } from './callDto'

/** 오늘 통화 갱신 주기 — 새 통화 · 늦은 분석이 보이게 (11/02 연동 명세). 숨긴 탭에선 멈춤 */
export const LIST_REFRESH_MS = 5_000

/** 한 쪽 = 하루. day null = 더 지난 통화 없음 */
export interface DayPage {
  day: Ymd | null
  rows: CallRow[]
}
type DayParam = { day: Ymd } | { before: Ymd } | { after: Ymd }

/** 검색어 → q. 숫자만 쳤으면 번호로('010-1458' → '0101458' — 서버는 숫자만 저장) */
const toQ = (q: string) => {
  const t = q.trim()
  return (phoneDigits(t) || t).slice(0, 200) || undefined
}

/** 그날 통화 전부 (최신순, 100건씩 끝까지). 받는 사이 통화가 생기면 겹칠 수 있어 번호로 한 번 더 거름 */
async function fetchDay(day: Ymd, q: string, signal?: AbortSignal): Promise<CallRow[]> {
  const seen = new Set<number>()
  const query = { q: toQ(q), from: kstDayStart(day), to: kstDayStart(addDays(day, 1)) }
  return (await fetchAll<CallListItemDto>('/calls', query, signal))
    .filter((d) => !seen.has(d.callSessionSeq) && seen.add(d.callSessionSeq))
    .map(toCallRow)
}

/** day 전에 통화가 있는 가장 가까운 날 (최신 1건의 날짜 — 통화 없는 날은 건너뜀). 없으면 null */
async function prevCallDay(day: Ymd, q: string, signal?: AbortSignal): Promise<Ymd | null> {
  const res = await api.get<ApiList<CallListItemDto>>('/calls', {
    query: { q: toQ(q), to: kstDayStart(day), limit: 1, offset: 0 },
    signal,
  })
  const at = res.data[0]?.startedAt
  return at ? ymd(new Date(at)) : null
}

export const callListQueries = {
  all: () => ['calls', 'list'] as const,
  /** 날짜 하나(anchor)부터 하루씩. 다음 쪽 = 더 지난 날, 이전 쪽 = 다음 날(오늘까지, 빈 날도 한 쪽) */
  days: (anchor: Ymd, q: string) =>
    infiniteQueryOptions({
      queryKey: [...callListQueries.all(), 'days', anchor, q],
      initialPageParam: { day: anchor } as DayParam,
      queryFn: async ({ pageParam, signal }): Promise<DayPage> => {
        const day =
          'day' in pageParam
            ? pageParam.day
            : 'after' in pageParam
              ? addDays(pageParam.after, 1)
              : await prevCallDay(pageParam.before, q, signal)
        return { day, rows: day ? await fetchDay(day, q, signal) : [] }
      },
      getNextPageParam: (last): DayParam | undefined =>
        last.day ? { before: last.day } : undefined,
      getPreviousPageParam: (first): DayParam | undefined =>
        first.day && first.day < todayYmd() ? { after: first.day } : undefined,
      staleTime: 5 * 60_000, // 지난 날은 안 바뀜. 오늘은 아래 today가 따로 갱신
      // 검색어만 바뀌면(같은 날짜) 새 결과가 올 때까지 이전 목록을 그대로 — 칠 때마다 목록이 비었다 차지 않게
      placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[3] === anchor ? prev : undefined),
    }),
  /** 오늘 통화 — 5초마다 (목록에 오늘이 있을 때만 켬). 받으면 무한 목록의 오늘 쪽을 이걸로 바꿔 그림 */
  today: (q: string) =>
    queryOptions({
      queryKey: [...callListQueries.all(), 'today', q],
      queryFn: ({ signal }) => fetchDay(todayYmd(), q, signal),
      refetchInterval: LIST_REFRESH_MS,
      refetchOnWindowFocus: 'always', // 탭에 돌아오면 바로 (명세: 복귀 시 다시 조회)
    }),
}

// ---------- 상담가 (날짜 옆) — 07 페르소나 기능을 import하지 못해(기능끼리 import 금지) 필요한 만큼만 ----------
// 이름은 스크롤 따라 맨 위 통화의 상담가로 바뀜(통화 분석의 personaName). 고르면 그 상담가가 받은 가장 최근 통화로 이동 (11/04 사용자)
interface PersonaListDto {
  aiPersonaSeq: number
  headVersion: { name: string }
  activeVersion: unknown
}
export interface PersonaOption {
  personaSeq: number
  name: string
  inUse: boolean // 지금 통화를 받는 상담가
}

export const callPersonaQueries = {
  /** 키를 ['personas', …]에 둬서 07에서 바꾸면(['personas'] 무효화) 같이 새로 받음 */
  list: () =>
    queryOptions({
      queryKey: ['personas', 'call-options'],
      queryFn: async ({ signal }): Promise<PersonaOption[]> =>
        (await fetchAll<PersonaListDto>('/personas', {}, signal)).map((p) => ({
          personaSeq: p.aiPersonaSeq,
          name: p.headVersion.name,
          inUse: p.activeVersion !== null,
        })),
    }),
}

/** 그 상담가가 받은 가장 최근 통화 — 버전마다 최신 1건(aiPersonaVersionSeq 필터)을 받아 가장 늦은 것. 없으면 null */
export async function latestCallOf(
  personaSeq: number,
): Promise<{ callSessionSeq: number; day: Ymd } | null> {
  const versions = await fetchAll<{ aiPersonaVersionSeq: number }>(
    `/personas/${personaSeq}/versions`,
    {},
  )
  const hits = await Promise.all(
    versions.map(
      async (v) =>
        (
          await api.get<ApiList<CallListItemDto>>('/calls', {
            query: { aiPersonaVersionSeq: v.aiPersonaVersionSeq, limit: 1, offset: 0 },
          })
        ).data[0],
    ),
  )
  const latest = hits
    .filter((d): d is CallListItemDto => !!d?.startedAt)
    .sort((a, b) => Date.parse(b.startedAt!) - Date.parse(a.startedAt!))[0]
  return latest
    ? { callSessionSeq: latest.callSessionSeq, day: ymd(new Date(latest.startedAt!)) }
    : null
}
