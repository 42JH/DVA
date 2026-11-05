// 실행: npm test (또는 npx tsx --tsconfig tsconfig.app.json src/app/contract/backendContract.test.ts)
// 대표 요청 본문을 백엔드 DTO로 검사 — backend-dto.json = 서버 Swagger(백엔드 DTO에서 만들어짐) 스냅샷 (npm run sync:dto 로 갱신)
// 서버 ValidationPipe와 같은 규칙: 모르는 칸은 거절(forbidNonWhitelisted) · 필수 칸 · 타입 · enum · 길이 · 범위 · 패턴
// 화면 코드가 만드는 본문(빌더 함수)을 그대로 넣어 봄 — 서버가 칸을 빼거나 바꾸면 여기서 먼저 터짐 (예: 좌표 칸 삭제, migration 043)
import assert from 'node:assert/strict'
import type { CustomerAddress, MemberItem } from '@/features/company/api/companyApi'
import type { FaqInput } from '@/features/faq/api/faqApi'
import type { OrderInput } from '@/features/order/api/orderApi'
import { buildCreateOrder } from '@/features/order/api/orderCreate'
import { buildCustomerPatch, buildOrderPatch } from '@/features/order/api/orderPatch'
import type { OrderDetail } from '@/shared/order/orderApi'
import contract from './backend-dto.json'

interface Schema {
  $ref?: string
  type?: string
  nullable?: boolean
  enum?: unknown[]
  properties?: Record<string, Schema>
  required?: string[]
  items?: Schema
  allOf?: Schema[]
  oneOf?: Schema[]
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  minItems?: number
  maxItems?: number
  pattern?: string
  format?: string
}
const schemas = contract.schemas as Record<string, Schema>
const operations = contract.operations as Record<string, Schema>

// Swagger는 `number | null` 칸을 type 'object'(+ minimum · maximum)로 적음 → 숫자로 읽음 (totalAmount · notifiedPrice 등)
const asNumber = (s: Schema): Schema =>
  s.type === 'object' &&
  !s.properties &&
  !s.allOf &&
  (s.minimum !== undefined || s.maximum !== undefined)
    ? { ...s, type: 'number' }
    : s
const resolve = (s: Schema): Schema =>
  s.$ref ? resolve(schemas[s.$ref.split('/').pop()!]) : asNumber(s)

/** allOf까지 합친 칸 목록 · 필수 칸 (InlineMemberDto.address = allOf[CustomerAddressDto] 같은 모양) */
function flat(s: Schema): { props: Record<string, Schema>; required: string[] } {
  const r = resolve(s)
  const parts = [
    r,
    ...(r.allOf ?? []).map(flat).map((p) => ({ properties: p.props, required: p.required })),
  ]
  return {
    props: Object.assign({}, ...parts.map((p) => p.properties ?? {})),
    required: parts.flatMap((p) => p.required ?? []),
  }
}

/** 서버가 거절할 이유 목록 (빈 배열이면 통과) */
function violations(schema: Schema, value: unknown, at = 'body'): string[] {
  const s = resolve(schema)
  if (value === null) return s.nullable ? [] : [`${at}: null 불가`]
  const errs: string[] = []
  const { props, required } = flat(s)
  const isObject = s.type === 'object' || Object.keys(props).length > 0
  if (isObject) {
    if (typeof value !== 'object' || Array.isArray(value)) return [`${at}: 객체여야 함`]
    const obj = value as Record<string, unknown>
    if (Object.keys(props).length)
      for (const k of Object.keys(obj)) if (!(k in props)) errs.push(`${at}.${k}: 서버에 없는 칸`)
    for (const k of required) if (!(k in obj)) errs.push(`${at}.${k}: 필수 칸 없음`)
    for (const [k, ps] of Object.entries(props))
      if (k in obj) errs.push(...violations(ps, obj[k], `${at}.${k}`))
  } else if (s.type === 'array') {
    if (!Array.isArray(value)) return [`${at}: 배열이어야 함`]
    if (s.minItems !== undefined && value.length < s.minItems)
      errs.push(`${at}: ${s.minItems}개 이상`)
    if (s.maxItems !== undefined && value.length > s.maxItems)
      errs.push(`${at}: ${s.maxItems}개 이하`)
    value.forEach((v, i) => s.items && errs.push(...violations(s.items, v, `${at}[${i}]`)))
  } else if (s.type === 'string') {
    if (typeof value !== 'string') return [`${at}: 문자열이어야 함`]
    if (s.minLength !== undefined && value.length < s.minLength)
      errs.push(`${at}: ${s.minLength}자 이상`)
    if (s.maxLength !== undefined && value.length > s.maxLength)
      errs.push(`${at}: ${s.maxLength}자 이하`)
    if (s.pattern && !new RegExp(s.pattern).test(value)) errs.push(`${at}: 형식(${s.pattern}) 아님`)
    if (s.format === 'date-time' && Number.isNaN(Date.parse(value)))
      errs.push(`${at}: 시각 형식 아님`)
  } else if (s.type === 'number' || s.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return [`${at}: 숫자여야 함`]
    if (s.type === 'integer' && !Number.isInteger(value)) errs.push(`${at}: 정수여야 함`)
    if (s.minimum !== undefined && value < s.minimum) errs.push(`${at}: ${s.minimum} 이상`)
    if (s.maximum !== undefined && value > s.maximum) errs.push(`${at}: ${s.maximum} 이하`)
  } else if (s.type === 'boolean' && typeof value !== 'boolean')
    errs.push(`${at}: true/false여야 함`)
  if (s.enum && !s.enum.includes(value))
    errs.push(`${at}: ${JSON.stringify(s.enum)} 중 하나여야 함`)
  // oneOf = 그중 하나는 통과해야 함 (POST /admin/orders의 customerSeq · customer 둘 중 하나 등)
  if (s.oneOf && !s.oneOf.some((o) => violations(o, value, at).length === 0))
    errs.push(`${at}: 허용된 모양(oneOf) 중 맞는 것이 없음`)
  return errs
}

/** 실제로 나가는 JSON(undefined 칸은 빠짐) 그대로 검사 */
const check = (op: string, body: unknown) => {
  const schema = operations[op]
  assert.ok(schema, `스냅샷에 없는 요청: ${op} (npm run sync:dto)`)
  assert.deepEqual(violations(schema, JSON.parse(JSON.stringify(body))), [], op)
}

// ---------- 검사기 자체 — 서버가 거절하는 본문은 여기서도 거절 ----------
const address: CustomerAddress = {
  roadAddress: '서울 강남구 역삼로 150',
  jibunAddress: '서울 강남구 역삼동 737',
  detailAddress: '5층',
  dongName: '역삼동',
  postalCode: '06236',
}
const customerOp = operations['PATCH /api/customers/{id}']
assert.deepEqual(violations(customerOp, { address }), [])
assert.deepEqual(violations(customerOp, { address: { ...address, latitude: 1, longitude: 1 } }), [
  'body.address.latitude: 서버에 없는 칸', // 예전 화면이 보내던 좌표 1 — 서버(043)는 400
  'body.address.longitude: 서버에 없는 칸',
])
const { postalCode: _drop, ...noPostal } = address
void _drop
assert.ok(
  violations(customerOp, { address: noPostal }).includes('body.address.postalCode: 필수 칸 없음'),
)
assert.ok(violations(operations['POST /api/faqs'], { items: [] }).length > 0) // 빈 배열

// ---------- 03 주문 추가 (수기 접수) — POST /admin/orders ----------
const party = (
  name: string,
  phone: string,
  road: string,
  picked: OrderInput['sender']['picked'],
) => ({
  name,
  phoneNumber: phone,
  roadAddress: road,
  detailAddress: null,
  picked,
})
const input: OrderInput = {
  sender: party('강도윤', '01066382047', '서울 강남구 역삼로 150', {
    jibunAddress: '서울 강남구 역삼동 737',
    dongName: '역삼동',
    postalCode: '06236',
  }),
  receiver: party('이영희', '01023456789', '서울 마포구 독막로 301', {
    jibunAddress: '서울 마포구 신수동 1',
    dongName: '신수동',
    postalCode: '04107',
  }),
  items: { document: 0, small: 1, medium: 0, big: 0, other: '서류 봉투' },
  declaredValue: 30000,
  pickupAt: '2026-11-06T10:00:00+09:00',
  paymentMethod: 'PERSONAL_CARD',
  request: '경비실에 맡겨 주세요',
}
check('POST /api/admin/orders', buildCreateOrder(input, 3500))
check('POST /api/admin/orders', buildCreateOrder({ ...input, pickupAt: null }, 3500))

// ---------- 03 주문 수정 — PATCH /orders/{id} · 고객정보에도 저장 — PATCH /customers/{id} ----------
const order: OrderDetail = {
  orderSeq: 7,
  route: 'MANUAL',
  manualBy: null,
  acceptedAt: '2026-11-01T10:00:00+09:00',
  cancelled: false,
  sender: { ...input.sender, ...input.sender.picked, picked: undefined },
  receiver: { ...input.receiver, ...input.receiver.picked, picked: undefined },
  items: { document: 1, small: 0, medium: 2, big: 0, other: null },
  pickupRequestedAt: '2026-11-02T00:00:00.000Z',
  itemPrice: 30000,
  clientComment: null,
  paymentMethod: 'MONTHLY',
  paymentState: 'UNPAID',
  relatedCalls: [],
  version: 4,
}
const moved: OrderInput = {
  ...input,
  sender: {
    ...order.sender,
    name: '강도현',
    roadAddress: '서울 서초구 강남대로 1',
    detailAddress: '3층',
    picked: { jibunAddress: '서울 서초구 양재동 1', dongName: '양재동', postalCode: '06792' },
  },
  receiver: { ...order.receiver, detailAddress: '202호' },
  items: { ...order.items, medium: 3 },
  paymentMethod: 'GROUP_CARD',
}
const { patch } = buildOrderPatch(order, 101, moved)
assert.ok(patch)
check('PATCH /api/orders/{id}', patch) // 주소 다시 검색 · 상세주소 · 수량 · 결제 · 수거 일시
check(
  'PATCH /api/orders/{id}',
  buildOrderPatch({ ...order, notifiedPrice: null }, null, { ...moved, shippingFee: 4000 }).patch,
)
const customerPatch = buildCustomerPatch(order, moved)
assert.ok(customerPatch?.address)
check('PATCH /api/customers/{id}', customerPatch)

// ---------- 08 사원 등록 · 사원 주소 저장 (companyApi.addMembers · saveCustomerAddress와 같은 본문) ----------
const members: MemberItem[] = [
  {
    employeeNo: '00121',
    name: '이서미',
    phoneNumber: '01024813375',
    role: 'ORG_ADMIN',
    departmentSeq: 3,
  },
  { employeeNo: '00134', name: '박준호', phoneNumber: '01077135092', departmentSeq: null }, // 역할 생략 = 유지 · 부서 없음
]
check('POST /api/companies/{id}/members', { items: members })
check('PATCH /api/customers/{id}', { address })

// ---------- 09 FAQ 작성 · 수정 (faqApi.createFaq · updateFaq와 같은 본문) ----------
const faq: FaqInput = {
  category: '접수',
  question: '박스는 어떻게 포장해요?',
  answer: '테이프로 단단히 붙여 주세요.',
}
check('POST /api/faqs', { items: [faq] })
check('PATCH /api/faqs/{id}', faq)

console.log('backendContract.test.ts OK')
