// 주문 코드 → 화면 문구 (컨벤션 6.3: 코드는 orderApi, 문구는 labels)
import type { PaymentMethod, PaymentState } from './orderTypes'

/** 주문번호 'DV-00001' (Figma '주문' 11/04) — 서버 주문 번호(orderSeq)를 5자리로 */
export const orderNo = (orderSeq: number) => `DV-${String(orderSeq).padStart(5, '0')}`

/** 상태 묶음 = 서버 statusGroup — 03 목록 칩 · '주문 상태' 고르기 · 주문 상세 머리 칩 (Figma '주문' 11/04 문구) */
export type OrderGroup =
  'COLLECTING' | 'notPaid' | 'PAID' | 'ACCEPTED' | 'SUBMISSION_FAILED' | 'CANCELLED'

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  MONTHLY: '월결제',
  GROUP_CARD: '그룹카드',
  PERSONAL_CARD: '개인카드',
  BRANCH_VISIT: '지점 방문',
}
export const PAYMENT_STATE_LABEL: Record<PaymentState, string> = {
  PAID: '결제 완료',
  UNPAID: '결제 대기',
  CANCELLED_BEFORE_PAYMENT: '결제 전 취소',
}

/** 물품 가액 구간 — 화면에선 구간으로 고르고 구간으로 보여 줌. 서버엔 그 구간의 가장 큰 금액(원)을 저장
 * AI 전화 접수는 지금처럼 정확한 금액을 보냄 → 그 금액도 들어가는 구간 이름으로 보여 줌 */
export const PRICE_BANDS = [
  { max: 100_000, label: '10만원 이하' },
  { max: 300_000, label: '30만원 이하' },
  { max: 500_000, label: '50만원 이하' },
  { max: 1_000_000, label: '100만원 이하' },
  { max: 100_000_000, label: '100만원 초과' }, // 서버 상한 1억
] as const
export const priceBand = (won: number) =>
  PRICE_BANDS.find((b) => won <= b.max) ?? PRICE_BANDS[PRICE_BANDS.length - 1]
