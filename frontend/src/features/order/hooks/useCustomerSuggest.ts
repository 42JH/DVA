// 수기 주문 보내는 분 · 받는 분 추천 (11/09 사용자)
// 보내는 분 = 전체 고객(이름 일부 · 번호 11자리), 받는 분 = 그 고객의 개인 주소록(이름 · 번호 일부, 칸을 누르면 바로)
import { useQuery } from '@tanstack/react-query'
import { customerQueries, type Address } from '@/shared/customer/customerApi'
import { useDebounced } from '@/shared/lib/useDebounced'

/** 추천 한 줄 — 고객이든 주소록이든 같은 모양 (고르면 이 값으로 칸을 채움) */
export interface Suggestion {
  key: string
  name: string
  phoneNumber: string
  address: Address | null
  label?: string | null // 주소록 별칭 ('회사' 등)
}

type Typed = { name: string; phone: string }

export function useCustomerSuggest(
  sender: Typed,
  receiver: Typed,
  orderCustomerSeq: number | null, // 수정 창의 주문 고객
) {
  const senderName = useDebounced(sender.name)
  const senderPhone = useDebounced(sender.phone)
  const receiverName = useDebounced(receiver.name)
  const receiverPhone = useDebounced(receiver.phone)

  const byName = useQuery(customerQueries.search(senderName))
  const byPhone = useQuery(customerQueries.search(senderPhone))

  // 받는 분 주소록의 주인: 보내는 분 번호(11자리)의 고객 → 없으면 수정 창의 주문 고객
  // 추천에서 보내는 분을 고르면 번호가 채워지니 같은 길로 연결됨
  const owner =
    byPhone.data?.data.find((c) => c.phoneNumber === sender.phone)?.customerSeq ?? orderCustomerSeq
  const pinsByName = useQuery({
    ...customerQueries.pins(owner ?? 0, receiverName),
    enabled: owner !== null,
  })
  const pinsByPhone = useQuery({
    ...customerQueries.pins(owner ?? 0, receiverPhone),
    enabled: owner !== null,
  })

  const customers = (list: typeof byName.data): Suggestion[] =>
    (list?.data ?? []).map((c) => ({
      key: `c${c.customerSeq}`,
      name: c.name,
      phoneNumber: c.phoneNumber,
      address: c.address,
    }))
  const pins = (list: typeof pinsByName.data): Suggestion[] =>
    owner === null
      ? [] // 주인이 없어졌으면(번호를 지움) 지난 주소록을 보여 주지 않음
      : (list?.data ?? []).map((p) => ({
          key: `p${p.personalPinSeq}`,
          name: p.addressData.name,
          phoneNumber: p.addressData.phoneNumber,
          address: p.addressData,
          label: p.label,
        }))

  return {
    owner, // 받는 분 주소록의 주인 — 주문 추가 뒤 새 받는 분을 여기에 저장
    sender: { byName: customers(byName.data), byPhone: customers(byPhone.data) },
    receiver: { byName: pins(pinsByName.data), byPhone: pins(pinsByPhone.data) },
  }
}
