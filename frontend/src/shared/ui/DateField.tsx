import { useState } from 'react'
import { Calendar } from './Calendar'
import { todayYmd, type Ymd } from '@/shared/lib/dateRange'

// 날짜 칸 하나 — '날짜 10.20 (오늘) 📅' (04 · 02 · 03 공통). 오늘 · 1주일 · 기간 선택 버튼 셋을 대신함 (10/27)
// 누르면 아래에 달력(하루는 같은 날을 두 번, 범위는 시작 · 끝). value가 null이면 오늘
// 10/30 연도 규칙: 올해면 '10.20', 한쪽이라도 다른 해면 양쪽 다 '2025.12.29 ~ 2026.01.04'

export function DateField({
  value,
  onChange,
}: {
  value: { from: Ymd; to: Ymd } | null
  onChange: (range: { from: Ymd; to: Ymd }) => void
}) {
  const [open, setOpen] = useState(false)
  const today = todayYmd()
  const range = value ?? { from: today, to: today }
  const withYear = ![range.from, range.to].every((s) => s.slice(0, 4) === today.slice(0, 4))
  const show = (s: Ymd) => (withYear ? s : s.slice(5)).replaceAll('-', '.')
  const text =
    range.from === range.to
      ? `${show(range.from)}${range.from === today ? ' (오늘)' : ''}`
      : `${show(range.from)} ~ ${show(range.to)}`

  return (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`flex h-12 items-center gap-2 rounded-lg bg-surface px-5 text-body whitespace-nowrap ${
          open ? 'ring-[1.5px] ring-action ring-inset' : 'ring-1 ring-line ring-inset'
        }`}
      >
        <span className="text-sub">날짜</span>
        <span className="font-semibold text-ink">{text}</span>
        <svg
          viewBox="0 0 20 20"
          className="ml-2 size-4 stroke-sub"
          fill="none"
          strokeWidth={1.6}
          strokeLinecap="round"
          aria-hidden
        >
          <rect x="3" y="4" width="14" height="13" rx="2" />
          <path d="M3 8h14M7 2v4M13 2v4" />
        </svg>
      </button>
      {open && (
        <div className="absolute top-full right-0 z-20 mt-2">
          <Calendar
            value={range}
            onApply={(r) => {
              onChange(r)
              setOpen(false)
            }}
            onCancel={() => setOpen(false)}
          />
        </div>
      )}
    </div>
  )
}
