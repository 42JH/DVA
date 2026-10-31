import type { PartyCell } from '@/features/order/hooks/useOrderList'

/** 보내는 분 · 받는 분 칸: 이름(굵게) + 번호 한 줄, 주소 아래 줄 (와이어프레임 03) */
export function OrderPartyCell({ party }: { party: PartyCell }) {
  return (
    <div className="min-w-0">
      <p className="truncate">
        <span className="text-body font-semibold text-ink">{party.name}</span>
        <span className="ml-2 text-label text-sub">{party.phone}</span>
      </p>
      <p className="truncate text-label text-sub">{party.address}</p>
    </div>
  )
}
