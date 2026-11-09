// v2 목록 쪽 번호 · 한 쪽 개수 (모든 목록 공통). 개수는 마지막 고른 값을 이 브라우저에 기억
import { useState } from 'react'
import type { ApiList } from '@/shared/api/client'

export const PAGE_SIZES = [15, 30, 50, 100]
const KEY = 'v2-page-size'

export function usePageSize() {
  const [size, setSize] = useState(() => {
    const n = Number(localStorage.getItem(KEY))
    return PAGE_SIZES.includes(n) ? n : 50
  })
  const set = (n: number) => {
    localStorage.setItem(KEY, String(n))
    setSize(n)
  }
  return [size, set] as const
}

/** 보일 쪽 번호 — 10쪽씩 묶음 (일반 게시판 방식): 1~10 / 11~20 … 지금 쪽이 든 묶음 */
export function pageGroup(page: number, pages: number): number[] {
  const start = Math.floor((page - 1) / 10) * 10 + 1
  return Array.from({ length: Math.min(10, pages - start + 1) }, (_, i) => start + i)
}

/** 오래된 순 쪽 — 서버는 최신순만 줌 → 총 건수로 뒤쪽부터 잘라 받아 뒤집음 */
export function oldestPage<T>(
  total: number,
  page: number,
  size: number,
  get: (limit: number, offset: number) => Promise<ApiList<T>>,
): Promise<ApiList<T>> {
  const end = total - (page - 1) * size
  const start = Math.max(0, total - page * size)
  if (end <= 0) return Promise.resolve({ data: [], hasNext: false, total_count: total })
  return get(end - start, start).then((r) => ({ ...r, data: [...r.data].reverse() }))
}
