// 실행: npx tsx --tsconfig tsconfig.app.json src/features/order/api/orderCreate.test.ts  (프레임워크 없이 assert만)
import assert from 'node:assert/strict'
import { buildCreateOrder } from './orderCreate'
import type { OrderInput } from './orderApi'

const input: OrderInput = {
  sender: {
    name: '강도윤',
    phoneNumber: '01066382047',
    roadAddress: '서울 강남구 역삼로 150',
    detailAddress: '5층',
    picked: { jibunAddress: '서울 강남구 역삼동 737', dongName: '역삼동', postalCode: '06236' },
  },
  receiver: {
    name: '이영희',
    phoneNumber: '01023456789',
    roadAddress: '서울 마포구 독막로 301',
    detailAddress: null,
    picked: { jibunAddress: '서울 마포구 신수동 1', dongName: '신수동', postalCode: '04107' },
  },
  items: { document: 0, small: 1, medium: 0, big: 0, other: null },
  declaredValue: 30000,
  pickupAt: null,
  paymentMethod: 'PERSONAL_CARD',
  request: null,
}

const body = buildCreateOrder(input, 3500)
assert.deepEqual(body.customer, { name: '강도윤', phoneNumber: '01066382047' }) // 주문자 = 보내는 분
assert.equal(body.paymentMethodType, 'billing')
assert.equal(body.totalAmount, 3500) // = 배송비
assert.equal('pickupRequestedAt' in body, false) // 비우면 안 보냄
assert.equal(body.parcels.length, 1)
const p = body.parcels[0]!
assert.equal(p.notifiedPrice, 3500)
assert.equal(p.itemPrice, 30000)
assert.equal(p.destination.detailAddress, '') // 없으면 빈 문자열(null 불가)
assert.deepEqual([p.origin.postalCode, p.origin.dongName], ['06236', '역삼동'])
assert.equal('latitude' in p.origin, false) // 좌표 칸은 서버에서 빠짐(043) — 보내면 400
assert.equal(p.otherItemDescription, '')
assert.equal(p.clientComment, '')

// 수거 시각을 넣으면 보냄 · 월결제 = credit
const b2 = buildCreateOrder(
  { ...input, pickupAt: '2026-11-02T09:00:00+09:00', paymentMethod: 'MONTHLY' },
  4000,
)
assert.equal(b2.pickupRequestedAt, '2026-11-02T09:00:00+09:00')
assert.equal(b2.paymentMethodType, 'credit')

// 결제 방식 미정 → 칸을 빼고 보냄 (서버: 생략 = 미정)
assert.equal(
  'paymentMethodType' in buildCreateOrder({ ...input, paymentMethod: null }, 3500),
  false,
)

// 고객 번호를 주면(월정산을 먼저 켬, 11/10) customer 대신 customerSeq — 서버는 둘 중 하나만
const b3 = buildCreateOrder({ ...input, paymentMethod: 'MONTHLY' }, 3500, 42)
assert.equal(b3.customerSeq, 42)
assert.equal('customer' in b3, false)

console.log('orderCreate OK')
