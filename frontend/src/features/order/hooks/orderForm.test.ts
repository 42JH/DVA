// 실행: npx tsx --tsconfig tsconfig.app.json src/features/order/hooks/orderForm.test.ts  (프레임워크 없이 assert만)
// 시각은 모두 +09:00으로 적어 브라우저 · 테스트 시간대와 상관없이 같은 결과
import assert from 'node:assert/strict'
import type { OrderDetail } from '@/features/order/api/orderApi'
import {
  NO_ITEMS,
  formFilled,
  itemsErrorOf,
  limitsOf,
  paymentChoices,
  phoneOk,
  submitErrorOf,
  toInput,
  type OrderFormValues,
} from './orderForm'

const now = new Date('2026-11-14T12:00:00+09:00')
const party = {
  name: '김민수',
  phone: '01012345678',
  roadAddress: '서울 강남구 역삼로 150',
  detailAddress: '',
  picked: { jibunAddress: '역삼동 1', dongName: '역삼동', postalCode: '06236' },
}
const base: OrderFormValues = {
  parties: { sender: party, receiver: { ...party, name: '이영희', phone: '0212345678' } },
  counts: { ...NO_ITEMS, small: 2 },
  etcItem: '',
  declaredValue: '50000',
  pickupAt: '',
  payment: 'PERSONAL_CARD',
  request: '',
}
const lim = (v: OrderFormValues, order?: OrderDetail, initial = { price: '', pickup: '' }) =>
  limitsOf(v, order, initial, now)

// 전화번호: 보내는 분은 휴대전화만, 받는 분은 지역번호도
assert.deepEqual(
  [
    phoneOk('sender', '0212345678'),
    phoneOk('receiver', '0212345678'),
    phoneOk('sender', '01012345678'),
    phoneOk('receiver', '0311234567'),
    phoneOk('receiver', '0351234567'), // 없는 지역번호 — 서버가 400
    phoneOk('receiver', '0651234567'),
  ],
  [false, true, true, true, false, false],
)

// 추가: 다 채우면 통과. 주소를 검색으로 안 골랐거나 배송비가 0이면 안 됨
assert.equal(formFilled(base, lim(base), true), true)
const typed = {
  ...base,
  parties: { ...base.parties, receiver: { ...base.parties.receiver, picked: undefined } },
}
assert.equal(formFilled(typed, lim(typed), true), false)
assert.equal(formFilled(typed, lim(typed), false), true) // 수정은 원래 주소 그대로 통과
// 추가는 결제 방식을 골라야 함(안 보내면 서버가 개인카드로 접수). 수정은 미정 그대로 둘 수 있음
const unpaid = { ...base, payment: null }
assert.deepEqual(
  [formFilled(unpaid, lim(unpaid), true), formFilled(unpaid, lim(unpaid), false)],
  [false, true],
)
const etcOnly = { ...base, counts: NO_ITEMS, etcItem: '화분' }
assert.deepEqual(
  [lim(etcOnly).hasItem, lim(etcOnly).feeMissing, formFilled(etcOnly, lim(etcOnly), true)],
  [true, true, false],
)
assert.equal(
  itemsErrorOf(lim(etcOnly), true),
  '배송비를 계산하려면 박스나 서류를 1개 이상 넣어 주세요.',
)
assert.equal(itemsErrorOf(lim(etcOnly), false), undefined) // 배송비 칸이 없는 수정에서는 안 알림

// 박스 합계 10 · 서류 100 초과 — 수정에서 옛 값 그대로면 통과
const many = { ...base, counts: { document: 101, small: 5, medium: 5, big: 1 } }
assert.deepEqual([lim(many).boxesOut, lim(many).docsOut], [true, true])
const old = { items: { ...many.counts, other: null } } as OrderDetail
assert.deepEqual([lim(many, old).boxesOut, lim(many, old).docsOut], [false, false])
assert.equal(
  itemsErrorOf(lim(many), true),
  '박스는 소, 중, 대 합계 10개까지예요. 서류는 100개까지예요.',
)

// 가액 · 수거: 범위 밖이면 걸리고, 창을 열 때 값 그대로면 통과
const out = { ...base, declaredValue: '0', pickupAt: '2026-11-15T20:00' }
assert.deepEqual([lim(out).priceOut, lim(out).pickupOut], [true, true])
const asOpened = lim(out, undefined, { price: '0', pickup: '2026-11-15T20:00' })
assert.deepEqual([asOpened.priceOut, asOpened.pickupOut], [false, false])
assert.equal(lim({ ...base, pickupAt: '2026-11-15T10:00' }).pickupOut, false)

// 보낼 입력: 이름은 앞뒤 공백 없이, 빈 글은 null, 수거를 안 건드렸으면 서버 원래 값(초 유지)
const order = { pickupRequestedAt: '2026-11-15T01:00:30.000Z' } as OrderDetail
const kept = toInput(
  {
    ...base,
    parties: { ...base.parties, sender: { ...party, name: ' 김민수 ' } },
    pickupAt: '2026-11-15T10:00',
  },
  { order, initialPickup: '2026-11-15T10:00', collecting: false, shippingFee: 9900 },
)
assert.deepEqual(
  [kept.sender.name, kept.sender.detailAddress, kept.request, kept.pickupAt, kept.shippingFee],
  ['김민수', null, null, '2026-11-15T01:00:30.000Z', undefined],
)
const moved = toInput(
  { ...base, pickupAt: '2026-11-15T11:00' },
  { order, initialPickup: '2026-11-15T10:00', collecting: true, shippingFee: 9900 },
)
assert.deepEqual(
  [moved.pickupAt, moved.shippingFee, moved.items],
  ['2026-11-15T02:00:00.000Z', 9900, { document: 0, small: 2, medium: 0, big: 0, other: null }],
)
// 접수 중단인데 배송비 0원 = 없음(null)
assert.equal(
  toInput(base, { initialPickup: '', collecting: true, shippingFee: 0 }).shippingFee,
  null,
)

// 결제 방식: 자격을 받기 전엔 모두 켬. 개인은 그룹카드 불가 · 월결제은 물어보고 추가, 기업은 꺼진 수단을 못 고름
const hints = (c: Parameters<typeof paymentChoices>[0]) =>
  paymentChoices(c).options.map((o) => o.disabledHint ?? '')
assert.deepEqual(hints(undefined), ['', '', ''])
const personal = { customerSeq: 1, company: null, available: ['PERSONAL_CARD' as const] }
assert.deepEqual(
  [paymentChoices(personal).canAddMonthly, hints(personal)],
  [true, ['', '기업 고객만', '']],
)
const company = { customerSeq: 2, company: '디버물류', available: ['PERSONAL_CARD' as const] }
assert.deepEqual(
  [paymentChoices(company).canAddMonthly, hints(company)],
  [false, ['기업 설정에서 꺼짐', '기업 설정에서 꺼짐', '']],
)

// 버튼 줄 오류: 다른 관리자가 먼저 저장(창 위에 안내) · 칸 아래에 다 보인 오류는 한 줄을 안 띄움
assert.equal(submitErrorOf(null, '접수'), null)
assert.equal(submitErrorOf({ status: 409, code: 'VERSION_CONFLICT', details: [] }, '저장'), null)
const fieldErr = (field: string) => ({ status: 422, code: 'VALIDATION', details: [{ field }] })
assert.equal(submitErrorOf(fieldErr('sender.name'), '접수'), null)
assert.equal(typeof submitErrorOf(fieldErr('parcels.0.weight'), '접수'), 'string')
assert.equal(typeof submitErrorOf(new TypeError('끊김'), '접수'), 'string')
