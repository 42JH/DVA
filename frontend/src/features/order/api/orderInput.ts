// 주문 추가 · 수정 폼이 보내는 입력 모양 — orderApi · orderCreate · orderPatch · draftApi가 같이 씀 (타입만)
import type { OrderDetail, Party, PaymentMethod } from '@/shared/order/orderApi'

export interface PickedAddress {
  jibunAddress: string
  dongName: string
  postalCode: string // 5자리 문자열 (앞 0 보존)
}

/** 창에서 보내는 사람 — 주소를 새로 골랐으면 picked가 있음 */
export type PartyInput = Party & { picked?: PickedAddress }

export interface OrderInput {
  sender: PartyInput
  receiver: PartyInput
  items: OrderDetail['items']
  declaredValue: number | null // 물품 가액 원 (11/01 필수)
  shippingFee?: number | null // 배송비 — 접수 중단 주문을 수정해 접수할 때만 (추가는 createOrder 인자로)
  pickupAt: string | null // ISO 8601 (선택)
  paymentMethod: PaymentMethod | null // null = 미정 그대로 (수정에서 안 고름)
  request: string | null // 고객 요청 사항 (선택)
}
