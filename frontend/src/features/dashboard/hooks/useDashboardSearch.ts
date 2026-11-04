import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useOrderDetail } from '@/shared/order/useOrderDetail'
import { searchQueries } from '@/features/dashboard/api/dashboardApi'
import { parseOrderNo } from '@/features/dashboard/format'

/** 02 통계 상단바 검색 창의 데이터 — 주문번호면 그 주문(있는지 · 보내는 분 → 받는 분), 이름 · 전화번호면 최근 통화 8건
 *  통화 검색은 0.25초 멈춘 뒤에 요청 (칠 때마다 요청하지 않게) */
export function useDashboardSearch(q: string) {
  const typed = q.trim()
  const [term, setTerm] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setTerm(typed), 250)
    return () => clearTimeout(t)
  }, [typed])

  const orderSeq = parseOrderNo(typed)
  const order = useOrderDetail(orderSeq)
  const calls = useQuery(searchQueries.calls(term))
  return {
    typed,
    orderSeq,
    order: order.order, // 없으면(404 · 받는 중) null
    orderLoading: order.isLoading,
    hits: typed && term ? (calls.data?.data ?? []) : [],
    total: calls.data?.total_count ?? 0,
    searching: calls.isFetching || term !== typed,
  }
}
