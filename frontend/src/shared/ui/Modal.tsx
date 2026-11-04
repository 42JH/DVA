import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useExitGhost } from '@/shared/lib/useExitGhost'
import { Button } from './Button'
import { NewLook } from './newLook'

// 오버레이 (와이어프레임 13 · 14 + 새 디자인 11/04~)
// ConfirmDialog: 560 폭 · 제목(24/700) · 대상 한 줄(20 회색) · 안내 또는 빨간 경고 · [취소] [삭제/거절]. big = 새 디자인 버튼 · 글자
// FormModal:     600(08 사원 수정) / 680(09 질의) / 960(03 송장표 · 주문 추가) 폭 · 제목 + ✕ · 내용 · 아래 버튼 — 안쪽 여백 32
// Dialog:        새 디자인 창 (03 주문 상세 · 추가 · 수정, Figma에 없어 '주문' · '통화' 화면 말투로) — 작은 글 + 제목 + 옆 | ✕ · 몸 · 버튼 줄
// 둘 다 뒤 화면을 #2B2F36 40%로 가리고, Esc로 닫힘. 창 자체는 DOM 흐름 밖(fixed)
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

// top = 화면 위쪽에 붙어 뜸(검색 창), boxClass = 창 모양 덧붙임 (기본은 가운데 · 안쪽 여백 32)
// dim = 뒤 화면을 어둡게(기본). 끄면 투명 — 바깥을 누르면 닫히는 건 같음 (09 FAQ 검색 창, 11/04 사용자)
// movable = 창 안의 data-drag 칸(예: 검색 창 윗줄)을 잡고 끌어 옮김. 그 안의 입력칸 · 버튼 · 링크 · 고를 줄은 원래대로
//   화면 밖으로 다 나가지 않게: 위는 화면 안, 옆 · 아래는 80px 남김
export function Overlay({
  onClose,
  children,
  label,
  top,
  boxClass = 'p-8',
  dim = true,
  movable,
}: {
  onClose: () => void
  children: ReactNode
  label: string
  top?: boolean
  boxClass?: string
  dim?: boolean
  movable?: boolean
}) {
  const root = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const downOnDim = useRef(false) // 누르기 시작한 곳이 어두운 배경일 때만 닫음 (창 안에서 끌다가 밖에서 놓으면 안 닫힘)
  const [at, setAt] = useState({ x: 0, y: 0 }) // 끌어서 옮긴 만큼 (movable)
  const drag = useRef<{ dx: number; dy: number; left: number; top: number; w: number } | null>(null)
  useExitGhost(root, EXIT_SWAP, 200)

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
      ref={root}
      className={`fixed inset-0 z-50 grid ${dim ? 'bg-ink/40 motion-safe:animate-dim-in' : ''} ${top ? 'place-items-start justify-items-center pt-[12dvh]' : 'place-items-center'}`}
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
        // translate 속성(transform 아님) — 열고 닫히는 pop 애니메이션(transform)과 겹치지 않음
        style={movable ? { translate: `${at.x}px ${at.y}px` } : undefined}
        onPointerDown={(e) => {
          const t = e.target as Element
          if (!movable || !t.closest('[data-drag]')) return
          if (t.closest('input,textarea,select,button,a,[role="option"]')) return
          e.preventDefault() // 글자 선택 · 검색칸 포커스가 빠지지 않게
          e.currentTarget.setPointerCapture(e.pointerId)
          const r = e.currentTarget.getBoundingClientRect()
          drag.current = {
            dx: e.clientX - at.x,
            dy: e.clientY - at.y,
            left: r.left - at.x,
            top: r.top - at.y,
            w: r.width,
          }
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d) return
          const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
          setAt({
            x: clamp(e.clientX - d.dx, 80 - d.left - d.w, window.innerWidth - d.left - 80),
            y: clamp(e.clientY - d.dy, -d.top, window.innerHeight - d.top - 80),
          })
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        // 창 높이 = 브라우저 높이 - 위아래 32씩까지. 넘치면 FormModal의 내용 칸만 스크롤 (주문 상세처럼 긴 창)
        className={`flex max-h-[calc(100dvh-64px)] flex-col rounded-xl bg-surface shadow-[0_12px_40px_rgba(43,47,54,0.16)] outline-none motion-safe:animate-pop-in ${boxClass}`}
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
  big,
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
  big?: boolean // 새 디자인 (11/04~ 03 주문): 제목 24 · 글자 한 단계 크게 · 버튼 높이 32 / 글자 20 · 확인 남색 대신 파랑
}) {
  return (
    <Overlay onClose={onClose} label={title}>
      <div className="flex w-[496px] flex-col gap-2">
        <h2 className={`font-bold ${big ? 'text-title' : 'text-card'}`}>{title}</h2>
        {target && (
          // 질문 전문이 올 수 있음(최대 1,000자) — 세 줄까지만, 나머지는 title (11/02)
          <p
            className={`line-clamp-3 break-words text-sub ${big ? 'text-strong' : 'text-body'}`}
            title={target}
          >
            {target}
          </p>
        )}
        {warn && (
          <p
            className={`mt-3 flex items-start gap-2 font-semibold text-danger ${big ? 'text-body' : 'text-label'}`}
          >
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
        {note && !warn && (
          <p className={`mt-3 text-sub ${big ? 'text-body' : 'text-label'}`}>{note}</p>
        )}
        <div className="mt-8 flex justify-end gap-3">
          <Button big={big} onClick={onClose}>
            취소
          </Button>
          <Button
            big={big}
            kind={big && okKind === 'primary' ? 'brand' : okKind}
            onClick={onOk}
            disabled={pending}
          >
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
          <CloseX onClose={onClose} />
        </div>
        <div className="border-t border-line" />
        {/* 제목줄 · 버튼줄은 고정, 내용만 스크롤. -mx-8 px-8: 스크롤 막대를 창 오른쪽 끝에 붙이고 글자 자리는 그대로 */}
        <div className="-mx-8 flex min-h-0 flex-col gap-6 overflow-y-auto px-8">{children}</div>
        <div className="flex justify-end gap-3">{footer}</div>
      </div>
    </Overlay>
  )
}

/** ✕ — 32 칸 안 20 아이콘 → 아이콘 오른쪽이 안쪽 여백 선에 딱 */
function CloseX({ onClose, className = '' }: { onClose: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label="닫기"
      className={`-mr-1.5 grid size-8 shrink-0 place-items-center rounded-lg text-sub hover:bg-bg hover:text-ink ${className}`}
    >
      <svg
        viewBox="0 0 20 20"
        className="size-5"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        aria-hidden
      >
        <path d="M5 5l10 10M15 5L5 15" />
      </svg>
    </button>
  )
}

/** 새 디자인 창 (11/04~ — 03 주문 상세 · 추가 · 수정 · 주소 검색). Figma에 없어 '주문' · '통화' 화면 말투로 만든 틀 (11/04 사용자)
 *  머리: 작은 회색 글(eyebrow) · 제목 24/700 + 옆(extra — 상태 칩) · 아래 회색 한 줄(sub) | ✕
 *  몸은 위 선 아래에서만 스크롤, 버튼 줄은 위 선 + 고정 (창 높이 = 화면 - 64까지). 안의 입력칸은 새 모양(newLook.ts) */
export function Dialog({
  label,
  eyebrow,
  title,
  extra,
  sub,
  width = 920,
  onClose,
  children,
  footer,
}: {
  label: string // 화면 읽기 이름 ('주문 상세')
  eyebrow?: string // 제목 위 작은 글 ('주문번호')
  title: ReactNode
  extra?: ReactNode
  sub?: string
  width?: number // 920(주문) · 600(주소 검색 · 묻는 창)
  onClose: () => void
  children: ReactNode
  footer: ReactNode // 왼쪽부터 — 오른쪽으로 보낼 첫 버튼에 ml-auto
}) {
  return (
    <Overlay onClose={onClose} label={label} boxClass="py-7">
      <NewLook.Provider value>
        <div className="flex min-h-0 flex-col" style={{ width }}>
          <header className="flex shrink-0 items-start gap-4 px-9">
            <div className="min-w-0">
              {eyebrow && <p className="text-label font-medium text-sub">{eyebrow}</p>}
              <h2
                className={`flex items-center gap-4 text-title font-bold break-words ${eyebrow ? 'mt-0.5' : ''}`}
              >
                {title}
                {extra}
              </h2>
              {sub && <p className="mt-1 text-body text-sub">{sub}</p>}
            </div>
            <CloseX onClose={onClose} className="ml-auto" />
          </header>
          <div className="mt-5 min-h-0 [scrollbar-width:thin] overflow-y-auto border-t border-line px-9 pt-5">
            {children}
          </div>
          <footer className="mt-4 flex shrink-0 items-center gap-3 border-t border-line px-9 pt-5">
            {footer}
          </footer>
        </div>
      </NewLook.Provider>
    </Overlay>
  )
}
