import { useEffect, useRef, useState } from 'react'
import { ExitGhost } from '@/shared/lib/useExitGhost'

// ⋮ 더 보기 메뉴 (와이어프레임 10 관리자 권한 관리 — 줄 오른쪽 끝) — 버튼 32 · 펼침 카드 폭 192 · 줄 높이 40
// 항목: 아이콘 + 글자. danger = 빨강 + 위에 구분선(삭제). soon = 꺼짐 + 오른쪽 '준비 중'(API가 아직 없는 기능)
// 바깥 클릭 · Esc · 항목 선택으로 닫힘. 줄 클릭(Table canClick)으로 번지지 않게 클릭을 멈춤

const ICON = {
  key: (
    <>
      <circle cx="13" cy="7" r="3.5" />
      <path d="M10.5 9.5 3.5 16.5M6 14l2 2" />
    </>
  ),
  user: (
    <>
      <circle cx="10" cy="7" r="3.5" />
      <path d="M3.5 17a6.5 6.5 0 0 1 13 0" />
    </>
  ),
  trash: <path d="M3.5 5.5h13M8 5.5V4h4v1.5M5.5 5.5l.8 11h7.4l.8-11M8.5 8.5v5M11.5 8.5v5" />,
} as const

export interface MoreMenuItem {
  key: string
  label: string
  icon: keyof typeof ICON
  danger?: boolean
  soon?: boolean // API가 아직 없어 꺼 둔 항목 (10 비활성화 · 활성화)
  onSelect: () => void
}

export function MoreMenu({ label, items }: { label: string; items: MoreMenuItem[] }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLUListElement>(null) // 닫힐 때 사라지는 애니메이션은 안의 <ExitGhost> (11/01)

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

  return (
    <div ref={root} className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        ref={button}
        type="button"
        aria-label={label} // '김지훈 더 보기'
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`grid size-8 place-items-center rounded-md text-sub hover:bg-bg ${open ? 'bg-bg' : ''}`}
      >
        <svg viewBox="0 0 20 20" className="size-5 fill-current" aria-hidden>
          <circle cx="10" cy="4.5" r="1.5" />
          <circle cx="10" cy="10" r="1.5" />
          <circle cx="10" cy="15.5" r="1.5" />
        </svg>
      </button>

      {open && (
        <ul
          ref={menu}
          role="menu"
          aria-label={label}
          className="absolute top-full right-0 z-20 mt-1 w-48 origin-top-right rounded-xl bg-surface p-2 shadow-[0_8px_24px_rgba(43,47,54,0.12)] ring-1 ring-line ring-inset motion-safe:animate-pop-in"
        >
          <ExitGhost target={menu} />
          {items.map((it) => (
            <li key={it.key} role="none">
              {it.danger && <hr className="mx-2 my-2 border-line" />}
              <button
                type="button"
                role="menuitem"
                disabled={it.soon}
                onClick={() => {
                  setOpen(false)
                  it.onSelect()
                }}
                className={`flex h-9 w-full items-center gap-3 rounded-lg px-3 text-label hover:bg-bg disabled:cursor-not-allowed disabled:text-muted disabled:hover:bg-transparent ${it.danger ? 'text-danger' : 'text-ink'}`}
              >
                <svg
                  viewBox="0 0 20 20"
                  className="size-5 shrink-0 stroke-current"
                  fill="none"
                  strokeWidth={1.6}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  {ICON[it.icon]}
                </svg>
                <span className="flex-1 text-left">{it.label}</span>
                {it.soon && <span className="text-caption text-muted">준비 중</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
