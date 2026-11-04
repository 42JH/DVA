import { AddressField, TextField } from '@/shared/ui'
import { PartyCard } from '@/shared/order/PartyCards'
import type { useOrderForm } from '@/features/order/hooks/useOrderForm'

// 주문 추가 · 수정 창의 보내는 분 · 받는 분 카드 (주문 상세 창과 같은 하늘색 카드) — 이름 · 전화번호 · 주소(검색으로만) · 상세주소. 라벨 칸 72
export function OrderPartyFields({
  title,
  party,
}: {
  title: string
  party: ReturnType<typeof useOrderForm>['sender']
}) {
  return (
    <PartyCard title={title}>
      <div className="mt-3 flex flex-col gap-2.5 [--field-label:72px]">
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
      </div>
    </PartyCard>
  )
}
