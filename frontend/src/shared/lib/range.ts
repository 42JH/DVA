// 목록 공통 기간 고르기 — 오늘 · 7일 · 30일 · 전체 → 서버 from (KST 그날 0시)
import { addDays, kstDayStart, todayYmd } from './dateRange'

export type Range = 'today' | '7d' | '30d' | 'all'
export const RANGES: { value: Range; label: string }[] = [
  { value: 'today', label: '오늘' },
  { value: '7d', label: '7일' },
  { value: '30d', label: '30일' },
  { value: 'all', label: '전체' },
]

// 며칠 전부터인가 — 오늘 포함이라 7일 = 6일 전부터. 전체는 시작 없음
const DAYS_BACK: Record<Range, number | null> = { today: 0, '7d': 6, '30d': 29, all: null }

export function rangeFrom(r: Range): string | undefined {
  const days = DAYS_BACK[r] ?? null // 주소에 모르는 값이 와도 전체로
  return days === null ? undefined : kstDayStart(addDays(todayYmd(), -days))
}
