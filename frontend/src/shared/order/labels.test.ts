import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PRICE_BANDS, priceBand } from './labels'

test('물품 가액 구간 — 고른 값은 제 구간으로, AI가 받은 금액은 들어가는 구간으로', () => {
  for (const b of PRICE_BANDS) assert.equal(priceBand(b.max).label, b.label)
  assert.equal(priceBand(1).label, '10만원 미만')
  assert.equal(priceBand(100_000).label, '30만원 미만') // 딱 10만원은 '10만원 미만'이 아님
  assert.equal(priceBand(500_000).label, '100만원 미만')
  assert.equal(priceBand(1_000_000).label, '100만원 이상')
})
