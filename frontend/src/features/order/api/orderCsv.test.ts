// 실행: TZ=Asia/Seoul npx tsx --tsconfig tsconfig.app.json src/features/order/api/orderCsv.test.ts  (프레임워크 없이 assert만)
import assert from 'node:assert/strict'
import { toCsv } from '@/shared/lib/csv'
import {
  ORDER_CSV_COLUMNS,
  ORDER_CSV_EXAMPLE,
  ORDER_CSV_EXPORT_PREFIX,
  parseOrderCsv,
  toOrderCsvCells,
} from './orderCsv'
import type { OrderRow } from './orderApi'

const now = new Date('2026-11-01T00:00:00+09:00')
const csv = (...rows: Partial<Record<(typeof ORDER_CSV_COLUMNS)[number], string>>[]) =>
  toCsv(
    [...ORDER_CSV_COLUMNS],
    rows.map((r) => ORDER_CSV_COLUMNS.map((c) => ({ ...ORDER_CSV_EXAMPLE, ...r })[c])),
  )
const error = (text: string) => {
  const r = parseOrderCsv(text, now)
  assert.equal(r.ok, false)
  return r.ok ? '' : r.error
}

// 양식 예시 그대로 → 한 건, 번호는 숫자만 · 결제 방식 코드 · 수거 일시 ISO
const ok = parseOrderCsv(
  csv({ '수거 희망 일시': '2026-11-02 09:00' }, { '보내는 분': '박지호', '결제 방식': '' }),
  now,
)
assert.ok(ok.ok)
assert.equal(ok.orders.length, 2)
assert.equal(ok.orders[0].sender.phoneNumber, '01066382047')
assert.equal(ok.orders[0].paymentMethod, 'MONTHLY')
assert.equal(ok.orders[0].pickupAt, '2026-11-02T00:00:00.000Z') // KST 09:00 (TZ=Asia/Seoul로 실행)
assert.equal(ok.orders[0].items.document, 1)
assert.equal(ok.orders[1].paymentMethod, 'MONTHLY') // 비우면 월정산

// 오류는 엑셀 행 번호로 (1행 = 머리줄) — 첫 오류만
assert.equal(
  error(csv({}, { '받는 분 전화번호': '010-12' })),
  '3행 받는 분 전화번호 형식이 맞지 않아 등록하지 못했습니다.',
)
assert.equal(
  error(csv({ 서류: '0', '기타 품목': '' })),
  '2행 품목이 하나도 없어 등록하지 못했습니다.',
)
assert.equal(
  error(csv({ '결제 방식': '현금' })),
  "2행 결제 방식은 '월정산 · 그룹카드 · 개인카드' 중 하나로 적어 주세요.",
)
assert.equal(
  error(csv({ '수거 희망 일시': '2026-10-01 09:00' })),
  '2행 수거 희망 일시가 지났거나 없는 날짜입니다.',
)
assert.equal(
  error(toCsv(['이름'], [['강도윤']])),
  "'보내는 분' 열이 없습니다. 양식을 받아 확인해 주세요.",
)
assert.equal(error(toCsv([...ORDER_CSV_COLUMNS], [])), '주문이 한 줄도 없습니다.')

// 열 순서가 달라도 · 다른 열이 있어도 이름으로 찾음
const shuffled = toCsv(
  ['메모', ...[...ORDER_CSV_COLUMNS].reverse()],
  [['무시', ...[...ORDER_CSV_COLUMNS].reverse().map((c) => ORDER_CSV_EXAMPLE[c])]],
)
assert.ok(parseOrderCsv(shuffled, now).ok)

// 내보내기 → 가져오기 왕복: 주문 번호를 지우면 같은 내용으로 들어가고, 그대로면 막힘
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
  clientComment: '경비실',
}
const exported = (no: string) =>
  toCsv(
    [...ORDER_CSV_EXPORT_PREFIX, ...ORDER_CSV_COLUMNS],
    [[no, '결제 완료', '2026-10-31 13:12', ...toOrderCsvCells(row)]],
  )
assert.equal(
  error(exported('10519')),
  '2행 이미 있는 주문(주문 번호 10519)입니다. 새로 추가하려면 주문 번호 칸을 비워 주세요.',
)
const back = parseOrderCsv(exported(''), now)
assert.ok(back.ok)
assert.deepEqual(back.orders[0], {
  sender: row.sender,
  receiver: row.receiver,
  items: row.items,
  declaredValue: 30000,
  pickupAt: '2026-11-02T00:00:00.000Z',
  paymentMethod: 'GROUP_CARD',
  request: '경비실',
})

console.log('orderCsv.test ok')
