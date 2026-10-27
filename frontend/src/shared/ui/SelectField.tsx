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
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
  placeholder?: string
  hint?: string
  error?: string
}) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-label font-semibold text-sub">{label}</span>
      <span className="relative block">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={!!error}
          className={`h-11 w-full appearance-none rounded-lg bg-surface pr-10 pl-3.5 text-body outline-none ring-inset ${
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
          className="pointer-events-none absolute top-1/2 right-3.5 size-4 -translate-y-1/2 stroke-sub"
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
