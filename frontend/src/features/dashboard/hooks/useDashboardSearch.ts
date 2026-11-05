import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { matchKo } from '@/shared/lib/search'
import { useOrderDetail } from '@/shared/order/useOrderDetail'
import { searchQueries, type FaqHit } from '@/features/dashboard/api/dashboardApi'
import { parseOrderNo } from '@/features/dashboard/format'

/** 검색 창 위 탭 (11/05 사용자: 통화 · 주문 · FAQ를 골라서 검색) */
export type SearchTab = 'call' | 'order' | 'faq'

const SHOW = 8
const newest = (a: FaqHit, b: FaqHit) => Date.parse(b.createdAt) - Date.parse(a.createdAt)

/** 02 통계 상단바 검색 창의 데이터 — 고른 탭만 요청
 *  통화 = 이름 · 전화번호 → 최근 통화 8건 / 주문 = 주문번호면 그 주문, 아니면 이름 · 전화번호 → 최근 주문 8건
 *  FAQ = 질문 · 답변 낱말(띄어쓰기 무시 · 초성, 09 FAQ와 같은 규칙) → 최근 만든 것부터 8건
 *  서버 검색은 0.25초 멈춘 뒤에 요청 (칠 때마다 요청하지 않게) */
export function useDashboardSearch(q: string, tab: SearchTab) {
  const typed = q.trim()
  const [term, setTerm] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setTerm(typed), 250)
    return () => clearTimeout(t)
  }, [typed])

  const orderSeq = tab === 'order' ? parseOrderNo(typed) : null
  const order = useOrderDetail(orderSeq)
  const calls = useQuery(searchQueries.calls(tab === 'call' ? term : ''))
  const orders = useQuery(searchQueries.orders(tab === 'order' && orderSeq === null ? term : ''))
  const faqs = useQuery(searchQueries.faqs(tab === 'faq'))
  const faqHits = typed
    ? (faqs.data ?? [])
        .filter((f) => matchKo(f.question, typed) || matchKo(f.answer, typed))
        .sort(newest)
    : []
  const waiting = term !== typed

  return {
    typed,
    // 통화
    calls: tab === 'call' && typed && term ? (calls.data?.data ?? []) : [],
    callTotal: calls.data?.total_count ?? 0,
    // 주문
    orderSeq,
    order: order.order, // 없으면(404 · 받는 중) null
    orderLoading: order.isLoading,
    orders: tab === 'order' && orderSeq === null && typed && term ? (orders.data ?? []) : [],
    // FAQ
    faqs: faqHits.slice(0, SHOW),
    faqTotal: faqHits.length,
    searching:
      tab === 'faq' ? faqs.isPending : waiting || (tab === 'call' ? calls : orders).isFetching,
  }
}
