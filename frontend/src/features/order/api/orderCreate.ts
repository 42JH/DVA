// 03 주문 추가(수기 접수) — 창 입력 → POST /admin/orders 본문 (연동 상세명세 4.4). React · 네트워크를 모르는 순수 함수
// 수기 접수 = 주문자 1 + 받는 분 1 → 배송 상세 하나, 총액 = 그 배송비 (11/01 결정). 주문자 = 보내는 분
import type { PaymentMethodDto } from '@/shared/order/orderDto'
import type { OrderInput, PartyInput } from './orderApi'

const METHOD: Record<OrderInput['paymentMethod'], PaymentMethodDto> = {
  PERSONAL_CARD: 'billing',
  MONTHLY: 'credit',
  GROUP_CARD: 'groupBilling',
  BRANCH_VISIT: 'cat', // 창에서 고를 수 없음(예전 조회값) — 타입을 맞추려고만
}

/** 주소는 검색으로 고른 것만(picked) — 서버는 지번 · 동 · 우편번호가 필요. 좌표 칸은 서버에서 빠짐(043) — 보내면 400 */
const address = (p: PartyInput) => ({
  name: p.name,
  phoneNumber: p.phoneNumber,
  roadAddress: p.roadAddress,
  detailAddress: p.detailAddress ?? '',
  jibunAddress: p.picked?.jibunAddress ?? '',
  dongName: p.picked?.dongName ?? '',
  postalCode: p.picked?.postalCode ?? '',
})

export function buildCreateOrder(input: OrderInput, shippingFee: number) {
  return {
    customer: { name: input.sender.name, phoneNumber: input.sender.phoneNumber }, // 수기 = 주문자가 보내는 분
    paymentMethodType: METHOD[input.paymentMethod],
    totalAmount: shippingFee, // 상세 배송비 합계와 같아야 함 (상세 하나)
    ...(input.pickupAt ? { pickupRequestedAt: input.pickupAt } : {}), // 기존 호환용, 서버가 최종 결정
    parcels: [
      {
        origin: address(input.sender),
        destination: address(input.receiver),
        documentCount: input.items.document,
        smallBoxCount: input.items.small,
        mediumBoxCount: input.items.medium,
        bigBoxCount: input.items.big,
        otherItemDescription: input.items.other ?? '',
        clientComment: input.request ?? '',
        itemPrice: input.declaredValue,
        notifiedPrice: shippingFee,
      },
    ],
  }
}
