// 실행: npx tsx --tsconfig tsconfig.app.json src/features/order/api/orderPatch.test.ts  (프레임워크 없이 assert만)
import assert from 'node:assert/strict'
import type { OrderDetail } from '@/shared/order/orderApi'
import type { OrderInput } from './orderApi'
import { buildCustomerPatch, buildOrderPatch, submitMissing } from './orderPatch'

const order: OrderDetail = {
  orderSeq: 7,
  route: 'MANUAL',
  manualBy: null,
  acceptedAt: '2026-11-01T10:00:00+09:00',
  cancelled: false,
  sender: {
    name: '강도윤',
    phoneNumber: '01066382047',
    roadAddress: '서울 강남구 역삼로 150',
    detailAddress: '5층',
  },
  receiver: {
    name: '이영희',
    phoneNumber: '01023456789',
    roadAddress: '서울 마포구 독막로 301',
    detailAddress: null,
  },
  items: { document: 1, small: 0, medium: 2, big: 0, other: null },
  pickupRequestedAt: '2026-11-02T00:00:00.000Z', // = 11/02 09:00 한국
  itemPrice: 30000,
  clientComment: null,
  paymentMethod: 'MONTHLY',
  paymentState: 'UNPAID',
  relatedCalls: [],
  version: 4,
}
// 창에서 그대로 받은 값 = 원래 값 (시각만 +09:00 모양)
const same: OrderInput = {
  sender: order.sender,
  receiver: order.receiver,
  items: order.items,
  declaredValue: 30000,
  pickupAt: '2026-11-02T09:00:00+09:00',
  paymentMethod: 'MONTHLY',
  request: null,
}

// 아무것도 안 바꿈 → 보낼 것 없음 (서버는 빈 변경을 거절)
assert.deepEqual(buildOrderPatch(order, 101, same), { patch: null, roadChanged: false })

// 받는 분 상세주소 · 중박스 · 요청 사항만 → 그 칸만, 상세 번호와 버전 함께
assert.deepEqual(
  buildOrderPatch(order, 101, {
    ...same,
    receiver: { ...order.receiver, detailAddress: '202호' },
    items: { ...order.items, medium: 3 },
    request: '경비실',
  }).patch,
  {
    expectedVersion: 4,
    parcels: [
      {
        orderParcelSeq: 101,
        destination: { detailAddress: '202호' },
        mediumBoxCount: 3,
        clientComment: '경비실',
      },
    ],
  },
)

// 상세주소 지우기 = 빈 문자열(null 불가) · 수거 시각 지우기 = null · 결제 방식 = 서버 코드
assert.deepEqual(
  buildOrderPatch(order, 101, {
    ...same,
    sender: { ...order.sender, detailAddress: null },
    pickupAt: null,
    paymentMethod: 'PERSONAL_CARD',
  }).patch,
  {
    expectedVersion: 4,
    parcels: [{ orderParcelSeq: 101, origin: { detailAddress: '' } }],
    pickupRequestedAt: null,
    paymentMethodType: 'billing',
  },
)

// 주소를 다시 검색해 고름 → 주소 전체 + 위도 · 경도 1 고정 (11/01 결정)
assert.deepEqual(
  buildOrderPatch(order, 101, {
    ...same,
    receiver: {
      ...order.receiver,
      roadAddress: '서울 중구 세종대로 110',
      picked: {
        jibunAddress: '서울 중구 태평로1가 31',
        dongName: '태평로1가',
        postalCode: '04524',
      },
    },
  }).patch?.parcels,
  [
    {
      orderParcelSeq: 101,
      destination: {
        roadAddress: '서울 중구 세종대로 110',
        jibunAddress: '서울 중구 태평로1가 31',
        dongName: '태평로1가',
        postalCode: '04524',
      },
    },
  ],
)

// 도로명만 바뀌고 검색 결과가 없으면 알려 줌 (보내지 않음)
assert.equal(
  buildOrderPatch(order, 101, {
    ...same,
    receiver: { ...order.receiver, roadAddress: '서울 중구 세종대로 110' },
  }).roadChanged,
  true,
)

// 상세가 아직 없는 주문(접수 중단) → orderParcelSeq 없이 = 새 상세 추가
assert.deepEqual(buildOrderPatch(order, null, { ...same, request: '문 앞' }).patch?.parcels, [
  { clientComment: '문 앞' },
])

// 고객정보에도 저장 (jiw/order-sender-customer-save.md)
const withRest: OrderDetail = {
  ...order,
  sender: {
    ...order.sender,
    jibunAddress: '서울 강남구 역삼동 737',
    dongName: '역삼동',
    postalCode: '06236',
  },
}
// 전화만 바뀜 → 묻지 않음
assert.equal(
  buildCustomerPatch(withRest, {
    ...same,
    sender: { ...withRest.sender, phoneNumber: '01000000000' },
  }),
  null,
)
// 받는 분만 바뀜 → 묻지 않음
assert.equal(
  buildCustomerPatch(withRest, { ...same, receiver: { ...order.receiver, name: '박민수' } }),
  null,
)
// 이름만 → name만
assert.deepEqual(
  buildCustomerPatch(withRest, { ...same, sender: { ...withRest.sender, name: '강도현' } }),
  {
    name: '강도현',
  },
)
// 상세주소만 → 원래 주소의 나머지 칸으로 주소 전체 (전화는 안 보냄)
assert.deepEqual(
  buildCustomerPatch(withRest, {
    ...same,
    sender: { ...withRest.sender, detailAddress: '7층', phoneNumber: '01000000000' },
  }),
  {
    address: {
      roadAddress: '서울 강남구 역삼로 150',
      jibunAddress: '서울 강남구 역삼동 737',
      detailAddress: '7층',
      dongName: '역삼동',
      postalCode: '06236',
    },
  },
)
// 주소 다시 검색 → 검색 결과로
assert.equal(
  buildCustomerPatch(withRest, {
    ...same,
    sender: {
      ...withRest.sender,
      roadAddress: '서울 중구 세종대로 110',
      picked: {
        jibunAddress: '서울 중구 태평로1가 31',
        dongName: '태평로1가',
        postalCode: '04524',
      },
    },
  })?.address?.postalCode,
  '04524',
)
// 원래 주소의 나머지 칸이 없으면(가짜 주문 등) 주소는 빼고 이름만
assert.deepEqual(
  buildCustomerPatch(order, {
    ...same,
    sender: { ...order.sender, name: '강도현', detailAddress: '7층' },
  }),
  { name: '강도현' },
)

// 배송비 칸(접수 중단만): 바뀌면 notifiedPrice
assert.deepEqual(
  buildOrderPatch({ ...order, notifiedPrice: null }, 101, { ...same, shippingFee: 3500 }).patch
    ?.parcels,
  [{ orderParcelSeq: 101, notifiedPrice: 3500 }],
)
assert.equal(
  buildOrderPatch({ ...order, notifiedPrice: 3500 }, 101, { ...same, shippingFee: 3500 }).patch,
  null,
)

// 접수 중단 주문 접수 조건
const full = { jibunAddress: '지번', dongName: '동', postalCode: '01234' }
const ready: OrderDetail = {
  ...order,
  sender: { ...order.sender, ...full },
  receiver: { ...order.receiver, ...full },
}
assert.deepEqual(
  submitMissing(ready, {
    ...same,
    sender: ready.sender,
    receiver: ready.receiver,
    shippingFee: 3500,
  }),
  [],
)
// AI가 모으다 끊긴 주소(우편번호 없음) + 배송비 없음 + 가액 없음
assert.deepEqual(
  submitMissing(
    { ...ready, receiver: { ...ready.receiver, postalCode: undefined } },
    {
      ...same,
      sender: ready.sender,
      receiver: { ...ready.receiver, postalCode: undefined },
      declaredValue: null,
      shippingFee: null,
    },
  ),
  ['받는 분 주소(다시 검색)', '물품 가액', '배송비'],
)
// 다시 검색해 고르면 주소는 통과
assert.deepEqual(
  submitMissing(
    { ...ready, receiver: { ...ready.receiver, postalCode: undefined } },
    {
      ...same,
      sender: ready.sender,
      receiver: {
        ...ready.receiver,
        roadAddress: '새 주소',
        picked: { jibunAddress: 'j', dongName: 'd', postalCode: '01234' },
      },
      shippingFee: 3500,
    },
  ),
  [],
)

console.log('orderPatch OK')
