// 수기 주문 규칙 (11/06) — 서버 문서엔 이 제한이 없어 화면이 막음. 순수 함수 (orderLimits.test.ts)

export const MAX_PRICE = 100_000_000 // 물품 가액 1원 ~ 1억 원
export const MAX_BOXES = 10 // 받는 곳별 묶음마다 소 · 중 · 대 합계 (이 창은 받는 분 하나 = 묶음 하나)
export const MAX_DOCUMENTS = 100 // 같은 묶음에서 박스와 따로

const HOUR = 3_600_000

export const priceOk = (n: number) => n >= 1 && n <= MAX_PRICE

export const PICKUP_OPEN = '09:00' // 수거는 한국 시간 09:00 ~ 17:00, 양 끝 포함 (백엔드 결제 보정 · AI와 같은 규칙)
export const PICKUP_CLOSE = '17:00'

// 주문 화면만 한국 시간으로 표시 · 전송 (브라우저 시간대가 UTC여도 09:00 = 00:00Z). 다른 화면의 공통 날짜 함수는 그대로
/** Date → 한국 시간 datetime-local 값 'YYYY-MM-DDTHH:mm' (초는 버림) */
export const kstLocal = (d: Date) => new Date(d.getTime() + 9 * HOUR).toISOString().slice(0, 16)
/** 한국 시간 datetime-local 값 → 서버로 보낼 ISO (UTC) */
export const fromKstLocal = (v: string) => new Date(`${v}:00+09:00`).toISOString()

/** 수거 희망 일시로 고를 수 있는 범위 (datetime-local 값이라 칸 min · max에 그대로 쓰고 문자열로 비교)
 *  가장 빠른 때 = 지금 + 1시간을 분 올림(10:00:30 → 11:01). 09시 전이면 그날 09:00, 17:00을 넘으면 다음날 09:00
 *  가장 늦은 때 = 지금 + 72시간을 분 내림. 날마다의 09 ~ 17시는 min · max로 못 막아 pickupOk에서 따로 봄 */
export function pickupRange(now: Date) {
  let min = kstLocal(new Date(Math.ceil((now.getTime() + HOUR) / 60_000) * 60_000))
  const day = min.slice(0, 10)
  if (min.slice(11) < PICKUP_OPEN) min = `${day}T${PICKUP_OPEN}`
  else if (min.slice(11) > PICKUP_CLOSE)
    min = `${kstLocal(new Date(Date.parse(`${day}T12:00:00+09:00`) + 24 * HOUR)).slice(0, 10)}T${PICKUP_OPEN}`
  return { min, max: kstLocal(new Date(now.getTime() + 72 * HOUR)) }
}

/** 고른 시각이 범위 안이고 09:00 ~ 17:00 사이인지 */
export const pickupOk = (v: string, r: { min: string; max: string }) =>
  v >= r.min && v <= r.max && v.slice(11) >= PICKUP_OPEN && v.slice(11) <= PICKUP_CLOSE
