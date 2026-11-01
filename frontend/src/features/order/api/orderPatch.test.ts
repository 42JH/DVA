// 실행: npx tsx --tsconfig tsconfig.app.json src/features/order/api/orderPatch.test.ts  (프레임워크 없이 assert만)
import assert from 'node:assert/strict'
import type { OrderDetail } from '@/shared/order/orderApi'
import type { OrderInput } from './orderApi'
import { buildOrderPatch } from './orderPatch'

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
        latitude: 1,
        longitude: 1,
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

console.log('orderPatch OK')
