import { api, type ApiList } from './client'

/**
 * 쪽 나누기 — 두 가지 목록을 한 모양으로
 *  1) 서버가 쪽을 나누는 목록: offset = (page - 1) * size로 요청하고, 쪽 번호는 total_count로 pageCount
 *  2) 전부 받아 앞에서 나누는 목록(09처럼 수십 건): fetchAll로 다 받고 pageSlice(items, page, size)
 * 쪽 번호는 1부터. 지워서 쪽이 줄면 마지막 쪽으로 붙임(clamp)
 */

export const pageCount = (total: number, size: number) => Math.max(1, Math.ceil(total / size))

export function pageSlice<T>(items: T[], page: number, size: number) {
  const pages = pageCount(items.length, size)
  const cur = Math.min(Math.max(1, page), pages)
  return { rows: items.slice((cur - 1) * size, cur * size), page: cur, pages }
}

const LIMIT = 100 // API 최대 (명세 §1 limit 1~100)
const MAX_PAGES = 20
/** fetchAll이 받는 최대 건수 — 받은 수가 이 값이면 뒤가 더 있을 수 있음. 부르는 쪽이 안내하거나 막음 */
export const FETCH_ALL_MAX = LIMIT * MAX_PAGES

/** 목록을 hasNext가 꺼질 때까지 다 받음 (09 FAQ · AI 미답변, 04 CSV, 06 대화 · 동작 · 처리 결과)
 * ponytail: 차례로 요청 — 최대 2,000건. 넘으면 서버 q · offset 쪽 넘김으로 바꿀 것 */
export async function fetchAll<T>(
  path: string,
  query: Record<string, string | number | boolean | undefined>,
  signal?: AbortSignal,
): Promise<T[]> {
  const out: T[] = []
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await api.get<ApiList<T>>(path, {
      query: { ...query, limit: LIMIT, offset: page * LIMIT },
      signal,
    })
    out.push(...res.data)
    if (!res.hasNext) break
  }
  return out
}
