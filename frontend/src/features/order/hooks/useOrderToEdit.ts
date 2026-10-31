import { useQuery } from '@tanstack/react-query'
import { NotFoundError } from '@/shared/api/client'
import { orderQueries } from '@/shared/order/orderApi'

/** 주문 수정 창에 채울 주문 원본 — 상세 창과 같은 쿼리라 방금 상세를 봤으면 기다리지 않음 */
export function useOrderToEdit(orderId: number) {
  const q = useQuery(orderQueries.detail(orderId))
  return {
    order: q.data ?? null,
    notice: q.isPending
      ? '불러오는 중…'
      : q.error instanceof NotFoundError
        ? q.error.message
        : q.error
          ? '불러오지 못했습니다. 다시 시도해 주세요.'
          : null,
  }
}
