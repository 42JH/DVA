import { AddressField, TextField } from '@/shared/ui'
import type { useOrderForm } from '@/features/order/hooks/useOrderForm'

// 주문 추가 창의 보내는 분 · 받는 분 칸 4줄 — 이름 · 전화번호 · 주소(검색으로만) · 상세주소
export function OrderPartyFields({
  title,
  party,
}: {
  title: string
  party: ReturnType<typeof useOrderForm>['sender']
}) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="mb-1 text-body font-bold">{title}</h3>
      <TextField
        label="이름"
        inline
        placeholder="이름"
        value={party.name}
        error={party.nameError}
        onChange={(e) => party.setName(e.target.value)}
      />
      <TextField
        label="전화번호"
        inline
        inputMode="numeric"
        placeholder="숫자만 입력"
        value={party.phone}
        error={party.phoneError}
        onChange={(e) => party.setPhone(e.target.value)}
      />
      <AddressField
        value={party.roadAddress}
        error={party.addressError}
        onSearch={party.openSearch}
        searchLabel={`${title} 주소 검색`}
      />
      <TextField
        label="상세주소"
        inline
        placeholder="선택 (동 · 호수 · 층)"
        value={party.detailAddress}
        error={party.detailError}
        onChange={(e) => party.setDetailAddress(e.target.value)}
      />
    </section>
  )
}
