// 실행: npx tsx --tsconfig tsconfig.app.json src/features/order/api/orderLimits.test.ts  (프레임워크 없이 assert만)
import assert from 'node:assert/strict'
import { pickupRange, priceOk } from './orderLimits'

// 물품 가액: 1원 ~ 1억 원만 통과
assert.deepEqual([0, 1, 100_000_000, 100_000_001].map(priceOk), [false, true, true, false])

// 수거 범위: 지금 + 1시간 ~ + 72시간 (분까지, 초는 버림)
const r = pickupRange(new Date(2026, 10, 6, 10, 0, 30))
assert.deepEqual(r, { min: '2026-11-06T11:00', max: '2026-11-09T10:00' })
// 문자열 비교 = 시각 비교 (같은 형식)
assert.ok('2026-11-06T10:59' < r.min && '2026-11-09T10:01' > r.max)

console.log('orderLimits ok')
