// 폼 안 셀렉트 (기업 사원 창의 '부서') — 입력 칸과 같은 크기(칸 36 · 글자 14 · 라벨 12) + ▾
export function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string; disabled?: boolean }[]
}) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-[12px] font-semibold text-sub">{label}</span>
      <span className="relative block">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={`h-9 w-full appearance-none rounded-lg bg-surface pr-9 pl-3 text-[14px] ring-1 ring-line outline-none ring-inset focus:ring-[1.5px] focus:ring-action ${value ? 'text-ink' : 'text-muted'}`}
        >
          <option value="" disabled>
            선택
          </option>
          {options.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </option>
          ))}
        </select>
        <svg
          viewBox="0 0 20 20"
          className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 stroke-sub"
          fill="none"
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M5 8l5 5 5-5" />
        </svg>
      </span>
    </label>
  )
}
