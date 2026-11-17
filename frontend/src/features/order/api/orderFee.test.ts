// 실행: npx tsx --tsconfig tsconfig.app.json src/features/order/api/orderFee.test.ts  (프레임워크 없이 assert만)
import assert from 'node:assert/strict'
import { isJeju, shippingFeeOf } from './orderFee'

const none = { document: 0, small: 0, medium: 0, big: 0 }
assert.equal(shippingFeeOf(none, false), 0) // 기타 품목만 → 0 (접수 막음)
assert.equal(shippingFeeOf(none, true), 0) // 제주여도 품목이 없으면 0
assert.equal(shippingFeeOf({ document: 2, small: 1, medium: 0, big: 0 }, false), 8_800) // 서류는 몇 장이든 한 번
assert.equal(shippingFeeOf({ document: 2, small: 1, medium: 0, big: 0 }, true), 11_800) // 제주는 주문당 한 번
assert.equal(shippingFeeOf({ document: 1, small: 0, medium: 0, big: 0 }, false), 3_850)
assert.equal(shippingFeeOf({ document: 100, small: 0, medium: 0, big: 0 }, false), 3_850)
// 박스 단가는 AI 요금표와 같음 (소 4,950 · 중 6,050 · 대 7,150)
assert.equal(shippingFeeOf({ document: 0, small: 1, medium: 1, big: 1 }, false), 18_150)

assert.deepEqual(
  ['제주특별자치도 제주시 첨단로 242', '서울 강남구 제주로 1', '', '  제주특별자치도 서귀포시'].map(
    isJeju,
  ),
  [true, false, false, true],
)
