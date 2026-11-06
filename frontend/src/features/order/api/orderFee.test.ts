// 실행: npx tsx --tsconfig tsconfig.app.json src/features/order/api/orderFee.test.ts  (프레임워크 없이 assert만)
import assert from 'node:assert/strict'
import { shippingFeeOf } from './orderFee'

assert.equal(shippingFeeOf({ document: 0, small: 0, medium: 0, big: 0 }), 0) // 기타 품목만 → 0 (접수 막음)
assert.equal(shippingFeeOf({ document: 2, small: 1, medium: 0, big: 0 }), 15_400)
assert.equal(shippingFeeOf({ document: 1, small: 1, medium: 1, big: 1 }), 25_850)

console.log('orderFee ok')
