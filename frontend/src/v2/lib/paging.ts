// v2 목록 쪽 번호 · 한 쪽 개수 (모든 목록 공통). 개수는 마지막 고른 값을 이 브라우저에 기억
import { useState } from 'react'

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
