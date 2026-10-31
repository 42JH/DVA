// 실행: TZ=Asia/Seoul npx tsx --tsconfig tsconfig.app.json src/features/order/api/orderCsv.test.ts  (프레임워크 없이 assert만)
import assert from 'node:assert/strict'
import { toCsv } from '@/shared/lib/csv'
import { ORDER_CSV_COLUMNS, ORDER_CSV_EXAMPLE, parseOrderCsv } from './orderCsv'

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

console.log('orderCsv.test ok')
