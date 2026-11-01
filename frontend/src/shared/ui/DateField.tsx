import { useEffect, useRef, useState } from 'react'
import { Calendar } from './Calendar'
import { fmtYmds, todayYmd, type Ymd } from '@/shared/lib/dateRange'

// 날짜 칸 하나 — '날짜 10.20 (오늘) 📅' (04 · 02 · 03 공통). 오늘 · 1주일 · 기간 선택 버튼 셋을 대신함 (10/27)
// 누르면 아래에 달력(하루는 같은 날을 두 번, 범위는 시작 · 끝). value가 null이면 오늘
// 10/30 연도 규칙: 올해면 '10.20', 한쪽이라도 다른 해면 양쪽 다 '2025.12.29 ~ 2026.01.04'

export function DateField({
  value,
  onChange,
  compact,
}: {
  value: { from: Ymd; to: Ymd } | null
  onChange: (range: { from: Ymd; to: Ymd }) => void
  compact?: boolean // 탭 줄 안에 둘 때 높이 40 (02 대시보드). 기본 48 = 목록 맨 윗줄
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)

  // 바깥을 누르거나 Esc면 닫음 (MoreMenu와 같은 방식). 달력 안 클릭은 root 안이라 그대로
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      button.current?.focus() // 키보드 사용자가 제자리로
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  const today = todayYmd()
  const range = value ?? { from: today, to: today }
  const [from, to] = fmtYmds([range.from, range.to], today)
  const text =
    range.from === range.to ? `${from}${range.from === today ? ' (오늘)' : ''}` : `${from} ~ ${to}`

  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`flex ${compact ? 'h-10' : 'h-12'} items-center gap-2 rounded-lg bg-surface px-5 text-body whitespace-nowrap ${
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
