// 수기 주문 보내는 분 · 받는 분 추천
// 보내는 분 = 전체 고객(이름 일부 · 번호 4자리 이상 일부), 받는 분 = 그 고객의 개인 주소록(이름 · 번호 일부, 칸을 누르면 바로) + 전체 고객
// 받는 분은 같은 회사뿐 아니라 다른 기업 사람일 수 있음 (기업 공유 주소록은 11/01에 없어짐)
import { useQueries, useQuery } from '@tanstack/react-query'
import { customerQueries, type Address } from '@/shared/customer/customerApi'
import { useDebounced } from '@/shared/lib/useDebounced'

/** 추천 한 줄 — 고객이든 주소록이든 같은 모양 (고르면 이 값으로 칸을 채움) */
export interface Suggestion {
  key: string
  name: string
  phoneNumber: string
  address: Address | null
  company: string | null // 기업 사원이면 기업 이름 (번호로 찾음)
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
  const toByName = useQuery(customerQueries.search(receiverName))
  const toByPhone = useQuery(customerQueries.search(receiverPhone))

  // 받는 분 주소록의 주인: 보내는 분 번호와 똑같은 번호의 고객 (부분 검색 결과 중 정확히 일치) → 없으면 수정 창의 주문 고객
  // 추천에서 보내는 분을 고르면 번호가 채워지니 같은 길로 연결됨
  const owner =
    byPhone.data?.data.find((c) => c.phoneNumber === sender.phone)?.customerSeq ?? orderCustomerSeq
  // 빈 칸이면 주소록을 넉넉히 받아 '최근에 보낸 순'으로 정렬한 뒤 앞 10건만 (저장 순서라 자주 보내는 사람이 묻힘)
  const browse = (t: string) => (t.trim() ? 5 : 100)
  const pinsByName = useQuery({
    ...customerQueries.pins(owner ?? 0, receiverName, browse(receiverName)),
    enabled: owner !== null,
  })
  const pinsByPhone = useQuery({
    ...customerQueries.pins(owner ?? 0, receiverPhone, browse(receiverPhone)),
    enabled: owner !== null,
  })
  const sentTo = useQuery({ ...customerQueries.sentTo(owner ?? 0), enabled: owner !== null })
  const lastSent = new Map<string, number>() // 번호 → 몇 번째로 최근에 보냈나 (작을수록 최근)
  sentTo.data?.data.forEach((r, i) => {
    if (!lastSent.has(r.address.phoneNumber)) lastSent.set(r.address.phoneNumber, i)
  })

  // 소속 기업: 같은 검색어로 사원 검색 → 번호가 같으면 그 기업 (고객 검색 응답엔 기업이 없음)
  const members = useQueries({
    queries: [senderName, senderPhone, receiverName, receiverPhone].map((t) =>
      customerQueries.members(t),
    ),
  })
  const companyOf = new Map(
    members.flatMap((m) => m.data?.data ?? []).map((m) => [m.phoneNumber, m.organizationName]),
  )

  const customers = (list: typeof byName.data): Suggestion[] =>
    (list?.data ?? []).map((c) => ({
      key: `c${c.customerSeq}`,
      name: c.name,
      phoneNumber: c.phoneNumber,
      address: c.address,
      company: companyOf.get(c.phoneNumber) ?? null,
    }))
  const pins = (list: typeof pinsByName.data): Suggestion[] =>
    owner === null
      ? [] // 주인이 없어졌으면(번호를 지움) 지난 주소록을 보여 주지 않음
      : [...(list?.data ?? [])]
          .sort(
            (a, b) =>
              (lastSent.get(a.addressData.phoneNumber) ?? Infinity) -
              (lastSent.get(b.addressData.phoneNumber) ?? Infinity),
          ) // 보낸 적 없는 주소는 뒤로, 그 안에서는 저장 순서 그대로(안정 정렬)
          .slice(0, 10)
          .map((p) => ({
            key: `p${p.personalPinSeq}`,
            name: p.addressData.name,
            phoneNumber: p.addressData.phoneNumber,
            address: p.addressData,
            company: companyOf.get(p.addressData.phoneNumber) ?? null,
          }))

  // 주소록 먼저, 같은 번호의 고객은 한 번만
  const both = (mine: Suggestion[], all: Suggestion[]) =>
    mine.concat(all.filter((c) => !mine.some((p) => p.phoneNumber === c.phoneNumber)))

  return {
    sender: { byName: customers(byName.data), byPhone: customers(byPhone.data) },
    receiver: {
      byName: both(pins(pinsByName.data), customers(toByName.data)),
      byPhone: both(pins(pinsByPhone.data), customers(toByPhone.data)),
    },
  }
}
