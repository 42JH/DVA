import { useEffect, useRef, type ReactNode } from 'react'
import { useExitGhost } from '@/shared/lib/useExitGhost'
import { Button } from './Button'

// 확인 창 (와이어프레임 13 · 14) — 560 폭 · 제목 · 대상 한 줄(회색) · 빨간 경고 · [취소] [확정]
// 지금은 고객 탈퇴 확인에서만 씀 (다른 확인 창은 Modal.tsx의 Confirm)
// 뒤 화면을 #2B2F36 40%로 가리고, Esc로 닫힘. 창 자체는 DOM 흐름 밖(fixed)
// 키보드: 열면 창 안 첫 칸으로 포커스, Tab은 창 안에서만 돎, 닫으면 연 버튼으로 돌아감. 창이 겹치면 맨 위 창만 키를 받음

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
const FIRST_FIELD =
  'input:not([disabled]),select:not([disabled]),textarea:not([disabled]),button:not([disabled]):not([aria-label="닫기"])'
// 닫힐 때 배경 · 창이 사라지는 애니메이션 (여는 쪽이 바로 지워도 복제본이 0.15초 사라짐, 11/01)
const EXIT_SWAP = [
  ['motion-safe:animate-dim-in', 'animate-dim-out'],
  ['motion-safe:animate-pop-in', 'animate-pop-out'],
] as const

function Overlay({
  onClose,
  children,
  label,
}: {
  onClose: () => void
  children: ReactNode
  label: string
}) {
  const root = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const downOnDim = useRef(false) // 누르기 시작한 곳이 어두운 배경일 때만 닫음 (창 안에서 끌다가 밖에서 놓으면 안 닫힘)
  useExitGhost(root, EXIT_SWAP, 200)

  // 열 때 한 번 (onClose가 렌더마다 새 함수여도 다시 안 돎)
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    // 확정 버튼(data-autofocus)이 먼저 — 확인 창에서 Enter = 확인 (첫 버튼 [취소]에 두면 Enter가 취소가 됨)
    const el = box.current
    ;(
      el?.querySelector<HTMLElement>('[data-autofocus]') ??
      el?.querySelector<HTMLElement>(FIRST_FIELD) ??
      el
    )?.focus()
    return () => prev?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = box.current
      const dialogs = document.querySelectorAll('[role="dialog"]')
      if (!el || dialogs[dialogs.length - 1] !== el) return
      if (e.key === 'Escape') return onClose()
      if (e.key === 'Enter' && e.repeat) return e.preventDefault() // 창을 연 Enter를 꾹 눌러도 바로 확정되지 않게
      if (e.key !== 'Tab') return
      const els = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)]
      const first = els[0]
      const last = els[els.length - 1]
      const cur = document.activeElement
      const inside = cur !== el && el.contains(cur)
      if (!first) e.preventDefault()
      else if (e.shiftKey ? !inside || cur === first : !inside || cur === last) {
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div
      ref={root}
      className="fixed inset-0 z-50 grid place-items-center bg-ink/40 motion-safe:animate-dim-in"
      onMouseDown={(e) => (downOnDim.current = e.target === e.currentTarget)}
      onClick={(e) => downOnDim.current && e.target === e.currentTarget && onClose()}
    >
      <div
        ref={box}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={(e) => e.stopPropagation()} // 창이 클릭되는 줄 안에 그려져도 그 줄의 클릭으로 안 번지게
        // 창 높이 = 브라우저 높이 - 위아래 32씩까지
        className={`flex max-h-[calc(100dvh-64px)] flex-col rounded-xl bg-surface p-8 shadow-[0_12px_40px_rgba(43,47,54,0.16)] outline-none motion-safe:animate-pop-in`}
      >
        {children}
      </div>
    </div>
  )
}

export function ConfirmDialog({
  title,
  target,
  warn,
  okLabel,
  onOk,
  onClose,
  pending,
}: {
  title: string // '이 고객을 탈퇴 처리할까요?'
  target?: string // '김지훈 · 010-1234-5678'
  warn?: string // 빨간 경고 (되돌릴 수 없음)
  okLabel: string // '탈퇴'
  onOk: () => void
  onClose: () => void
  pending?: boolean
}) {
  return (
    <Overlay onClose={onClose} label={title}>
      <div className="flex w-[496px] flex-col gap-2">
        <h2 className="text-card font-bold">{title}</h2>
        {target && (
          // 질문 전문이 올 수 있음(최대 1,000자) — 세 줄까지만, 나머지는 title (11/02)
          <p className="line-clamp-3 text-body break-words text-sub" title={target}>
            {target}
          </p>
        )}
        {warn && (
          <p className="mt-3 flex items-start gap-2 text-label font-semibold text-danger">
            {/* 아이콘은 첫 줄 높이(1.4em) 칸 가운데 — 글꼴이 바뀌어도 첫 줄과 나란히 */}
            <span className="flex h-[1.4em] shrink-0 items-center">
              <svg
                viewBox="0 0 20 20"
                className="size-5"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.6}
                strokeLinecap="round"
                aria-hidden
              >
                <circle cx="10" cy="10" r="7.5" />
                <path d="M10 6.5v4M10 13.5v.1" />
              </svg>
            </span>
            {warn}
          </p>
        )}
        <div className="mt-8 flex justify-end gap-3">
          <Button onClick={onClose}>취소</Button>
          <Button kind="danger" onClick={onOk} disabled={pending} data-autofocus>
            {okLabel}
          </Button>
        </div>
      </div>
    </Overlay>
  )
}
