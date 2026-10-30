import { useEffect, type ReactNode } from 'react'
import { Button } from './Button'

// 오버레이 두 가지 (와이어프레임 13 · 14)
// ConfirmDialog: 560 폭 · 제목(24/700) · 대상 한 줄(20 회색) · 안내 또는 빨간 경고 · [취소] [삭제/거절]
// FormModal:     600(08 사원 수정) / 680(09 질의) / 960(03 송장표 · 주문 추가) 폭 · 제목 + ✕ · 내용 · 아래 버튼 — 안쪽 여백 32
// 둘 다 뒤 화면을 #2B2F36 40%로 가리고, Esc로 닫힘. 창 자체는 DOM 흐름 밖(fixed)

function Overlay({
  onClose,
  children,
  label,
}: {
  onClose: () => void
  children: ReactNode
  label: string
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/40" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={(e) => e.stopPropagation()}
        className="rounded-xl bg-surface p-8 shadow-[0_12px_40px_rgba(43,47,54,0.16)]"
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
  onOk,
  onClose,
  pending,
}: {
  title: string // '정말로 삭제하시겠습니까?'
  target?: string // '선택한 통화 3건' · '김지훈 · jihoon.kim@dver.co.kr'
  note?: string // 회색 안내 (거절: '신청이 지워지며 …')
  warn?: string // 빨간 경고 (되돌릴 수 없음 · 미처리 질문 있음)
  okLabel: string // '삭제' · '거절'
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
          <Button kind="danger" onClick={onOk} disabled={pending}>
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
      <div className="flex flex-col gap-6" style={{ width: width - 64 }}>
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
        {children}
        <div className="flex justify-end gap-3">{footer}</div>
      </div>
    </Overlay>
  )
}
