// 수기 주문 배송비 — 박스는 개수 × 단가, 서류는 몇 장이든 한 번. 그 합. 서버에 견적 API가 없어 화면이 계산 (orderFee.test.ts)
import type { BoxKey } from './orderInput'

// 단가 = AI 전화 접수 요금표와 같게 (ai/app/domain/fare.py, 10/31 결정 · 11/09 사용자: 화면이 AI에 맞춤)
// 서류 한 번 · 제주 +3,000원은 수기 주문 규칙 (AI에는 아직 없음)
// shortcut: 단가를 화면에 고정, 서버가 요금표 · 견적 API를 주면 그걸로 바꾸기
const UNIT_PRICE: Record<BoxKey, number> = {
  document: 3_850,
  small: 4_950,
  medium: 6_050,
  big: 7_150,
}

const JEJU_EXTRA = 3_000 // 보내는 분 · 받는 분 중 하나라도 제주면 주문당 한 번

// 도로명 주소 첫머리 '제주특별자치도 …' — 새로 검색한 주소 · 수정 창의 옛 주소 둘 다 이 글자로 옴
export const isJeju = (roadAddress: string) => roadAddress.trim().startsWith('제주')

export function shippingFeeOf(counts: Record<BoxKey, number>, jeju: boolean) {
  const base = (Object.keys(UNIT_PRICE) as BoxKey[]).reduce(
    // 서류는 1장이든 100장이든 같은 값
    (sum, k) => sum + (k === 'document' ? Math.min(counts[k], 1) : counts[k]) * UNIT_PRICE[k],
    0,
  )
  return base > 0 && jeju ? base + JEJU_EXTRA : base // 품목이 없으면 0 그대로 (접수 막음)
}
