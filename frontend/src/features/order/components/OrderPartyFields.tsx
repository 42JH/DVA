import { Button, TextField } from '@/shared/ui'
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
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <TextField
            label="주소"
            inline
            readOnly
            placeholder="검색으로 고르기"
            value={party.roadAddress}
            onClick={party.openSearch}
            className="cursor-pointer bg-bg!"
          />
        </div>
        <Button
          className="h-11! w-11 px-0!"
          onClick={party.openSearch}
          aria-label={`${title} 주소 검색`}
        >
          <svg
            viewBox="0 0 20 20"
            className="mx-auto size-5 stroke-ink"
            fill="none"
            strokeWidth={1.6}
            strokeLinecap="round"
          >
            <circle cx="8.5" cy="8.5" r="6" />
            <path d="M13 13l4.5 4.5" />
          </svg>
        </Button>
      </div>
      <TextField
        label="상세주소"
        inline
        placeholder="선택 (동 · 호수 · 층)"
        value={party.detailAddress}
        onChange={(e) => party.setDetailAddress(e.target.value)}
      />
    </section>
  )
}
