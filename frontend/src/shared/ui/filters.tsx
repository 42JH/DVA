// 필터 줄 부품 — 높이 48 · 모서리 8. 적용된(applied) 상태 = 옅은 남색 바탕 + 남색 1.5 선 (와이어프레임 04 '불만 있음')
// 상태는 훅(hooks/)이 들고, 여기는 그리기만
// 선은 전부 안쪽 ring — 1 → 1.5로 굵어져도 칸 폭 · 글자 자리가 안 움직이게
const LINE = 'ring-1 ring-line ring-inset'
const LINE_ON = 'ring-[1.5px] ring-action ring-inset'

/** 검색칸 — 입력 중엔 Enter로 검색. 자리글 예: '주문 · 디버 접수번호 · 고객 · 발신번호' */
export function SearchBox({
  value,
  placeholder,
  onChange,
  onSubmit,
  className = '',
}: {
  value: string
  placeholder: string
  onChange: (v: string) => void
  onSubmit?: () => void
  className?: string
}) {
  return (
    <label
      className={`flex h-12 items-center gap-3 rounded-lg bg-surface px-4 ${LINE} focus-within:ring-action ${className}`}
    >
      <svg
        viewBox="0 0 20 20"
        className="size-5 shrink-0 stroke-sub"
        fill="none"
        strokeWidth={1.6}
        strokeLinecap="round"
      >
        <circle cx="8.5" cy="8.5" r="6" />
        <path d="M13 13l4.5 4.5" />
      </svg>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && onSubmit?.()}
        className="w-full bg-transparent text-body outline-none placeholder:text-muted"
      />
    </label>
  )
}

export type PeriodKey = 'today' | 'week' | 'custom' | 'all'
/** 기간 [오늘] [1주일] [기간 선택 📅]. all = '미처리 전체'(05 AI 미답변 탭에서만 앞에 추가) */
export function PeriodFilter({
  value,
  onChange,
  withAll,
}: {
  value: PeriodKey
  onChange: (k: PeriodKey) => void
  withAll?: boolean
}) {
  const items: [PeriodKey, string][] = [
    ...(withAll ? ([['all', '미처리 전체']] as [PeriodKey, string][]) : []),
    ['today', '오늘'],
    ['week', '1주일'],
    ['custom', '기간 선택'],
  ]
  return (
    <div className="flex gap-2" role="radiogroup" aria-label="기간">
      {items.map(([k, label]) => {
        const on = k === value
        return (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(k)}
            className={`flex h-12 items-center gap-2 rounded-lg px-5 text-body ${
              on
                ? `${LINE_ON} bg-action-soft font-semibold text-action`
                : `${LINE} bg-surface text-ink`
            }`}
          >
            {label}
            {k === 'custom' && (
              // 달력 아이콘. 달력 팝오버 자체는 02 대시보드 만들 때
              <svg
                viewBox="0 0 20 20"
                className="size-4 stroke-sub"
                fill="none"
                strokeWidth={1.6}
                strokeLinecap="round"
              >
                <rect x="3" y="4" width="14" height="13" rx="2" />
                <path d="M3 8h14M7 2v4M13 2v4" />
              </svg>
            )}
          </button>
        )
      })}
    </div>
  )
}

export interface Option<V extends string = string> {
  value: V
  label: string
}

/** Select(드롭다운) — 피그마 07 Select — 이름(회색) + 값 + ▾. 선택지 4개 이상일 때. 값이 기본(첫 항목)이 아니면 applied 모양 */
export function Select<V extends string>({
  name,
  options,
  value,
  onChange,
  className = '',
}: {
  name: string
  options: Option<V>[]
  value: V
  onChange: (v: V) => void
  className?: string
}) {
  const applied = value !== options[0]?.value
  const current = options.find((o) => o.value === value)?.label ?? ''
  return (
    <label
      className={`relative flex h-12 items-center gap-2 rounded-lg px-4 text-body ${
        applied ? `${LINE_ON} bg-action-soft` : `${LINE} bg-surface`
      } ${className}`}
    >
      <span className="text-sub">{name}</span>
      <span className={applied ? 'font-bold text-action' : 'font-semibold text-ink'}>
        {current}
      </span>
      <svg
        viewBox="0 0 20 20"
        className={`ml-auto size-4 ${applied ? 'stroke-action' : 'stroke-sub'}`}
        fill="none"
        strokeWidth={1.6}
        strokeLinecap="round"
      >
        <path d="M5 8l5 5 5-5" />
      </svg>
      {/* ponytail: 네이티브 select를 위에 투명하게 — 커스텀 메뉴는 디자인 나오면 */}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as V)}
        aria-label={name}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

/** 라디오 — 선택지 3개 이하 (디자인 규칙). 예: 구분 ◉ 전체 ○ 수정 ○ 문의 */
export function RadioGroup<V extends string>({
  name,
  options,
  value,
  onChange,
}: {
  name: string
  options: Option<V>[]
  value: V
  onChange: (v: V) => void
}) {
  return (
    <div className="flex items-center gap-6 text-body" role="radiogroup" aria-label={name}>
      <span className="text-sub">{name}</span>
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={`flex items-center gap-2 ${on ? 'font-semibold text-ink' : 'text-sub'}`}
          >
            <span
              className={`grid size-[18px] place-items-center rounded-full border-[1.5px] bg-surface ${on ? 'border-action' : 'border-muted'}`}
            >
              {on && <span className="size-[9px] rounded-full bg-action" />}
            </span>
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** 적용된 필터 칩 줄 — [오늘 ✕] [불만 통화만 ✕] · N건 · 필터 지우기 */
export function AppliedFilters({
  chips,
  count,
  onRemove,
  onClear,
}: {
  chips: { key: string; label: string }[]
  count: string // '8건' · '통화 17건 · 질문 22개' (D2 결정 전까지 글자로 받음)
  onRemove: (key: string) => void
  onClear: () => void
}) {
  if (chips.length === 0) return null
  return (
    <div className="flex h-9 items-center gap-2">
      <span className="mr-2 text-label font-semibold text-sub">적용된 필터</span>
      {chips.map((c) => (
        <button
          key={c.key}
          type="button"
          onClick={() => onRemove(c.key)}
          className="flex h-9 items-center gap-2 rounded-full bg-action-soft pr-3 pl-4 text-label font-semibold text-action"
        >
          {c.label}
          {/* ✕는 글자가 아니라 16 칸 아이콘 — 글꼴에 따라 자리가 흔들리지 않게 */}
          <svg
            viewBox="0 0 16 16"
            className="size-4 shrink-0"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.6}
            strokeLinecap="round"
            aria-hidden
          >
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
          <span className="sr-only">필터 해제</span>
        </button>
      ))}
      <span className="ml-2 text-label font-bold text-ink">{count}</span>
      <button
        type="button"
        onClick={onClear}
        className="ml-auto text-label font-semibold text-action"
      >
        필터 지우기
      </button>
    </div>
  )
}
