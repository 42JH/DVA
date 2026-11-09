// 통화 상세 오른쪽 '주문' 카드 — 이 통화로 접수 · 취소된 주문 한 건 (주문 상세에서 받은 첫 소포)
import { useQuery } from '@tanstack/react-query'
import { orderQueries } from '@/shared/order/orderApi'
import { pickParcel } from '@/shared/order/useOrderDetail'

export function useCallOrder(orderSeq: number) {
  const q = useQuery({ ...orderQueries.detail(orderSeq), staleTime: 30_000 })
  return { order: q.data ? pickParcel(q.data) : null, failed: !!q.error }
}
