import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { todayYmd, ymd } from '@/shared/lib/dateRange'
import { fmtDateDay, fmtDateTime, fmtPhone, fmtTime } from '@/shared/lib/format'
import { homeQueries } from '@/features/home/api/homeApi'
import { TODAY_CARD_LABEL, type TodayCardKind } from '@/features/home/labels'

export type { TodayCardKind } from '@/features/home/labels'

export interface TodayCard {
  kind: TodayCardKind
  label: string
  count: string // '12,345' · 불러오기 전 '–'
  to: string
}

export interface UnansweredRow {
  callSeq: number
  time: string // 오늘이면 '16:40', 지난날이면 '10.19 16:40' (미처리 전체라 며칠 묵은 것도 옴)
  name: string
  phone: string
  question: string
}

// shortcut: 04 통화 내역의 URL 쿼리 이름이 아직 없음 — 04를 만들 때 그 화면의 useListParams 키에 맞춘다
const CALLS_LINK: Record<TodayCardKind, string> = {
  SUCCESS: '/calls?period=today&outcome=SUCCESS',
  FAILED: '/calls?period=today&outcome=FAILED',
  HANDOFF: '/calls?period=today&outcome=HANDOFF',
  COMPLAINT: '/calls?period=today&complaint=true',
}

const count = (n: number | undefined) => (n === undefined ? '–' : n.toLocaleString('ko-KR'))
const avg = (n: number | undefined) => (n === undefined ? '–' : n.toFixed(1))
const message = (e: unknown) => (e instanceof Error ? e.message : null)

/** 01 홈 — 검색(→ 03 주문 내역) · 오늘 숫자 · 처리할 AI 미답변 미리보기 */
export function useHome() {
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const today = useQuery(homeQueries.today())
  const unanswered = useQuery(homeQueries.unanswered())

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

  const todayStr = todayYmd()
  const rows: UnansweredRow[] = (unanswered.data?.data ?? []).map((u) => ({
    callSeq: u.callSeq,
    time: ymd(new Date(u.startedAt)) === todayStr ? fmtTime(u.startedAt) : fmtDateTime(u.startedAt),
    name: u.customerName,
    phone: fmtPhone(u.callerPhone),
    question: `“${u.question}”`,
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
    todayError: message(today.error),

    rows,
    unansweredCount: unanswered.data?.totalCount, // 없으면 'n개'를 안 그림
    isUnansweredLoading: unanswered.isPending,
    unansweredError: message(unanswered.error),
    openUnanswered: (row: UnansweredRow) => void navigate(`/inquiries/${row.callSeq}`),
    unansweredAllLink: '/inquiries?tab=unanswered&period=all',
  }
}
