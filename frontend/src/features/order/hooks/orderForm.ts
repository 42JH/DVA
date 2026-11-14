// 03 주문 추가 · 수정 폼의 계산 — 칸 값이 규칙 안인지 · 보낼 입력 · 결제 방식 선택지 · 버튼 줄 오류
// React를 모르는 순수 함수 (실행해서 확인: orderForm.test.ts). 상태 · 요청은 useOrderForm · useOrderPayment · useOrderSubmit
import { PAYMENT_METHOD_LABEL } from '@/shared/order/labels'
import type { Option } from '@/shared/ui'
import type {
  OrderDetail,
  OrderInput,
  Party,
  PartyInput,
  PayContext,
  PaymentMethod,
  PickedAddress,
} from '@/features/order/api/orderApi'
import { BOX_TYPES, type BoxKey } from '@/features/order/api/orderInput'
import { orderErrorText } from '@/features/order/labels'
import {
  MAX_BOXES,
  MAX_DOCUMENTS,
  fromKstLocal,
  pickupOk,
  pickupRange,
  priceOk,
} from '@/features/order/api/orderLimits'
import { isJeju, shippingFeeOf } from '@/features/order/api/orderFee'

export type Side = 'sender' | 'receiver'
/** 입력 중인 칸 그대로 (전부 글자). 보낼 때 Party로 바꿈 */
export type PartyDraft = {
  name: string
  phone: string
  roadAddress: string
  detailAddress: string
  picked?: PickedAddress // 주소를 새로 고르면 지번 · 동 · 우편번호 (서버 필수)
}
/** 폼의 지금 값 */
export interface OrderFormValues {
  parties: Record<Side, PartyDraft>
  counts: Record<BoxKey, number>
  etcItem: string
  declaredValue: string // 숫자만
  pickupAt: string // datetime-local 값 (한국 시간)
  payment: PaymentMethod | null
  request: string
}

export const EMPTY_PARTY: PartyDraft = { name: '', phone: '', roadAddress: '', detailAddress: '' }
export const NO_ITEMS = Object.fromEntries(BOX_TYPES.map((b) => [b.key, 0])) as Record<
  BoxKey,
  number
>
const PAYMENT_OPTIONS: Option<PaymentMethod>[] = (
  ['MONTHLY', 'GROUP_CARD', 'PERSONAL_CARD'] as const
).map((v) => ({ value: v, label: PAYMENT_METHOD_LABEL[v] }))
const orNull = (v: string) => v.trim() || null
// 서버 422 details.field 중 이 창이 칸 아래에 보여 주는 것 (나머지는 아래 버튼 줄에 한 줄로)
const SHOWN_FIELDS = new Set(
  ['sender', 'receiver']
    .flatMap((s) => ['name', 'phoneNumber', 'roadAddress', 'detailAddress'].map((f) => `${s}.${f}`))
    .concat(['items.other', 'itemPrice', 'pickupRequestedAt', 'clientComment']),
)
// 접수 중단 주문 접수 결과(응답 status) → 목록 위 한 줄. ACCEPTED만 디버 접수 완료
const SUBMIT_RESULT: Partial<Record<string, string>> = {
  ACCEPTED: '접수했습니다.',
  notPaid: '접수했습니다. 고객 결제를 기다리는 중이에요.',
  PAID: '접수했습니다. 디버 접수를 이어서 진행해요.',
  SUBMITTING: '접수를 처리하는 중이에요. 잠시 뒤 목록에서 확인해 주세요.',
  SUBMISSION_FAILED: '접수는 됐지만 디버 전송이 실패했어요. 상세에서 [다시 접수]를 눌러 주세요.',
}
export const submitResultText = (status: string) =>
  SUBMIT_RESULT[status] ?? '접수를 요청했습니다. 목록에서 상태를 확인해 주세요.'

export const draftOf = (p: Party): PartyDraft => ({
  name: p.name,
  phone: p.phoneNumber,
  roadAddress: p.roadAddress,
  detailAddress: p.detailAddress ?? '',
})

export const digits = (v: string, max: number) => v.replace(/\D/g, '').slice(0, max)
// 서버 규칙 (11/11): 보내는 분 = 휴대전화만, 받는 분 = 휴대전화 + 02(9~10) + 기타 지역번호(10~11) + 070(11)
export const PHONE_RULE: Record<Side, { re: RegExp; message: string }> = {
  sender: {
    re: /^01[016-9]\d{8}$/,
    message: '010 등으로 시작하는 휴대전화 11자리로 입력해 주세요.',
  },
  receiver: {
    re: /^(?:01[016-9]\d{8}|02\d{7,8}|0[3-6][1-5]\d{7,8}|070\d{8})$/,
    message: '휴대전화 또는 지역번호를 포함한 전화번호로 입력해 주세요.',
  },
}
export const phoneOk = (side: Side, p: string) => PHONE_RULE[side].re.test(p)
const partyOk = (side: Side, p: PartyDraft) =>
  p.name.trim() !== '' && phoneOk(side, p.phone) && p.roadAddress !== ''

/** 수거 희망이 범위 밖인가 — 같은 형식 문자열이라 비교 가능. 수정에서 원래 값을 안 건드렸으면 범위 밖이어도 통과 (이미 지난 주문의 다른 칸만 고칠 때) */
export const pickupOutOf = (pickupAt: string, initial: string, r: { min: string; max: string }) =>
  pickupAt !== '' && pickupAt !== initial && !pickupOk(pickupAt, r)

/** 칸 값이 규칙을 벗어났는지 · 배송비. 수정에서 옛 값 그대로면 범위 밖이어도 통과 (initial = 창을 열 때의 가액 · 수거 칸 값) */
export function limitsOf(
  v: OrderFormValues,
  order: OrderDetail | undefined,
  initial: { price: string; pickup: string },
  now: Date,
) {
  const pickup = pickupRange(now)
  const boxTotal = v.counts.small + v.counts.medium + v.counts.big
  const was = order?.items
  // 배송비 — 품목 개수로 자동 계산, 직접 입력 없음 (11/06). 추가 · 접수 중단 주문 수정에만 (그 외 수정은 그대로 유지)
  const shippingFee = shippingFeeOf(
    v.counts,
    isJeju(v.parties.sender.roadAddress) || isJeju(v.parties.receiver.roadAddress), // 제주 +3,000원
  )
  return {
    pickup,
    pickupOut: pickupOutOf(v.pickupAt, initial.pickup, pickup),
    priceOut:
      v.declaredValue !== '' &&
      v.declaredValue !== initial.price &&
      !priceOk(Number(v.declaredValue)),
    boxTotal,
    // 직접 입력은 max를 넘을 수 있음 — 몰래 줄이지 않고 알림 (11/06)
    boxesOut: boxTotal > MAX_BOXES && boxTotal !== (was ? was.small + was.medium + was.big : 0),
    docsOut: v.counts.document > MAX_DOCUMENTS && v.counts.document !== (was?.document ?? 0),
    hasItem: BOX_TYPES.some((b) => v.counts[b.key] > 0) || v.etcItem.trim() !== '',
    shippingFee,
    feeMissing: v.etcItem.trim() !== '' && shippingFee === 0, // 기타 품목만 있으면 0원 → 서버가 1원 이상 필수라 접수 못 함
  }
}
export type OrderLimits = ReturnType<typeof limitsOf>

/** 칸이 다 채워졌고 규칙 안인가 (adding = 주문 추가 — 배송비 · 검색으로 고른 주소가 더 필요) */
export const formFilled = (v: OrderFormValues, lim: OrderLimits, adding: boolean) =>
  partyOk('sender', v.parties.sender) &&
  partyOk('receiver', v.parties.receiver) &&
  lim.hasItem &&
  (!adding || lim.shippingFee >= 1) && // 추가: 배송비 필수 (명세 4.4)
  (!adding || (!!v.parties.sender.picked && !!v.parties.receiver.picked)) && // 추가: 주소는 검색으로 고른 것만
  v.declaredValue !== '' && // 물품 가액 필수 (명세 4.4, 11/01 결정)
  !lim.pickupOut &&
  !lim.priceOut &&
  !lim.boxesOut &&
  !lim.docsOut

/** 물품 칸 아래 오류 한 줄 */
export const itemsErrorOf = (lim: OrderLimits, showFee: boolean) =>
  [
    lim.boxesOut && `박스는 소 · 중 · 대 합계 ${MAX_BOXES}개까지예요.`,
    lim.docsOut && `서류는 ${MAX_DOCUMENTS}개까지예요.`,
    showFee && lim.feeMissing && '배송비를 계산하려면 박스나 서류를 1개 이상 넣어 주세요.',
  ]
    .filter(Boolean)
    .join(' ') || undefined

/** 폼 값 → 보낼 입력. was = 창을 열 때의 주문 · 수거 칸 값, 접수 중단 주문이면 배송비도 */
export function toInput(
  v: OrderFormValues,
  was: { order?: OrderDetail; initialPickup: string; collecting: boolean; shippingFee: number },
): OrderInput {
  const party = (p: PartyDraft): PartyInput => ({
    name: p.name.trim(),
    phoneNumber: p.phone,
    roadAddress: p.roadAddress,
    detailAddress: orNull(p.detailAddress),
    picked: p.picked,
  })
  // 안 건드렸으면 서버 원래 값 — 칸은 분까지라 다시 바꾸면 초가 0이 되어 '바뀜'으로 잡힘
  const untouched = v.pickupAt === was.initialPickup
  const typed = v.pickupAt ? fromKstLocal(v.pickupAt) : null
  return {
    sender: party(v.parties.sender),
    receiver: party(v.parties.receiver),
    items: { ...v.counts, other: orNull(v.etcItem) },
    declaredValue: v.declaredValue ? Number(v.declaredValue) : null,
    pickupAt: untouched ? (was.order?.pickupRequestedAt ?? null) : typed,
    paymentMethod: v.payment,
    request: orNull(v.request),
    shippingFee: was.collecting ? was.shippingFee || null : undefined,
  }
}

const offHint = (isCompany: boolean, method: PaymentMethod) => {
  if (isCompany) return '기업 설정에서 꺼짐'
  return method === 'GROUP_CARD' ? '기업 고객만' : '쓸 수 없음'
}
/** 결제 자격 (11/10) — 보내는 분 = 주문 고객. 자격을 받기 전(payCtx 없음)엔 모두 켬 (접수 때 서버가 다시 확인)
 * 기업 소속: 월결제 · 그룹카드는 기업 · 부서 설정이라 꺼져 있으면 못 고름. 개인: 그룹카드 불가, 월결제은 물어보고 추가 */
export function paymentChoices(payCtx: PayContext | undefined) {
  const isCompany = !!payCtx && payCtx.company !== null
  const canAddMonthly = !!payCtx && !isCompany && !payCtx.available.includes('MONTHLY')
  const usable = (m: PaymentMethod) =>
    !payCtx || payCtx.available.includes(m) || (m === 'MONTHLY' && canAddMonthly)
  return {
    isCompany,
    canAddMonthly,
    options: PAYMENT_OPTIONS.map((o) =>
      usable(o.value) ? o : { ...o, disabledHint: offHint(isCompany, o.value) },
    ),
  }
}

/** 버튼 줄에 보일 오류 한 줄 — 칸에 못 붙인 오류 · 칸 오류가 없는 실패(연결 · 409 등)만. 오류는 모양으로 봄(orderErrorText와 같게) */
export function submitErrorOf(err: unknown, action: '저장' | '접수'): string | null {
  if (!err) return null
  const { code, details = [] } = err as { code?: string; details?: { field: string }[] }
  if (code === 'VERSION_CONFLICT') return null // 창 위에 안내(onConflict)
  if (details.length && details.every((d) => SHOWN_FIELDS.has(d.field))) return null // 칸 아래에 이미 보임
  return orderErrorText(err, action)
}
