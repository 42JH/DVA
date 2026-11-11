// 창 — 브라우저 <dialog>(showModal)라 초점 가두기 · Esc · 뒤 화면 막기를 브라우저가 해 줌
// 닫기: 바깥(어두운 배경) 누르기 · Esc · ✕ · 아래 버튼. 창 안에서 누르기 시작해 바깥에서 뗀 것(글자 드래그)은 안 닫힘
import { useEffect, useRef, type ReactNode } from 'react'
import { Btn, Icon } from './controls'

export function Modal({
  title,
  extra,
  sub,
  onClose,
  footer,
  width = 640,
  children,
}: {
  title: string
  extra?: ReactNode // 제목 바로 옆 뱃지 · 숫자 ('통화 중 00:12', 07 시험 통화)
  sub?: string // 제목 옆 흐린 글 (어느 기업의 창인지 등)
  onClose: () => void
  footer?: ReactNode
  width?: number
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const downOutside = useRef(false) // 누르기 시작한 곳이 바깥이었나
  useEffect(() => {
    ref.current?.showModal()
  }, [])
  return (
    <dialog
      ref={ref}
      role="dialog" // useEscape가 창이 열린 걸 알아보는 표시
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault() // 닫는 건 부모 상태로 (dialog가 혼자 닫히지 않게)
        onClose()
      }}
      // 바깥(::backdrop)을 누르면 target이 dialog 자신 — 창 안 내용은 자식이 받음
      onMouseDown={(e) => (downOutside.current = e.target === e.currentTarget)}
      onClick={(e) => {
        if (downOutside.current && e.target === e.currentTarget) onClose()
      }}
      style={{ width }}
      className="m-auto hidden max-h-[calc(100dvh-48px)] max-w-[calc(100vw-32px)] flex-col rounded-lg bg-white p-0 text-ops-ink shadow-lg backdrop:bg-ops-ink/40 open:flex motion-safe:animate-pop-in"
    >
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-ops-line px-6">
        <h2 className="text-[16px] font-bold">{title}</h2>
        {extra}
        {sub && <span className="truncate text-[13px] text-ops-sub">{sub}</span>}
        <button
          type="button"
          onClick={onClose}
          aria-label="닫기"
          className="ml-auto grid size-8 place-items-center rounded-md text-ops-sub hover:bg-ops-paper hover:text-ops-ink"
        >
          <Icon name="x" />
        </button>
      </div>
      <div className="min-h-0 flex-1 [scrollbar-width:thin] overflow-y-auto px-6 py-5">
        {children}
      </div>
      {footer && (
        <div className="flex shrink-0 items-center gap-2 border-t border-ops-line px-6 py-3">
          {footer}
        </div>
      )}
    </dialog>
  )
}

/** 확인 창 — 삭제 · 취소 · 적용처럼 한 번 더 묻는 것. 제목은 묻는 말 한 줄, 몸은 결과 설명
 *  [취소]는 창만 닫음. 오류는 아래 줄 왼쪽에 (창은 그대로 두어 다시 누를 수 있게) */
export function Confirm({
  title,
  children,
  ok,
  closeLabel = '취소',
  danger,
  busy,
  error,
  onOk,
  onClose,
}: {
  title: string
  children?: ReactNode
  ok: string
  closeLabel?: string // 확인 버튼에도 '취소'가 들어가면 '닫기'로 (주문 취소)
  danger?: boolean // 되돌릴 수 없는 일이면 빨간 버튼
  busy?: boolean
  error?: string | null
  onOk: () => void
  onClose: () => void
}) {
  return (
    <Modal
      title={title}
      width={440}
      onClose={onClose}
      footer={
        <>
          {error && (
            <p role="alert" className="min-w-0 flex-1 text-[12px] text-ops-stop">
              {error}
            </p>
          )}
          <Btn className="ml-auto" onClick={onClose}>
            {closeLabel}
          </Btn>
          <Btn
            kind={ok === '삭제' || danger ? 'danger' : 'primary'}
            disabled={busy}
            onClick={onOk}
            autoFocus
          >
            {busy ? `${ok} 중…` : ok}
          </Btn>
        </>
      }
    >
      {children && <div className="text-[14px] leading-6 text-ops-ink/90">{children}</div>}
    </Modal>
  )
}
