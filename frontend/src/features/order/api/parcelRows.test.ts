// 실행: npx tsx --tsconfig tsconfig.app.json src/features/order/api/parcelRows.test.ts  (프레임워크 없이 assert만)
import assert from 'node:assert/strict'
import type { ListParcel, OrderListItem } from './orderApi'
import { parcelRows } from './parcelRows'

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

console.log('parcelRows.test ok')
