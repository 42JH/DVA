// 실행: npx tsx --tsconfig tsconfig.app.json src/features/order/api/parcelRows.test.ts  (프레임워크 없이 assert만)
import assert from 'node:assert/strict'
import type { ListParcel, OrderListItem } from './orderApi'
import { parcelRows, partyHas } from './parcelRows'

const parcel = (seq: number, to: string, status: ListParcel['status'] = 'ACTIVE'): ListParcel => ({
  orderParcelSeq: seq,
  status,
  origin: {
    name: '강도윤',
    phoneNumber: '01066382047',
    roadAddress: '서울 강남구 역삼로 150',
    jibunAddress: null,
    detailAddress: '5층',
  },
  destination: {
    name: to,
    phoneNumber: '01023456789',
    roadAddress: '서울 마포구 독막로 301',
    jibunAddress: null,
    detailAddress: null,
  },
  documentCount: 1,
  smallBoxCount: 0,
  mediumBoxCount: 2,
  bigBoxCount: 0,
  otherItemDescription: '화분',
})
const order = (
  parcels: ListParcel[],
  status: OrderListItem['status'] = 'ACCEPTED',
): OrderListItem => ({
  orderSeq: 10519,
  status,
  createdAt: '2026-10-31T13:12:00+09:00',
  pickupRequestedAt: '2026-11-02T09:00:00+09:00',
  parcels,
})

// 줄 나누기: 받는 분마다 한 줄 · 취소된 상세도 보이고 그 줄만 '취소' · 상세 없는 접수 중도 한 줄
const rows = parcelRows(order([parcel(1, '이영희'), parcel(2, '박민수', 'CANCELLED')]))
assert.deepEqual(
  rows.map((r) => [r.key, r.status, r.parcel?.destination.name]),
  [
    ['10519-1', 'ACCEPTED', '이영희'],
    ['10519-2', 'CANCELLED', '박민수'],
  ],
)
const empty = parcelRows(order([], 'COLLECTING'))
assert.deepEqual(
  empty.map((r) => [r.key, r.status, r.parcel]),
  [['10519', 'COLLECTING', null]],
)

// 검색칸: 그 사람의 이름 · 전화번호 · 주소만 봄 (대소문자 무시, 숫자만 치면 전화번호)
const sender = parcel(1, '이영희').origin
assert.equal(partyHas(sender, ''), true) // 빈 칸은 다 맞음
assert.equal(partyHas(sender, '강도'), true)
assert.equal(partyHas(sender, '역삼로 150'), true)
assert.equal(partyHas(sender, '5층'), true)
assert.equal(partyHas(sender, '010-6638'), true) // 숫자만 → 전화번호 숫자
assert.equal(partyHas(sender, '이영희'), false) // 받는 분 이름은 보내는 분 칸에서 안 맞음
assert.equal(partyHas(sender, '마포구'), false)
assert.equal(partyHas(undefined, '강도'), false) // 상세 없는 미완료 주문
assert.equal(partyHas({ ...sender, roadAddress: 'Seoul Gangnam-gu' }, 'gangnam'), true)

console.log('parcelRows.test ok')
