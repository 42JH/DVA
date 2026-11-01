// 04 통화 내역 Model — API-21 GET /calls (연동 상세명세 10/31 §5.1). React를 모르는 데이터 층
// 개발 중엔 MSW 가짜(mocks/handlers/calls.ts)가 같은 모양으로 응답. 서버 DTO → 화면 모양은 callDto.ts
import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import { api, type ApiList } from '@/shared/api/client'
import { fetchAll } from '@/shared/api/paging'
import { addDays, kstDayStart, type Ymd } from '@/shared/lib/dateRange'
import { phoneDigits } from '@/shared/lib/search'
import { RESULT_OF, toCallRow, type CallListItemDto, type CallRow, type Outcome } from './callDto'

export type { CallRow } from './callDto'

export interface CallListQuery {
  q: string // 이름 · 전화번호
  from: Ymd // 포함
  to: Ymd // 포함 (서버로 보낼 땐 다음 날 00:00 미포함으로)
  outcome: Outcome | 'ALL'
  complaintOnly: boolean // [불만 통화] 탭
}

export const callListQueries = {
  all: () => ['calls', 'list'] as const,
  list: (query: CallListQuery, page: number, size: number) =>
    queryOptions({
      queryKey: [...callListQueries.all(), query, page, size],
      queryFn: ({ signal }) => fetchCalls(query, page, size, signal),
      placeholderData: keepPreviousData, // 쪽 · 필터를 바꾸는 동안 이전 목록을 그대로 (표가 깜빡이지 않게)
    }),
}

/** 화면 조건 → API-21 query. 전체는 생략(명세: 'ALL' 보내지 않기), 숫자만 쳤으면 번호로, 기간은 KST 자정 · to 미포함 */
function toQuery(q: CallListQuery) {
  const text = q.q.trim()
  return {
    q: (phoneDigits(text) || text).slice(0, 200) || undefined,
    from: kstDayStart(q.from),
    to: kstDayStart(addDays(q.to, 1)),
    result: q.outcome === 'ALL' ? undefined : RESULT_OF[q.outcome],
    hasComplaint: q.complaintOnly || undefined,
  }
}

export async function fetchCalls(
  query: CallListQuery,
  page: number,
  size: number,
  signal?: AbortSignal,
): Promise<{ items: CallRow[]; totalCount: number }> {
  const res = await api.get<ApiList<CallListItemDto>>('/calls', {
    query: { ...toQuery(query), limit: size, offset: (page - 1) * size },
    signal,
  })
  return { items: res.data.map(toCallRow), totalCount: res.total_count }
}

/** CSV 내보내기 — 지금 조건의 전체 쪽 (CSV 엔드포인트가 없어 100건씩 끝까지 받음, 명세 §10). 받는 사이 통화가 생기면 겹칠 수 있어 번호로 한 번 더 거름 */
export async function fetchAllCalls(
  query: CallListQuery,
  signal?: AbortSignal,
): Promise<CallRow[]> {
  const seen = new Set<number>()
  return (await fetchAll<CallListItemDto>('/calls', toQuery(query), signal))
    .filter((d) => !seen.has(d.callSessionSeq) && seen.add(d.callSessionSeq))
    .map(toCallRow)
}
