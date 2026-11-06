import { useCallback, useRef, useState } from 'react'
import { useDismiss } from '@/shared/lib/useDismiss'

/** 표 머리줄의 거르기 칸 '주문 상태 ⌄' · '상담 유형 ⌄' (03 · 04, 11/06 시안) — 누르면 고르기 창, 고르면 머리가 그 이름(파랑)
 *  all = '전체' 값 (고르면 머리는 원래 이름으로) */
export function HeadPick<T extends string>({
  label,
  all,
  value,
  options,
  onPick,
}: {
  label: string
  all: T
  value: T
  options: { value: T; label: string }[]
  onPick: (v: T) => void
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(open, root, close)
  const on = value !== all
  return (
    <div ref={root} className="relative justify-self-start">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-1 ${on ? 'text-brand' : 'hover:text-brand'}`}
      >
        {on ? options.find((o) => o.value === value)?.label : label}
        <svg
          viewBox="0 0 24 24"
          className={`size-4 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          aria-label={`${label} — 고르면 그것만`}
          className="absolute top-full left-0 z-20 mt-2 w-max min-w-44 origin-top-left overflow-hidden rounded-xl bg-surface py-1 font-normal shadow-[0_12px_12px_rgba(0,0,0,0.08),0_2px_4px_rgba(0,0,0,0.04)] ring-1 ring-line motion-safe:animate-pop-in"
        >
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="menuitemradio"
              aria-checked={o.value === value}
              onClick={() => {
                onPick(o.value)
                close()
              }}
              className={`flex h-11 w-full items-center px-4 text-left text-body ${o.value === value ? 'font-semibold text-brand' : 'font-normal text-ink hover:bg-bg'}`}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
