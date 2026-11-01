import { useId, useState, type InputHTMLAttributes } from 'react'

// 00 입력칸 (디자인 '03 기본 / Form field') — 라벨(17 회색) 위 · 아이콘 + 밑줄 칸. 입력 중 = 남색 밑줄 · 오류 = 빨간 밑줄 + 아래 빨간 글
// secret: 비밀번호 칸 — 오른쪽 눈 버튼으로 보이기 · 숨기기
const ICON = {
  id: (
    <>
      <circle cx="10" cy="10" r="8" />
      <circle cx="10" cy="8" r="2.75" />
      <path d="M4.8 15.6a6 6 0 0 1 10.4 0" />
    </>
  ),
  lock: (
    <>
      <path d="M7 9V6.5a3 3 0 0 1 6 0V9" />
      <rect x="4.5" y="9" width="11" height="8.5" rx="1.5" fill="currentColor" stroke="none" />
    </>
  ),
  person: (
    <>
      <circle cx="10" cy="6.5" r="3" fill="currentColor" stroke="none" />
      <path d="M4 16.5c.6-3 3-4.5 6-4.5s5.4 1.5 6 4.5z" fill="currentColor" stroke="none" />
    </>
  ),
  eye: (
    <>
      <path d="M1.75 10S4.75 4.5 10 4.5 18.25 10 18.25 10 15.25 15.5 10 15.5 1.75 10 1.75 10z" />
      <circle cx="10" cy="10" r="2.5" />
    </>
  ),
}

const Svg = ({ name, className }: { name: keyof typeof ICON; className: string }) => (
  <svg
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
    className={`size-5 shrink-0 ${className}`}
  >
    {ICON[name]}
  </svg>
)

export function AuthField({
  label,
  icon,
  secret,
  error,
  value,
  onValue,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'type'> & {
  label: string
  icon: 'id' | 'lock' | 'person'
  secret?: boolean
  error?: string
  value: string
  onValue: (v: string) => void
}) {
  const [shown, setShown] = useState(false)
  const id = useId()
  // 오류 문구는 라벨 밖에 두고 aria-describedby로 연결 (라벨 안이면 칸 이름에 오류 문구까지 섞여 읽힘)
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-caption text-sub">
        {label}
      </label>
      <span
        className={`flex h-11 items-center gap-2.5 border-b px-2 ${
          error ? 'border-danger' : 'border-line focus-within:border-action'
        }`}
      >
        <Svg name={icon} className="text-sub" />
        <input
          {...rest}
          id={id}
          aria-describedby={error ? `${id}-err` : undefined}
          type={secret && !shown ? 'password' : 'text'}
          value={value}
          onChange={(e) => onValue(e.target.value)}
          aria-invalid={!!error}
          className="min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-muted"
        />
        {secret && (
          <button
            type="button"
            onClick={() => setShown((v) => !v)}
            aria-label={shown ? '비밀번호 숨기기' : '비밀번호 보기'}
            aria-pressed={shown}
            className="relative grid place-items-center"
          >
            <Svg name="eye" className="text-ink" />
            {shown && <i className="absolute h-px w-6 rotate-45 bg-ink" />}
          </button>
        )}
      </span>
      {error && (
        <span id={`${id}-err`} role="alert" className="text-caption font-semibold text-danger">
          {error}
        </span>
      )}
    </div>
  )
}
