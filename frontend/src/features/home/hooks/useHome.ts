import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { fmtDateDay } from '@/shared/lib/format'
import { homeQueries } from '@/features/home/api/homeApi'
import { TODAY_CARD_LABEL, type TodayCardKind } from '@/features/home/labels'

export type { TodayCardKind } from '@/features/home/labels'

export interface TodayCard {
  kind: TodayCardKind
  label: string
  count: string // '12,345' · 불러오기 전 '–'
  to: string
}

// 04 통화 내역 URL 규칙(useCallList): outcome · tab=complaint. 기간(from · to)이 비면 오늘
const CALLS_LINK: Record<TodayCardKind, string> = {
  SUCCESS: '/calls?period=today&outcome=SUCCESS',
  FAILED: '/calls?period=today&outcome=FAILED',
  HANDOFF: '/calls?period=today&outcome=HANDOFF',
  COMPLAINT: '/calls?period=today&tab=complaint',
}

const count = (n: number | undefined) => (n === undefined ? '–' : n.toLocaleString('ko-KR'))
const avg = (n: number | undefined) => (n === undefined ? '–' : n.toFixed(1))

/** 01 홈 위쪽 — 검색(→ 03 주문 내역) · 오늘 숫자. 처리할 AI 미답변은 features/faq의 UnansweredPreview */
export function useHome() {
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const today = useQuery(homeQueries.today())

  const s = today.data
  const counts: Record<TodayCardKind, number | undefined> = {
    SUCCESS: s?.successCount,
    FAILED: s?.failedCount,
    HANDOFF: s?.handoffCount,
    COMPLAINT: s?.complaintCount,
  }
  const cards: TodayCard[] = (Object.keys(counts) as TodayCardKind[]).map((kind) => ({
    kind,
    label: TODAY_CARD_LABEL[kind],
    count: count(counts[kind]),
    to: CALLS_LINK[kind],
  }))

  return {
    q,
    setQ,
    search: () => {
      const v = q.trim()
      if (v) void navigate(`/orders?${new URLSearchParams({ q: v })}`)
    },

    todayLabel: fmtDateDay(new Date()),
    cards,
    averages: [
      { label: '평균 통화 시간', value: avg(s?.avgCallSeconds), unit: '초' },
      { label: '평균 되묻기 횟수', value: avg(s?.avgReaskCount), unit: '회' },
    ],
    todayError: today.error?.message ?? null,
  }
}
