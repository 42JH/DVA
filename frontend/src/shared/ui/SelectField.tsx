// 폼 안 셀렉트 (09 질의 창 '분류') — TextField와 같은 상자(44 · 모서리 8 · 안쪽 ring) + ▾. 선택지 4개 이상일 때
// hint: 고른 항목의 설명 한 줄 (코드북) · error: 명세서 details → 칸 아래 빨간 글
export function SelectField({
  label,
  value,
  onChange,
  options,
  placeholder = '선택',
  hint,
  error,
  inline,
  compact,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
  placeholder?: string
  hint?: string
  error?: string
  inline?: boolean // 라벨 왼쪽 120 (TextField inline과 같은 줄 맞춤, 07 음성 세부 조절)
  compact?: boolean // 칸 36 · 글자 14 · 라벨 12 — ops 화면 칸과 같은 크기 (07 상담가 히스토리, 11/10)
}) {
  return (
    <label
      className={inline ? 'grid grid-cols-[120px_1fr] items-center gap-x-4' : 'flex flex-col gap-2'}
    >
      <span
        className={`${compact ? 'text-[12px]' : 'text-label'} ${inline ? '' : 'font-semibold'} text-sub`}
      >
        {label}
      </span>
      <span className="relative block">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={!!error}
          className={`${compact ? 'h-9 pr-9 pl-3 text-[14px]' : 'h-10 pr-10 pl-3.5 text-body'} w-full appearance-none rounded-lg bg-surface outline-none ring-inset ${
            error
              ? 'ring-[1.5px] ring-danger'
              : 'ring-1 ring-line focus:ring-[1.5px] focus:ring-action'
          } ${value ? 'text-ink' : 'text-muted'}`}
        >
          <option value="" disabled>
            {placeholder}
          </option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <svg
          viewBox="0 0 20 20"
          className={`pointer-events-none absolute top-1/2 ${compact ? 'right-3' : 'right-3.5'} size-4 -translate-y-1/2 stroke-sub`}
          fill="none"
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M5 8l5 5 5-5" />
        </svg>
      </span>
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
