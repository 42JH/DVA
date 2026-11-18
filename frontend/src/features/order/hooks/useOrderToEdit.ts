import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError } from '@/shared/api/client'
import { orderQueries } from '@/shared/order/orderApi'
import { pickParcel } from '@/shared/order/useOrderDetail'

/** 주문을 못 채웠을 때 한 줄 — 받는 중 · 없는 주문 · 못 받음 */
const loadNotice = (q: { isPending: boolean; error: unknown }) => {
  if (q.isPending) return '불러오는 중…'
  if (q.error instanceof ApiError && q.error.status === 404) return '주문을 찾을 수 없습니다.'
  return q.error ? '불러오지 못했습니다. 다시 시도해 주세요.' : null
}

/** 주문 수정 창에 채울 주문 원본 — 상세 창과 같은 쿼리라 방금 상세를 봤으면 기다리지 않음
 * parcelSeq = 목록에서 누른 배송 상세 → 그 상세 값으로 채움 (11/01) */
export function useOrderToEdit(orderId: number, parcelSeq: number | null) {
  const q = useQuery(orderQueries.detail(orderId))
  const qc = useQueryClient()
  const [conflict, setConflict] = useState<string | null>(null)
  return {
    // 버전 충돌(409) → 최신 주문을 다시 받음 → 창이 새 버전으로 다시 채워짐(key = version) + 안내 (자동 덮어쓰기 금지)
    conflict,
    onConflict: () => {
      setConflict(
        '다른 관리자가 먼저 수정해서 최신 내용으로 다시 채웠어요. 확인 후 다시 고쳐 주세요.',
      )
      void qc.invalidateQueries({ queryKey: orderQueries.detail(orderId).queryKey })
    },
    order: q.data ? pickParcel(q.data, parcelSeq) : null,
    notice: loadNotice(q),
  }
}
