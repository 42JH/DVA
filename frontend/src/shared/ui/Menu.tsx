import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Icon } from './controls'

const itemsIn = (el: HTMLElement | null) => [
  ...(el?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? []),
]

export interface MenuItem {
  label: string
  onSelect: () => void
}

/** ⋮ 버튼 + 펼침 메뉴 (07 상담가 카드 11/11). 감싸는 칸이 relative여야 버튼 아래 오른쪽 끝에 붙음
 * 바깥 클릭 · Esc로 닫힘, 열면 첫 항목에 포커스, ↑↓로 이동 (WAI-ARIA menu button) */
export function KebabMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    itemsIn(box.current)[0]?.focus()
    const outside = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      setOpen(false)
      trigger.current?.focus() // 닫히면 연 버튼으로 돌아감
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const list = itemsIn(box.current)
    const i = list.indexOf(document.activeElement as HTMLElement)
    const step = e.key === 'ArrowDown' ? 1 : -1
    // 메뉴 밖(버튼)에 포커스가 있으면 ↓ = 첫 항목, ↑ = 마지막 항목
    const next = i < 0 ? (step > 0 ? 0 : list.length - 1) : (i + step + list.length) % list.length
    list[next]?.focus()
  }

  return (
    <div ref={box} className="relative" onKeyDown={open ? onKeyDown : undefined}>
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="grid size-8 place-items-center rounded-md text-ops-sub hover:bg-ops-line/60 hover:text-ops-ink"
      >
        <Icon name="kebab" className="size-5" />
      </button>
      {open && (
        <ul
          role="menu"
          aria-label={label}
          className="absolute top-full right-0 z-10 mt-1 min-w-32 rounded-lg border border-ops-line bg-white py-1 shadow-lg"
        >
          {items.map((it) => (
            <li key={it.label} role="none">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false)
                  it.onSelect()
                }}
                className="w-full px-3 py-2 text-left text-[14px] whitespace-nowrap hover:bg-ops-paper focus-visible:bg-ops-paper focus-visible:outline-none"
              >
                {it.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
