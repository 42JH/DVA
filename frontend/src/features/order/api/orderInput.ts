// 주문 추가 · 수정 폼이 보내는 입력 모양 · 품목 종류 — orderApi · orderCreate · orderPatch · draftApi · 폼 계산이 같이 씀
// 요청을 모름: 순수 함수 테스트에서 그대로 부를 수 있게 요청 모듈(orderApi)과 따로 둠
import type { OrderDetail, Party, PaymentMethod } from '@/shared/order/orderApi'

/** 품목 4종 (와이어프레임 03 · 디버 FAQ '박스 크기') — 주문 상세의 items 키와 같은 순서. 그 밖은 '기타 품목' 글로 */
export const BOX_TYPES = [
  { key: 'document', label: '서류' },
  { key: 'small', label: '소박스' },
  { key: 'medium', label: '중박스' },
  { key: 'big', label: '대박스' },
] as const
export type BoxKey = (typeof BOX_TYPES)[number]['key']

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
