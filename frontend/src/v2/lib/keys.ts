// v2 키보드 — 표 줄 이동 · Esc로 닫기
import { useEffect, type KeyboardEvent as ReactKeyboardEvent } from 'react'

/** 표 줄 키보드: Enter · Space = 열기, ↑ ↓ = 위 · 아래 줄로 (상세가 열려 있으면 그 줄을 바로 보여 줌 — onFocus에서) */
export function rowKeys(onPick: () => void) {
  return (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onPick()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault() // 목록이 같이 스크롤되지 않게 — 초점 이동이 알아서 보이게 함
      const to =
        e.key === 'ArrowDown'
          ? e.currentTarget.nextElementSibling
          : e.currentTarget.previousElementSibling
      ;(to as HTMLElement | null)?.focus()
    }
  }
}

/** Esc로 닫기 — 글 칸 · 열린 창(dialog) 안에서 누른 Esc는 그쪽 몫 */
export function useEscape(onEscape: () => void) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const t = e.target as HTMLElement | null
      if (
        t?.closest('input, textarea, select, [role="dialog"]') ||
        document.querySelector('[role="dialog"]')
      )
        return
      onEscape()
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [onEscape])
}
