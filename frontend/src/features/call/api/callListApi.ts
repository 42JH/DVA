// 04 통화 내역 Model — GET /calls (연동 명세 11/04 §3). React를 모르는 데이터 층
// 개발 중엔 MSW 가짜(mocks/handlers/calls.ts)가 같은 모양으로 응답. 서버 DTO → 화면 모양은 callDto.ts
// 11/04 디자인: 고른 날짜에서 시작하는 무한 스크롤 — 하루씩 받음 (shared/lib/useDayFeed가 아래 두 함수로)
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
