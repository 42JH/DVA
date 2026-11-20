// 실행: npx tsx src/shared/order/orderDto.test.ts  (프레임워크 없이 assert만)
import assert from 'node:assert/strict'
import { toOrderDetail, type OrderDetailDto, type OrderParcelDto } from './orderDto'

const address = (name: string, road: string | null, detail: string | null = null) => ({
  name,
  phoneNumber: '01066382047',
  roadAddress: road,
  jibunAddress: '서울 강남구 역삼동 737',
  detailAddress: detail,
  dongName: '역삼동',
  postalCode: '06236',
})

const parcel = (p: Partial<OrderParcelDto>): OrderParcelDto => ({
  status: 'ACTIVE',
  orderParcelSeq: 1,
  orderSeq: 10519,
  parcelPosition: 1,
  origin: address('강도윤', '서울 강남구 역삼로 150', '5층'),
  destination: address('이영희', '서울 마포구 독막로 301', ''),
  originPin: null,
  documentCount: 1,
  smallBoxCount: 0,
  mediumBoxCount: 0,
  bigBoxCount: 0,
  otherItemDescription: '',
  clientComment: '',
  notifiedPrice: 4000,
  itemPrice: 30000,
  ...p,
})

const dto = (d: Partial<OrderDetailDto>): OrderDetailDto => ({
  orderSeq: 10519,
  customerSeq: 7,
  status: 'ACCEPTED',
  paymentMethodType: 'credit',
  creationSource: 'AI',
  pickupRequestedAt: '2026-11-01T09:00:00+09:00',
  createdAt: '2026-10-31T13:12:00+09:00',
  paymentDueAt: null,
  paidAt: '2026-10-31T13:13:00+09:00',
  totalAmount: 4000,
  billingOrganizationSeq: null,
  billingOrganizationName: null,
  billingDepartmentSeq: null,
  billingDepartmentName: null,
  paymentRequest: null,
  version: 3,
  parcelNo: 'D-1',
  dverReceivedAt: null,
  updatedAt: '2026-10-31T13:13:00+09:00',
  parcels: [parcel({})],
  ...d,
})

// 한 건짜리 AI 접수 · 월결제 · 디버 접수 완료
const a = toOrderDetail(dto({}))
assert.equal(a.route, 'PHONE')
assert.equal(a.paymentMethod, 'MONTHLY')
assert.equal(a.paymentState, 'PAID') // 디버 접수 완료도 화면 '결제'는 결제 완료
assert.equal(a.cancelled, false)
assert.deepEqual(a.sender, {
  name: '강도윤',
  phoneNumber: '01066382047',
  roadAddress: '서울 강남구 역삼로 150',
  detailAddress: '5층',
  // 고객정보 저장용 주소 나머지 칸
  jibunAddress: '서울 강남구 역삼동 737',
  dongName: '역삼동',
  postalCode: '06236',
})
assert.equal(a.receiver.detailAddress, null) // 빈 상세주소는 '없음'
assert.equal(a.itemPrice, 30000)

// 수기 · 결제 대기 · 상세 여러 건(하나는 취소): 취소 안 된 것만 합침, 주소는 첫 상세
const b = toOrderDetail(
  dto({
    status: 'notPaid',
    paymentMethodType: 'billing',
    creationSource: 'ADMIN',
    parcels: [
      parcel({
        smallBoxCount: 1,
        documentCount: 0,
        otherItemDescription: '화분',
        clientComment: '경비실',
      }),
      parcel({ status: 'CANCELLED', bigBoxCount: 5, itemPrice: 999999 }),
      parcel({ mediumBoxCount: 2, documentCount: 0, itemPrice: null, clientComment: '경비실' }),
    ],
  }),
)
assert.equal(b.route, 'MANUAL')
assert.equal(b.paymentState, 'UNPAID')
assert.equal(b.paymentMethod, 'PERSONAL_CARD')
assert.deepEqual(b.items, { document: 0, small: 1, medium: 2, big: 0, other: '화분' })
assert.equal(b.itemPrice, 30000) // 취소된 999999는 빠짐, null은 0으로 더하지 않음
assert.equal(b.clientComment, '경비실') // 같은 요청은 한 번만
// 배송 상세마다 (03 목록 줄 = 상세 하나, 11/01): 취소된 상세도 들어 있고, 품목 · 가액은 그 상세 것만
assert.equal(b.parcels?.length, 3)
assert.deepEqual(
  b.parcels?.map((p) => [p.cancelled, p.items.big, p.items.other, p.itemPrice, p.clientComment]),
  [
    [false, 0, '화분', 30000, '경비실'],
    [true, 5, null, 999999, null],
    [false, 0, null, null, '경비실'],
  ],
)

// 취소 · 도로명 없음(지번으로) · 상세 없음(수집 중 취소)
const c = toOrderDetail(dto({ status: 'CANCELLED', paymentMethodType: 'cat', parcels: [] }))
assert.equal(c.cancelled, true)
assert.equal(c.paymentMethod, 'BRANCH_VISIT')
assert.equal(c.sender.name, '')
assert.equal(c.itemPrice, null)
const d = toOrderDetail(dto({ parcels: [parcel({ origin: address('김', null) })] }))
assert.equal(d.sender.roadAddress, '서울 강남구 역삼동 737')
