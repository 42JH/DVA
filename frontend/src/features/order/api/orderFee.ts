// 수기 주문 배송비 — 품목 개수 × 단가의 합 (11/06). 서버에 견적 API가 없어 화면이 계산 (orderFee.test.ts)
import type { BoxKey } from './orderApi'

// shortcut: 단가를 화면에 고정, 서버가 요금표 · 견적 API를 주면 그걸로 바꾸기
export const UNIT_PRICE: Record<BoxKey, number> = {
  document: 4_950,
  small: 5_500,
  medium: 6_600,
  big: 8_800,
}

export const shippingFeeOf = (counts: Record<BoxKey, number>) =>
  (Object.keys(UNIT_PRICE) as BoxKey[]).reduce((sum, k) => sum + counts[k] * UNIT_PRICE[k], 0)
