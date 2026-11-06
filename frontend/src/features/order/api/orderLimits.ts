// 수기 주문 규칙 (11/06) — 서버 문서엔 이 제한이 없어 화면이 막음. 순수 함수 (orderLimits.test.ts)
import { toDateTimeLocal } from '@/shared/lib/format'

export const MAX_PRICE = 100_000_000 // 물품 가액 1원 ~ 1억 원
export const MAX_BOXES = 10 // 받는 곳별 묶음마다 소 · 중 · 대 합계 (이 창은 받는 분 하나 = 묶음 하나)
export const MAX_DOCUMENTS = 100 // 같은 묶음에서 박스와 따로

const HOUR = 3_600_000

export const priceOk = (n: number) => n >= 1 && n <= MAX_PRICE

/** 수거 희망 일시로 고를 수 있는 범위: 지금 + 1시간 ~ 지금 + 72시간. datetime-local 값('…T11:00')이라 칸 min · max에 그대로 쓰고 문자열로 비교 */
export function pickupRange(now: Date) {
  return {
    min: toDateTimeLocal(new Date(now.getTime() + HOUR)),
    max: toDateTimeLocal(new Date(now.getTime() + 72 * HOUR)),
  }
}
