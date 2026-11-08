// 실행: npx tsx --tsconfig tsconfig.app.json src/features/order/api/orderLimits.test.ts  (프레임워크 없이 assert만)
// 시각은 모두 +09:00으로 적어 브라우저 · 테스트 시간대와 상관없이 같은 결과
import assert from 'node:assert/strict'
import { fromKstLocal, kstLocal, pickupOk, pickupRange, priceOk } from './orderLimits'

// 물품 가액: 1원 ~ 1억 원만 통과
assert.deepEqual([0, 1, 100_000_000, 100_000_001].map(priceOk), [false, true, true, false])

// 한국 시간 변환 — 09:00 선택은 00:00Z로 보냄
assert.equal(fromKstLocal('2026-11-07T09:00'), '2026-11-07T00:00:00.000Z')
assert.equal(kstLocal(new Date('2026-11-07T00:00:59Z')), '2026-11-07T09:00')

// 수거 범위: 지금 + 1시간(분 올림) ~ + 72시간(분 내림)
const at = (t: string) => new Date(`2026-11-06T${t}+09:00`)
const r = pickupRange(at('10:00:30'))
assert.deepEqual(r, { min: '2026-11-06T11:01', max: '2026-11-09T10:00' })
assert.equal(pickupRange(at('10:00:00')).min, '2026-11-06T11:00')

// 가장 빠른 때: 09시 전이면 그날 09:00, 17:00 넘으면 다음날 09:00, 정확히 17:00은 허용
const minAt = (t: string) => pickupRange(at(t)).min
assert.equal(minAt('07:00:00'), '2026-11-06T09:00')
assert.equal(minAt('08:30:00'), '2026-11-06T09:30')
assert.equal(minAt('16:00:00'), '2026-11-06T17:00')
assert.equal(minAt('16:00:30'), '2026-11-07T09:00')
assert.equal(minAt('23:30:00'), '2026-11-07T09:00')

// 날마다 09:00 ~ 17:00만 (양 끝 포함)
assert.deepEqual(
  ['2026-11-07T08:59', '2026-11-07T09:00', '2026-11-07T17:00', '2026-11-07T17:01'].map((v) =>
    pickupOk(v, r),
  ),
  [false, true, true, false],
)

console.log('orderLimits ok')
