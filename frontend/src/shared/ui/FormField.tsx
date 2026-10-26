import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react'

// 폼 칸 (와이어프레임 03 Form field) — 라벨(18/600 회색) 위 · 칸 44 · 모서리 8 · 글자 왼쪽 14
// 입력 중 = 남색 1.5 선 · locked = 회색 바탕 + 자물쇠(11 이메일 · 이름) · 오류 = 빨간 선 + 아래 빨간 글(명세서 error.details → field별)

const BOX = 'w-full rounded-lg border px-3.5 text-body text-ink outline-none placeholder:text-muted'
const STATE = (error?: string) =>
  error ? 'border-[1.5px] border-danger' : 'border-line focus:border-[1.5px] focus:border-action'

function Wrap({
  label,
  error,
  hint,
  children,
}: {
  label: string
  error?: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-label font-semibold text-sub">{label}</span>
      {children}
      {error ? (
        <span role="alert" className="text-caption font-semibold text-danger">
          {error}
        </span>
      ) : (
        hint && <span className="text-caption text-muted">{hint}</span>
      )}
    </label>
  )
}

export function TextField({
  label,
  error,
  hint,
  locked,
  className = '',
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string
  error?: string
  hint?: string
  locked?: boolean
}) {
  if (locked) {
    return (
      <Wrap label={label} hint={hint}>
        <span className="relative block">
          <input
            {...rest}
            readOnly
            className={`${BOX} h-11 border-line bg-bg text-sub ${className}`}
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
  return (
    <Wrap label={label} error={error} hint={hint}>
      <input
        {...rest}
        aria-invalid={!!error}
        className={`${BOX} h-11 bg-surface ${STATE(error)} ${className}`}
      />
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
        className={`${BOX} min-h-[180px] resize-y bg-surface py-2.5 leading-[1.6] ${STATE(error)} ${className}`}
      />
    </Wrap>
  )
}
