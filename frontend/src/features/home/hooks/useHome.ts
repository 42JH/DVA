import { useQuery } from '@tanstack/react-query'
import { phoneDigits, suggest } from '@/shared/lib/search'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { fmtDateDay, fmtDurationParts } from '@/shared/lib/format'
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
// 평균 되묻기: 집계 API가 없어 숫자를 만들지 않음 (명세 §10 — 성공하는 척 금지, 11/01 결정 A)
// 평균 통화 시간은 오늘 목록으로 화면에서 냄 (11/02, homeApi)
const NO_STAT = '집계 API 없음'

export interface HomeAverage {
  label: string
  value?: [string, string][] // [['3', '분'], ['40', '초']]. 없으면 '—' + note
  note?: string
}

/** 01 홈 위쪽 — 검색(→ 03 주문 내역) · 오늘 숫자(카드 · 평균 모두 오늘 0시부터 시작한 통화 기준). 처리할 AI 미답변은 features/faq의 UnansweredPreview */
export function useHome() {
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const today = useQuery(homeQueries.today())
  // 추천 = 오늘 주문의 이름 (03 주문 내역과 같은 규칙: 초성 · 띄어쓰기 무시, 숫자만 치면 추천 없음). 칠 때만 받음
  const names = useQuery({ ...homeQueries.searchNames(), enabled: q.trim() !== '' })

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

  const searchFor = (text: string) => {
    const v = text.trim()
    if (v) void navigate(`/orders?${new URLSearchParams({ q: v })}`)
  }

  return {
    q,
    setQ,
    suggestions: phoneDigits(q) ? [] : suggest(names.data ?? [], q),
    search: () => searchFor(q),
    searchFor, // 최근 검색어를 고르면 바로 03으로 (q 상태가 바뀌기 전이라 글을 직접 받음)

    todayLabel: fmtDateDay(new Date()),
    cards,
    averages: [
      {
        label: '평균 통화 시간',
        value: s?.avgDurationSec == null ? undefined : fmtDurationParts(s.avgDurationSec),
        note: s && s.avgDurationSec === null ? '끝난 통화 없음' : undefined, // 불러오는 중엔 '—'만
      },
      { label: '평균 되묻기 횟수', note: NO_STAT },
    ] satisfies HomeAverage[],
    todayError: today.error ? '오늘 숫자를 불러오지 못했습니다. 새로고침해 주세요.' : null,
  }
}
