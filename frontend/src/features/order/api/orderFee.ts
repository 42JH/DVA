// 수기 주문 배송비 — 품목 개수 × 단가의 합 (11/06). 서버에 견적 API가 없어 화면이 계산 (orderFee.test.ts)
import type { BoxKey } from './orderApi'

// shortcut: 단가를 화면에 고정, 서버가 요금표 · 견적 API를 주면 그걸로 바꾸기
export const UNIT_PRICE: Record<BoxKey, number> = {
  document: 4_950,
  small: 5_500,
  medium: 6_600,
  big: 8_800,
}

export const JEJU_EXTRA = 3_000 // 보내는 분 · 받는 분 중 하나라도 제주면 주문당 한 번 (11/06)

// 도로명 주소 첫머리 '제주특별자치도 …' — 새로 검색한 주소 · 수정 창의 옛 주소 둘 다 이 글자로 옴
export const isJeju = (roadAddress: string) => roadAddress.trim().startsWith('제주')

export function shippingFeeOf(counts: Record<BoxKey, number>, jeju: boolean) {
  const base = (Object.keys(UNIT_PRICE) as BoxKey[]).reduce(
    (sum, k) => sum + counts[k] * UNIT_PRICE[k],
    0,
  )
  return base > 0 && jeju ? base + JEJU_EXTRA : base // 품목이 없으면 0 그대로 (접수 막음)
}
