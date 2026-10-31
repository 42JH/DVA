import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { orderQueries } from '@/features/order/api/orderApi'

/** 주소 검색 창 훅 — 두 글자부터 찾음. 결과는 도로명 주소 목록 */
export function useAddressSearch() {
  const [q, setQ] = useState('')
  const result = useQuery(orderQueries.address(q))
  const ready = q.trim().length >= 2

  return {
    q,
    setQ,
    results: ready ? (result.data ?? []) : [],
    // 안내 한 줄: 아직 덜 쳤음 · 찾는 중 · 오류 · 결과 없음 (결과가 있으면 null)
    notice: !ready
      ? '도로명과 건물 번호로 찾아 주세요. (예: 역삼로 150)'
      : result.isPending
        ? '찾는 중…'
        : result.error
          ? '주소를 찾지 못했습니다. 다시 시도해 주세요.'
          : result.data?.length
            ? null
            : '검색 결과가 없습니다.',
  }
}
