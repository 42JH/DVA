import { Link } from 'react-router'
import type { TodayCard, TodayCardKind } from '@/features/home/hooks/useHome'

// 와이어프레임 01 '접수 card' — 흰 바탕 · 선 · 모서리 10. 호버 = 남색 선 + › 남색
const DOT: Record<TodayCardKind, string> = {
  SUCCESS: 'bg-brand',
  FAILED: 'bg-danger',
  HANDOFF: 'bg-sub',
  COMPLAINT: 'bg-warning',
}

export function TodayStatCard({ card }: { card: TodayCard }) {
  return (
    <Link
      to={card.to}
      className="group flex min-w-0 flex-1 flex-col gap-2 rounded-[10px] bg-surface px-[23px] pt-[15px] pb-4 ring-1 ring-line ring-inset hover:ring-action"
    >
      <span className="flex items-center gap-2 text-label font-bold text-sub">
        <span className={`size-3 shrink-0 rounded-full ${DOT[card.kind]}`} />
        <span className="truncate">{card.label}</span>
        <svg
          viewBox="0 0 6 10"
          className="h-2.5 w-1.5 shrink-0 stroke-muted group-hover:stroke-action"
          fill="none"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M1 1l4 4-4 4" />
        </svg>
      </span>
      <span className="flex items-baseline gap-1">
        <span className="text-[32px] leading-[1.4] font-bold text-ink">{card.count}</span>
        <span className="text-label font-bold text-sub">건</span>
      </span>
    </Link>
  )
}
