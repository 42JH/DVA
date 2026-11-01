import { useEffect, useRef, type ReactNode } from 'react'
import { Button } from './Button'

// 오버레이 두 가지 (와이어프레임 13 · 14)
// ConfirmDialog: 560 폭 · 제목(24/700) · 대상 한 줄(20 회색) · 안내 또는 빨간 경고 · [취소] [삭제/거절]
// FormModal:     600(08 사원 수정) / 680(09 질의) / 960(03 송장표 · 주문 추가) 폭 · 제목 + ✕ · 내용 · 아래 버튼 — 안쪽 여백 32
// 둘 다 뒤 화면을 #2B2F36 40%로 가리고, Esc로 닫힘. 창 자체는 DOM 흐름 밖(fixed)
// 키보드: 열면 창 안 첫 칸으로 포커스, Tab은 창 안에서만 돎, 닫으면 연 버튼으로 돌아감. 창이 겹치면 맨 위 창만 키를 받음

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
const FIRST_FIELD =
  'input:not([disabled]),select:not([disabled]),textarea:not([disabled]),button:not([disabled]):not([aria-label="닫기"])'

function Overlay({
  onClose,
  children,
  label,
}: {
  onClose: () => void
  children: ReactNode
  label: string
}) {
  const box = useRef<HTMLDivElement>(null)
  const downOnDim = useRef(false) // 누르기 시작한 곳이 어두운 배경일 때만 닫음 (창 안에서 끌다가 밖에서 놓으면 안 닫힘)

  // 열 때 한 번 (onClose가 렌더마다 새 함수여도 다시 안 돎)
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    ;(box.current?.querySelector<HTMLElement>(FIRST_FIELD) ?? box.current)?.focus()
    return () => prev?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = box.current
      const dialogs = document.querySelectorAll('[role="dialog"]')
      if (!el || dialogs[dialogs.length - 1] !== el) return
      if (e.key === 'Escape') return onClose()
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
        // 창 높이 = 브라우저 높이 - 위아래 32씩까지. 넘치면 FormModal의 내용 칸만 스크롤 (주문 상세처럼 긴 창)
        className="flex max-h-[calc(100dvh-64px)] flex-col rounded-xl bg-surface p-8 shadow-[0_12px_40px_rgba(43,47,54,0.16)] outline-none motion-safe:animate-pop-in"
      >
        {children}
      </div>
    </div>
  )
}

export function ConfirmDialog({
  title,
  target,
  note,
  warn,
  okLabel,
  okKind = 'danger',
  onOk,
  onClose,
  pending,
}: {
  title: string // '정말로 삭제하시겠습니까?'
  target?: string // '선택한 통화 3건' · '김지훈 · jihoon.kim@dver.co.kr'
  note?: string // 회색 안내 (거절: '신청이 지워지며 …')
  warn?: string // 빨간 경고 (되돌릴 수 없음 · 미처리 질문 있음)
  okLabel: string // '삭제' · '거절'
  okKind?: 'danger' | 'primary' // 되돌릴 수 없는 일(삭제 · 거절) = 빨강(기본), 아닌 일(07 적용) = 남색
  onOk: () => void
  onClose: () => void
  pending?: boolean
}) {
  return (
    <Overlay onClose={onClose} label={title}>
      <div className="flex w-[496px] flex-col gap-2">
        <h2 className="text-card font-bold">{title}</h2>
        {target && <p className="text-body text-sub">{target}</p>}
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
        {note && !warn && <p className="mt-3 text-label text-sub">{note}</p>}
        <div className="mt-8 flex justify-end gap-3">
          <Button onClick={onClose}>취소</Button>
          <Button kind={okKind} onClick={onOk} disabled={pending}>
            {okLabel}
          </Button>
        </div>
      </div>
    </Overlay>
  )
}

export function FormModal({
  title,
  titleExtra,
  description,
  width = 600,
  onClose,
  children,
  footer,
}: {
  title: string
  titleExtra?: ReactNode // 제목 옆 태그 (06 주문 상세 [전화] [주문 취소])
  description?: string // 제목 아래 회색 한 줄 (03 주문 추가)
  width?: number // 600 · 680 · 960
  onClose: () => void
  children: ReactNode
  footer: ReactNode // 보통 <Button>취소</Button> <Button kind="primary">저장</Button>
}) {
  return (
    <Overlay onClose={onClose} label={title}>
      <div className="flex min-h-0 flex-col gap-6" style={{ width: width - 64 }}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="flex items-center gap-3 text-card font-bold">
              {title}
              {titleExtra}
            </h2>
            {description && <p className="mt-1 text-label text-sub">{description}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="닫기"
            className="-mr-1.5 grid size-8 shrink-0 place-items-center rounded-lg text-sub hover:bg-bg" // 32 칸 안 20 아이콘 → 아이콘 오른쪽이 안쪽 여백 선(32)에 딱
          >
            <svg
              viewBox="0 0 20 20"
              className="size-5"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              strokeLinecap="round"
            >
              <path d="M5 5l10 10M15 5L5 15" />
            </svg>
          </button>
        </div>
        <div className="border-t border-line" />
        {/* 제목줄 · 버튼줄은 고정, 내용만 스크롤. -mx-8 px-8: 스크롤 막대를 창 오른쪽 끝에 붙이고 글자 자리는 그대로 */}
        <div className="-mx-8 flex min-h-0 flex-col gap-6 overflow-y-auto px-8">{children}</div>
        <div className="flex justify-end gap-3">{footer}</div>
      </div>
    </Overlay>
  )
}
