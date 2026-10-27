/**
 * 쪽 나누기 — 두 가지 목록을 한 모양으로
 *  1) 서버가 hasNext만 주는 목록(04 · 05): offsetOf(page, size)로 요청하고, 쪽 번호는 totalCount가 오면 pageCount로 그림 (대조표 D2)
 *  2) 전부 받아 앞에서 나누는 목록(09처럼 100건 이하): pageSlice(items, page, size)
 * 쪽 번호는 1부터. 지워서 쪽이 줄면 마지막 쪽으로 붙임(clamp)
 */
export const offsetOf = (page: number, size: number) => Math.max(0, page - 1) * size

export const pageCount = (total: number, size: number) => Math.max(1, Math.ceil(total / size))

export function pageSlice<T>(items: T[], page: number, size: number) {
  const pages = pageCount(items.length, size)
  const cur = Math.min(Math.max(1, page), pages)
  return { rows: items.slice((cur - 1) * size, cur * size), page: cur, pages }
}
