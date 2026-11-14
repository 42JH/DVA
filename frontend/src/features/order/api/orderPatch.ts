// 03 주문 수정 — 원래 값과 입력값을 비교해 바뀐 칸만 PATCH 본문으로 (연동 상세명세 4.3). React · 네트워크를 모르는 순수 함수
// 서버는 보낸 하위 값만 병합(생략 = 유지) → 바뀐 것만 보내야 다른 관리자 · AI가 고친 칸을 덮지 않음. 빈 변경은 서버가 거절 → null
import type { OrderDetail, Party, PaymentMethod } from '@/shared/order/orderApi'
import type { PaymentMethodDto } from '@/shared/order/orderDto'
import type { OrderInput, PartyInput } from './orderInput'

const METHOD: Record<Exclude<PaymentMethod, 'BRANCH_VISIT'>, PaymentMethodDto> = {
  PERSONAL_CARD: 'billing',
  MONTHLY: 'credit',
  GROUP_CARD: 'groupBilling',
}

export interface OrderPatch {
  expectedVersion: number
  pickupRequestedAt?: string | null
  paymentMethodType?: PaymentMethodDto
  parcels?: Record<string, unknown>[] // ParcelChange 하나 (수기 = 받는 분 1명, 11/01)
}

/** 바뀐 사람 칸만 (이름 · 전화 · 상세주소). 도로명이 바뀌면 주소 전체(지번 · 동 · 우편번호)를 함께
 *  좌표 칸은 서버 주소에서 빠짐(migration 043) — 보내면 400(모르는 칸 거절) */
function partyPatch(before: Party, after: PartyInput) {
  const out: Record<string, string | number> = {}
  if (after.name !== before.name) out.name = after.name
  if (after.phoneNumber !== before.phoneNumber) out.phoneNumber = after.phoneNumber
  if ((after.detailAddress ?? '') !== (before.detailAddress ?? ''))
    out.detailAddress = after.detailAddress ?? '' // 빈 문자열 = 비우기 (null 불가, 명세)
  if (after.roadAddress !== before.roadAddress && after.picked)
    Object.assign(out, { roadAddress: after.roadAddress, ...after.picked })
  return out
}

/** order = 수정 창을 연 그 배송 상세로 바꿔 끼운 주문(pickParcel), parcelSeq = 그 상세 번호 */
export function buildOrderPatch(
  order: OrderDetail,
  parcelSeq: number | null,
  input: OrderInput,
): { patch: OrderPatch | null; roadChanged: boolean /* 주소 정보가 모자람 */ } {
  const parcel: Record<string, unknown> = {}
  const origin = partyPatch(order.sender, input.sender)
  const destination = partyPatch(order.receiver, input.receiver)
  if (Object.keys(origin).length) parcel.origin = origin
  if (Object.keys(destination).length) parcel.destination = destination
  const counts = [
    ['document', 'documentCount'],
    ['small', 'smallBoxCount'],
    ['medium', 'mediumBoxCount'],
    ['big', 'bigBoxCount'],
  ] as const
  for (const [key, field] of counts)
    if (input.items[key] !== order.items[key]) parcel[field] = input.items[key]
  if ((input.items.other ?? '') !== (order.items.other ?? ''))
    parcel.otherItemDescription = input.items.other ?? ''
  if ((input.request ?? '') !== (order.clientComment ?? ''))
    parcel.clientComment = input.request ?? ''
  if (input.declaredValue !== order.itemPrice) parcel.itemPrice = input.declaredValue
  if (input.shippingFee !== undefined && input.shippingFee !== (order.notifiedPrice ?? null))
    parcel.notifiedPrice = input.shippingFee // 접수 중단 주문만 칸이 있음

  const patch: OrderPatch = { expectedVersion: order.version ?? 0 }
  if (Object.keys(parcel).length)
    patch.parcels = [parcelSeq === null ? parcel : { orderParcelSeq: parcelSeq, ...parcel }]
  // 시각은 글자 모양이 달라도(Z · +09:00) 같은 순간이면 그대로
  const before = order.pickupRequestedAt ? Date.parse(order.pickupRequestedAt) : null
  const after = input.pickupAt ? Date.parse(input.pickupAt) : null
  if (before !== after) patch.pickupRequestedAt = input.pickupAt
  // 미정(null)은 보내지 않음 — 서버는 null을 받지 않고, 생략 = 유지
  if (
    input.paymentMethod !== null &&
    input.paymentMethod !== order.paymentMethod &&
    input.paymentMethod !== 'BRANCH_VISIT'
  )
    patch.paymentMethodType = METHOD[input.paymentMethod]

  // 도로명이 바뀌었는데 검색 결과(지번 · 동 · 우편번호)가 없으면 서버가 거절 → 보내지 않음 (검색으로만 고르므로 보통 없음)
  const lost = (b: Party, a: PartyInput) => a.roadAddress !== b.roadAddress && !a.picked
  const roadChanged = lost(order.sender, input.sender) || lost(order.receiver, input.receiver)
  const empty = !patch.parcels && !('pickupRequestedAt' in patch) && !patch.paymentMethodType
  return { patch: empty ? null : patch, roadChanged }
}

/** 고객정보에도 저장 — PATCH /customers/{customerSeq} 본문 (jiw/order-sender-customer-save.md 4장)
 * 보내는 분의 이름 · 주소가 바뀐 것만. 전화번호는 고객 원본에서 못 바꿈(보내지 않음) → 전화만 바뀌면 null(묻지 않음)
 * address는 전체 교체 객체 — 도로명을 다시 골랐으면 검색 결과, 상세주소만 바뀌었으면 원래 주소의 나머지 칸으로. 모자라면 address는 뺌 */
export interface CustomerPatch {
  name?: string
  address?: {
    roadAddress: string
    jibunAddress: string
    detailAddress: string
    dongName: string
    postalCode: string
  }
}

export function buildCustomerPatch(order: OrderDetail, input: OrderInput): CustomerPatch | null {
  const before = order.sender
  const after = input.sender
  const out: CustomerPatch = {}
  if (after.name !== before.name) out.name = after.name
  const roadChanged = after.roadAddress !== before.roadAddress
  if (roadChanged || (after.detailAddress ?? '') !== (before.detailAddress ?? '')) {
    const rest = roadChanged ? after.picked : before
    if (rest?.jibunAddress && rest.dongName && rest.postalCode)
      out.address = {
        roadAddress: after.roadAddress,
        jibunAddress: rest.jibunAddress,
        detailAddress: after.detailAddress ?? '',
        dongName: rest.dongName,
        postalCode: rest.postalCode,
      }
  }
  return out.name !== undefined || out.address ? out : null
}

/** 접수 중단 주문을 접수하려면 모자란 것 (명세 API-16: 양쪽 완성 주소 · 물품 · 물품 가액 · 상세별 배송비)
 * 빈 배열이면 [접수] 가능. 주소는 다시 검색해 골랐거나(picked) 원래 주소가 완성(지번 · 동 · 우편번호)이어야 함 — 좌표는 서버에서 빠짐 */
export function submitMissing(order: OrderDetail, input: OrderInput): string[] {
  const addressOk = (before: Party, after: PartyInput) =>
    after.picked
      ? after.roadAddress !== ''
      : after.roadAddress === before.roadAddress &&
        !!(before.jibunAddress && before.dongName && before.postalCode)
  const out: string[] = []
  for (const [label, before, after] of [
    ['보내는 분', order.sender, input.sender],
    ['받는 분', order.receiver, input.receiver],
  ] as const) {
    if (!after.name || !after.phoneNumber) out.push(`${label} 이름 · 전화번호`)
    if (!addressOk(before, after)) out.push(`${label} 주소(다시 검색)`)
  }
  const i = input.items
  if (!(i.document || i.small || i.medium || i.big || i.other)) out.push('품목')
  if (input.paymentMethod === null) out.push('결제 방식') // 미정은 접수 전에 골라야 함 (서버)
  if (input.declaredValue === null) out.push('물품 가액')
  if (!input.shippingFee || input.shippingFee < 1) out.push('배송비')
  return out
}
