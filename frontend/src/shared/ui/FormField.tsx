import { useContext, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { NewLook } from './newLook'

// 폼 칸 (와이어프레임 03 Form field) — 라벨(18/600 회색) 위 · 칸 44 · 모서리 8 · 글자 왼쪽 14
// 입력 중 = 남색 1.5 선 · locked = 회색 바탕 + 자물쇠(11 이메일 · 이름) · 오류 = 빨간 선 + 아래 빨간 글(명세서 error.details → field별)
// 새 디자인 창(Dialog) 안이면 새 모양 (newLook.ts): 칸 36(Figma '검색 필드') · 선 = 검색칸 색 · 입력 중 = 파랑 · 라벨 16 · 라벨 칸 폭 = --field-label

// 선은 안쪽 ring — 입력 중 1.5로 굵어져도 글자 자리(왼쪽 14)가 안 움직이게
const BOX =
  'w-full rounded-lg px-3.5 text-body text-ink outline-none ring-inset placeholder:text-muted'
const STATE = (error?: string, fresh?: boolean) =>
  error
    ? 'ring-[1.5px] ring-danger'
    : fresh
      ? 'ring-1 ring-field focus:ring-[1.5px] focus:ring-brand'
      : 'ring-1 ring-line focus:ring-[1.5px] focus:ring-action'

function Wrap({
  label,
  error,
  hint,
  inline,
  children,
}: {
  label: string
  error?: string
  hint?: string
  inline?: boolean
  children: React.ReactNode
}) {
  const fresh = useContext(NewLook)
  const note = error ? (
    <span role="alert" className="text-caption font-semibold text-danger">
      {error}
    </span>
  ) : (
    hint && <span className="text-caption text-muted">{hint}</span>
  )
  // inline = 라벨 왼쪽 120 칸 (03 주문 추가처럼 칸이 많은 창). 라벨은 칸 높이(44) 가운데
  if (inline)
    return (
      <label
        className={`grid items-start gap-x-4 ${fresh ? 'grid-cols-[var(--field-label,120px)_minmax(0,1fr)]' : 'grid-cols-[120px_1fr]'}`}
      >
        <span
          className={`flex items-center text-sub ${fresh ? 'h-9 text-body' : 'h-10 text-label'}`}
        >
          {label}
        </span>
        <span className="flex min-w-0 flex-col gap-2">
          {children}
          {note}
        </span>
      </label>
    )
  return (
    <label className="flex flex-col gap-2">
      <span className="text-label font-semibold text-sub">{label}</span>
      {children}
      {note}
    </label>
  )
}

export function TextField({
  label,
  error,
  hint,
  locked,
  inline,
  suffix,
  className = '',
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string
  error?: string
  hint?: string
  locked?: boolean
  inline?: boolean // 라벨 왼쪽
  suffix?: string // 칸 안 오른쪽 단위 ('원')
}) {
  const fresh = useContext(NewLook)
  if (locked) {
    return (
      <Wrap label={label} hint={hint} inline={inline}>
        <span className="relative block">
          <input
            {...rest}
            readOnly
            className={`${BOX} ${fresh ? 'h-9' : 'h-10'} bg-bg pr-10 text-sub ring-1 ring-line ${className}`} // 오른쪽은 자물쇠 자리(16) + 여백만큼 비움
          />
          <svg
            viewBox="0 0 20 20"
            className="absolute top-1/2 right-3.5 size-4 -translate-y-1/2 stroke-sub"
            fill="none"
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="4" y="8.5" width="12" height="9" rx="2" />
            <path d="M7 8.5v-2.5a3 3 0 0 1 6 0v2.5" />
          </svg>
        </span>
      </Wrap>
    )
  }
  const input = (
    <input
      {...rest}
      aria-invalid={!!error}
      className={`${BOX} ${fresh ? 'h-9' : 'h-10'} bg-surface ${STATE(error, fresh)} ${suffix ? 'pr-10' : ''} ${className}`}
    />
  )
  return (
    <Wrap label={label} error={error} hint={hint} inline={inline}>
      {suffix ? (
        <span className="relative block">
          {input}
          <span className="pointer-events-none absolute top-1/2 right-3.5 -translate-y-1/2 text-body text-sub">
            {suffix}
          </span>
        </span>
      ) : (
        input
      )}
    </Wrap>
  )
}

export function TextArea({
  label,
  error,
  hint,
  className = '',
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; error?: string; hint?: string }) {
  return (
    <Wrap label={label} error={error} hint={hint}>
      <textarea
        {...rest}
        aria-invalid={!!error}
        className={`${BOX} min-h-[180px] resize-y bg-surface py-2.5 ${STATE(error)} ${className}`}
      />
    </Wrap>
  )
}
