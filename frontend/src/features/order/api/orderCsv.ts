// 03 CSV로 주문 추가 — CSV 글을 주문 추가 본문(OrderInput) 목록으로. React를 모르는 순수 함수 (실행해서 확인: orderCsv.test.ts)
// 열은 이름으로 찾음 (순서 · 다른 열은 상관없음). 한 줄이라도 틀리면 전부 안 넣고 첫 오류를 'n행 …'으로 (디자인 08 CSV 오류와 같은 문장)
// 내보내기도 같은 열(+ 앞에 주문 번호 · 상태 · 접수 시각)이라 내보낸 파일을 양식으로 쓸 수 있음. 주문 번호가 적힌 줄은 막음 (같은 주문 두 번 방지)
import { parseCsv } from '@/shared/lib/csv'
import { addDays, todayYmd } from '@/shared/lib/dateRange'
import { fromDateTimeLocal, toDateTimeLocal } from '@/shared/lib/format'
import { PAYMENT_METHOD_LABEL } from '@/shared/order/labels'
import type { OrderInput, OrderRow, Party, PaymentMethod } from './orderApi'

export const ORDER_CSV_MAX = 500 // 한 번에 넣는 줄 수 (실수로 큰 파일을 넣는 것 방지)

/** 양식 열 (= 주문 추가 창 칸). 필수 열이 없으면 파일 전체를 안 받음 */
export const ORDER_CSV_COLUMNS = [
  '보내는 분',
  '보내는 분 전화번호',
  '보내는 분 주소',
  '보내는 분 상세주소',
  '받는 분',
  '받는 분 전화번호',
  '받는 분 주소',
  '받는 분 상세주소',
  '서류',
  '소박스',
  '중박스',
  '대박스',
  '기타 품목',
  '물품 가액',
  '수거 희망 일시',
  '결제 방식',
  '고객 요청 사항',
] as const
type Column = (typeof ORDER_CSV_COLUMNS)[number]
const REQUIRED: Column[] = [
  '보내는 분',
  '보내는 분 전화번호',
  '보내는 분 주소',
  '받는 분',
  '받는 분 전화번호',
  '받는 분 주소',
]

/** 양식 예시 한 줄 (양식 받기) */
export const ORDER_CSV_EXAMPLE: Record<Column, string> = {
  '보내는 분': '강도윤',
  '보내는 분 전화번호': '010-6638-2047',
  '보내는 분 주소': '서울 강남구 역삼로 150',
  '보내는 분 상세주소': '5층',
  '받는 분': '이영희',
  '받는 분 전화번호': '010-2345-6789',
  '받는 분 주소': '서울 마포구 독막로 301',
  '받는 분 상세주소': '1402호',
  서류: '1',
  소박스: '0',
  중박스: '0',
  대박스: '0',
  '기타 품목': '',
  '물품 가액': '30000',
  '수거 희망 일시': `${addDays(todayYmd(), 1)} 09:00`, // 늘 내일 — 받은 양식을 그대로 넣어도 '지난 날짜'가 안 되게
  '결제 방식': '월정산',
  '고객 요청 사항': '경비실에 맡겨 주세요',
}

/** 내보내기 앞 3열 — 가져오기에서 주문 번호 · 상태 · 접수 시각은 읽지 않음 (주문 번호가 있으면 막기만) */
export const ORDER_CSV_EXPORT_PREFIX = ['주문 번호', '상태', '접수 시각'] as const

/** CSV 날짜 모양 '2026-11-02 09:00' (가져오기와 같은 모양, 연도 포함) */
export const csvDateTime = (iso: string) => toDateTimeLocal(new Date(iso)).replace('T', ' ')

/** 주문 한 줄 → 양식 17열 (내보내기). 값이 없으면 빈칸 */
export function toOrderCsvCells(o: OrderRow): string[] {
  const i = o.items
  const cells: Record<Column, string> = {
    '보내는 분': o.sender.name,
    '보내는 분 전화번호': o.sender.phoneNumber,
    '보내는 분 주소': o.sender.roadAddress,
    '보내는 분 상세주소': o.sender.detailAddress ?? '',
    '받는 분': o.receiver.name,
    '받는 분 전화번호': o.receiver.phoneNumber,
    '받는 분 주소': o.receiver.roadAddress,
    '받는 분 상세주소': o.receiver.detailAddress ?? '',
    서류: i ? String(i.document) : '',
    소박스: i ? String(i.small) : '',
    중박스: i ? String(i.medium) : '',
    대박스: i ? String(i.big) : '',
    '기타 품목': i?.other ?? '',
    '물품 가액': o.itemPrice?.toString() ?? '',
    '수거 희망 일시': o.pickupAt ? csvDateTime(o.pickupAt) : '',
    '결제 방식': o.paymentMethod ? PAYMENT_METHOD_LABEL[o.paymentMethod] : '',
    '고객 요청 사항': o.clientComment ?? '',
  }
  return ORDER_CSV_COLUMNS.map((c) => cells[c])
}

const PAYMENT_BY_LABEL = Object.fromEntries(
  Object.entries(PAYMENT_METHOD_LABEL).map(([code, label]) => [label, code]),
) as Record<string, PaymentMethod>

export type CsvResult = { ok: true; orders: OrderInput[] } | { ok: false; error: string }

/** CSV 글 → 주문 목록 또는 첫 오류. now는 수거 희망 일시가 지났는지 볼 기준 (확인할 때 고정하려고 받음) */
export function parseOrderCsv(text: string, now = new Date()): CsvResult {
  const [header, ...rows] = parseCsv(text)
  if (!header || rows.length === 0) return { ok: false, error: '주문이 한 줄도 없습니다.' }
  if (rows.length > ORDER_CSV_MAX)
    return {
      ok: false,
      error: `한 번에 ${ORDER_CSV_MAX}건까지 넣을 수 있습니다. (${rows.length}건)`,
    }
  const index = new Map(header.map((h, i) => [h.trim(), i]))
  const missing = REQUIRED.find((c) => !index.has(c))
  if (missing) return { ok: false, error: `'${missing}' 열이 없습니다. 양식을 받아 확인해 주세요.` }

  const orders: OrderInput[] = []
  for (const [i, row] of rows.entries()) {
    const line = i + 2 // 엑셀 행 번호 (1행 = 머리줄)
    const get = (c: Column) => (index.has(c) ? (row[index.get(c)!] ?? '').trim() : '')
    const fail = (what: string) => ({ ok: false as const, error: `${line}행 ${what}` })

    const existing = index.has('주문 번호') ? (row[index.get('주문 번호')!] ?? '').trim() : ''
    if (existing)
      return fail(
        `이미 있는 주문(주문 번호 ${existing})입니다. 새로 추가하려면 주문 번호 칸을 비워 주세요.`,
      )

    const party = (who: '보내는 분' | '받는 분'): Party | string => {
      const phone = get(`${who} 전화번호`).replace(/\D/g, '')
      if (!get(who)) return `${who} 이름이 비어 있어 등록하지 못했습니다.`
      if (phone.length !== 10 && phone.length !== 11)
        return `${who} 전화번호 형식이 맞지 않아 등록하지 못했습니다.`
      if (!get(`${who} 주소`)) return `${who} 주소가 비어 있어 등록하지 못했습니다.`
      return {
        name: get(who),
        phoneNumber: phone,
        roadAddress: get(`${who} 주소`),
        detailAddress: get(`${who} 상세주소`) || null,
      }
    }
    const sender = party('보내는 분')
    if (typeof sender === 'string') return fail(sender)
    const receiver = party('받는 분')
    if (typeof receiver === 'string') return fail(receiver)

    const counts: number[] = []
    for (const c of ['서류', '소박스', '중박스', '대박스'] as const) {
      const v = get(c) || '0'
      if (!/^\d{1,2}$/.test(v)) return fail(`${c} 수량은 0~99 숫자로 적어 주세요.`)
      counts.push(Number(v))
    }
    const other = get('기타 품목') || null
    if (counts.every((n) => n === 0) && !other)
      return fail('품목이 하나도 없어 등록하지 못했습니다.')

    const price = get('물품 가액').replace(/[,원\s]/g, '')
    if (price && !/^\d{1,10}$/.test(price)) return fail('물품 가액은 숫자로 적어 주세요.')

    const pickupText = get('수거 희망 일시')
    let pickupAt: string | null = null
    if (pickupText) {
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(pickupText))
        return fail("수거 희망 일시는 '2026-11-02 09:00' 모양으로 적어 주세요.")
      pickupAt = fromDateTimeLocal(pickupText.replace(' ', 'T'))
      if (Number.isNaN(Date.parse(pickupAt)) || Date.parse(pickupAt) <= now.getTime())
        return fail('수거 희망 일시가 지났거나 없는 날짜입니다.')
    }

    const paymentText = get('결제 방식')
    const paymentMethod = paymentText ? PAYMENT_BY_LABEL[paymentText] : 'MONTHLY' // 비우면 월정산 (주문 추가 창 기본값)
    if (!paymentMethod)
      return fail("결제 방식은 '월정산 · 그룹카드 · 개인카드' 중 하나로 적어 주세요.")

    orders.push({
      sender,
      receiver,
      items: { document: counts[0], small: counts[1], medium: counts[2], big: counts[3], other },
      declaredValue: price ? Number(price) : null,
      pickupAt,
      paymentMethod,
      request: get('고객 요청 사항') || null,
    })
  }
  return { ok: true, orders }
}
