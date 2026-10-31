// 실행: TZ=Asia/Seoul npx tsx --tsconfig tsconfig.app.json src/features/order/api/orderCsv.test.ts  (프레임워크 없이 assert만)
import assert from 'node:assert/strict'
import { ORDER_CSV_HEADER, toOrderCsvRow } from './orderCsv'
import type { OrderRow } from './orderApi'

const row: OrderRow = {
  orderSeq: 10519,
  status: 'PAID',
  receivedAt: '2026-10-31T13:12:00+09:00',
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
  pickupAt: '2026-11-02T09:00:00+09:00',
  items: { document: 1, small: 0, medium: 2, big: 0, other: '화분' },
  itemPrice: 30000,
  paymentMethod: 'GROUP_CARD',
  clientComment: null,
}

const cells = toOrderCsvRow(row, '결제 완료')
assert.equal(cells.length, ORDER_CSV_HEADER.length) // 머리줄과 칸 수가 같아야 엑셀에서 안 밀림
const at = (h: (typeof ORDER_CSV_HEADER)[number]) => cells[ORDER_CSV_HEADER.indexOf(h)]
assert.equal(at('접수 시각'), '2026-10-31 13:12')
assert.equal(at('받는 분 상세주소'), '') // 없으면 빈칸
assert.equal(at('중박스'), '2')
assert.equal(at('기타 품목'), '화분')
assert.equal(at('수거 희망 일시'), '2026-11-02 09:00')
assert.equal(at('결제 방식'), '그룹카드')

// 접수 중(품목 · 결제 없음)은 그 칸들이 빈칸
const live = toOrderCsvRow(
  {
    ...row,
    status: 'IN_PROGRESS',
    items: null,
    pickupAt: null,
    itemPrice: null,
    paymentMethod: null,
  },
  '접수 중',
)
assert.deepEqual(live.slice(11, 19), ['', '', '', '', '', '', '', ''])

console.log('orderCsv.test ok')
