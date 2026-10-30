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
// 평균 = [숫자, 단위] 조각들 — 02 대시보드와 같은 모양 ('2 분 51 초' · '1.3 회')
type Parts = [string, string][]
const minSec = (n: number | undefined): Parts => {
  if (n === undefined) return [['–', '']]
  const s = Math.round(n)
  return [
    [String(Math.floor(s / 60)), '분'],
    [String(s % 60).padStart(2, '0'), '초'],
  ]
}
const times = (n: number | undefined): Parts => [[n === undefined ? '–' : n.toFixed(1), '회']]

/** 01 홈 위쪽 — 검색(→ 03 주문 내역) · 오늘 숫자(카드 · 평균 모두 오늘 0시부터 시작한 통화 기준). 처리할 AI 미답변은 features/faq의 UnansweredPreview */
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
      { label: '평균 통화 시간', parts: minSec(s?.avgCallSeconds) },
      { label: '평균 되묻기 횟수', parts: times(s?.avgReaskCount) },
    ],
    todayError: today.error?.message ?? null,
  }
}
