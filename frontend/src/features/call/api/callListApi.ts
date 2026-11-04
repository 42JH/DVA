// 04 통화 내역 Model — GET /calls (연동 명세 11/04 §3). React를 모르는 데이터 층
// 개발 중엔 MSW 가짜(mocks/handlers/calls.ts)가 같은 모양으로 응답. 서버 DTO → 화면 모양은 callDto.ts
// 11/04 디자인: 고른 날짜에서 시작하는 무한 스크롤 — 하루씩 받음 (shared/lib/useDayFeed가 아래 두 함수로)
import { queryOptions } from '@tanstack/react-query'
import { api, type ApiList } from '@/shared/api/client'
import { fetchAll } from '@/shared/api/paging'
import { addDays, kstDayStart, ymd, type Ymd } from '@/shared/lib/dateRange'
import { phoneDigits } from '@/shared/lib/search'
import { toCallRow, type CallListItemDto, type CallRow } from './callDto'

export type { CallKind, CallRow } from './callDto'

/** 검색어 → q. 숫자만 쳤으면 번호로('010-1458' → '0101458' — 서버는 숫자만 저장) */
const toQ = (q: string) => {
  const t = q.trim()
  return (phoneDigits(t) || t).slice(0, 200) || undefined
}

/** 그날 통화 전부 (최신순, 100건씩 끝까지). 받는 사이 통화가 생기면 겹칠 수 있어 번호로 한 번 더 거름 */
export async function fetchCallDay(day: Ymd, q: string, signal?: AbortSignal): Promise<CallRow[]> {
  const seen = new Set<number>()
  const query = { q: toQ(q), from: kstDayStart(day), to: kstDayStart(addDays(day, 1)) }
  return (await fetchAll<CallListItemDto>('/calls', query, signal))
    .filter((d) => !seen.has(d.callSessionSeq) && seen.add(d.callSessionSeq))
    .map(toCallRow)
}

/** 상단바 검색 창 미리 보기 — 기간 없이 최근 n건 (최신순) */
export async function fetchRecentCalls(q: string, n: number, signal?: AbortSignal) {
  const res = await api.get<ApiList<CallListItemDto>>('/calls', {
    query: { q: toQ(q), limit: n, offset: 0 },
    signal,
  })
  return res.data.map(toCallRow)
}

/** day 전에 통화가 있는 가장 가까운 날 (최신 1건의 날짜 — 통화 없는 날은 건너뜀). 없으면 null */
export async function prevCallDay(day: Ymd, q: string, signal?: AbortSignal): Promise<Ymd | null> {
  const res = await api.get<ApiList<CallListItemDto>>('/calls', {
    query: { q: toQ(q), to: kstDayStart(day), limit: 1, offset: 0 },
    signal,
  })
  const at = res.data[0]?.startedAt
  return at ? ymd(new Date(at)) : null
}

/** day 다음에 통화가 있는 가장 가까운 날 (그 뒤 가장 오래된 1건의 날짜 — 통화 없는 날은 건너뜀). 없으면 null
 *  서버는 최신순이라 건수를 먼저 받고, 2건 이상이면 맨 끝(offset = 건수 − 1) 1건을 다시 받음 */
export async function nextCallDay(day: Ymd, q: string, signal?: AbortSignal): Promise<Ymd | null> {
  const query = { q: toQ(q), from: kstDayStart(addDays(day, 1)), limit: 1 }
  const head = await api.get<ApiList<CallListItemDto>>('/calls', {
    query: { ...query, offset: 0 },
    signal,
  })
  const last =
    head.total_count > 1
      ? (
          await api.get<ApiList<CallListItemDto>>('/calls', {
            query: { ...query, offset: head.total_count - 1 },
            signal,
          })
        ).data[0]
      : head.data[0]
  return last?.startedAt ? ymd(new Date(last.startedAt)) : null
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
