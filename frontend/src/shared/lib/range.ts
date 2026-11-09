// 목록 공통 기간 고르기 — 오늘 · 7일 · 30일 · 전체 → 서버 from (KST 그날 0시)
import { addDays, kstDayStart, todayYmd } from './dateRange'

export type Range = 'today' | '7d' | '30d' | 'all'
export const RANGES: { value: Range; label: string }[] = [
  { value: 'today', label: '오늘' },
  { value: '7d', label: '7일' },
  { value: '30d', label: '30일' },
  { value: 'all', label: '전체' },
]

export function rangeFrom(r: Range): string | undefined {
  const days = r === 'today' ? 0 : r === '7d' ? 6 : r === '30d' ? 29 : null
  return days === null ? undefined : kstDayStart(addDays(todayYmd(), -days))
}
