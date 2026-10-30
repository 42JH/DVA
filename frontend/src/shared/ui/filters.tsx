import { useId, useState, type KeyboardEvent } from 'react'
import { useRecentSearches } from '@/shared/lib/recentSearches'

// 필터 줄 부품 — 높이 48 · 모서리 8. 적용된(applied) 상태 = 옅은 남색 바탕 + 남색 1.5 선 (와이어프레임 04 '불만 있음')
// 상태는 훅(hooks/)이 들고, 여기는 그리기만
// 선은 전부 안쪽 ring — 1 → 1.5로 굵어져도 칸 폭 · 글자 자리가 안 움직이게
const LINE = 'ring-1 ring-line ring-inset'
const LINE_ON = 'ring-[1.5px] ring-action ring-inset'

/**
 * 검색칸 — 입력 중엔 Enter로 검색. 자리글 예: '주문 · 디버 접수번호 · 고객 · 발신번호'
 * 켜는 옵션 (10/30, 안 주면 예전 그대로):
 *  - recentKey: 최근 검색어 — 이 이름으로 브라우저에 저장, 칸이 비어 있을 때 아래에 뜸 (09만. 고객 이름 · 번호 검색칸엔 쓰지 않기)
 *  - suggestions: 추천 목록 — 칠 때 아래에 뜸. 화면 훅이 shared/lib/search의 suggest()로 만들어 넘김
 *  - onPick: 최근 검색어 · 추천을 골랐을 때 할 일 (검색칸 글자는 늘 그 글로 바뀜. 예: 01 홈은 바로 검색 이동)
 * 키보드: ↑↓ 고르기 · Enter 고른 것 적용 · Esc 닫기 · Delete 최근 검색어 지우기 (한글 조합 중 Enter는 무시)
 */
export function SearchBox({
  value,
  placeholder,
  onChange,
  onSubmit,
  className = '',
  recentKey,
  suggestions,
  onPick,
}: {
  value: string
  placeholder: string
  onChange: (v: string) => void
  onSubmit?: () => void
  className?: string
  recentKey?: string
  suggestions?: string[]
  onPick?: (v: string) => void
}) {
  const recent = useRecentSearches(recentKey)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const listId = useId()

  const hasPopup = !!recentKey || suggestions !== undefined // 옵션을 안 켠 검색칸은 예전처럼 그냥 입력칸
  const isRecent = value.trim() === ''
  const items = isRecent ? recent.items : (suggestions ?? [])
  const expanded = open && items.length > 0
  const act = active < items.length ? active : -1 // 목록이 줄어도(✕) 없는 줄을 가리키지 않게

  const close = () => {
    setOpen(false)
    setActive(-1)
  }
  const pick = (text: string) => {
    onChange(text)
    onPick?.(text)
    recent.add(text)
    close()
  }
  const removeRecent = (text: string) => {
    recent.remove(text)
    setActive(-1)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return // 한글 조합을 끝내는 Enter · 방향키
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!items.length) return
      e.preventDefault()
      setOpen(true)
      const down = e.key === 'ArrowDown' // 끝에서 다시 처음으로 돎
      setActive(down ? (act + 1) % items.length : act <= 0 ? items.length - 1 : act - 1)
    } else if (e.key === 'Enter') {
      if (expanded && act >= 0) {
        e.preventDefault() // 감싼 form이 있어도 제출하지 않고 고른 것만 적용
        pick(items[act])
      } else {
        recent.add(value)
        onSubmit?.()
        close()
      }
    } else if (e.key === 'Escape' && expanded) {
      e.preventDefault()
      e.stopPropagation() // 뒤에 열린 창(Modal)의 Esc까지 닫히지 않게 — 목록만 닫음
      close()
    } else if (e.key === 'Delete' && expanded && isRecent && act >= 0) {
      e.preventDefault() // 키보드로 최근 검색어 지우기 (✕는 마우스용)
      removeRecent(items[act])
    }
  }

  return (
    <div className={`relative ${className}`}>
      <label
        className={`flex h-12 items-center gap-3 rounded-lg bg-surface px-4 ${LINE} focus-within:ring-action`}
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
          onChange={(e) => {
            onChange(e.target.value)
            setOpen(true)
            setActive(-1)
          }}
          onFocus={() => setOpen(true)}
          onMouseDown={() => setOpen(true)} // 이미 포커스가 있으면 focus가 안 와서, 닫은 뒤 다시 누를 때 열리게
          onBlur={() => {
            recent.add(value) // 바로 걸러지는 검색이라 칸을 떠날 때 남김
            close()
          }}
          onKeyDown={onKeyDown}
          {...(hasPopup && {
            role: 'combobox',
            'aria-expanded': expanded,
            'aria-controls': expanded ? listId : undefined,
            'aria-autocomplete': 'list' as const,
            'aria-activedescendant': expanded && act >= 0 ? `${listId}-${act}` : undefined,
          })}
          className="w-full bg-transparent text-body outline-none placeholder:text-muted"
        />
      </label>

      {expanded && (
        // mousedown 기본 동작을 막아 누르는 동안 검색칸 포커스가 빠지지 않게 (빠지면 목록이 먼저 닫힘)
        // 안의 버튼은 tabIndex -1 — Tab은 목록을 건너 다음 칸으로 (목록은 ↑↓ · Delete로)
        <div
          onMouseDown={(e) => e.preventDefault()}
          className="absolute inset-x-0 top-full z-20 mt-1 rounded-lg bg-surface py-2 shadow-[0_8px_24px_rgba(43,47,54,0.12)] ring-1 ring-line ring-inset"
        >
          {isRecent && (
            <div className="flex items-center justify-between px-4 pb-1 text-caption text-muted">
              <span>최근 검색어</span>
              <button
                type="button"
                tabIndex={-1}
                onClick={() => {
                  recent.clear()
                  setActive(-1)
                }}
                className="hover:text-ink"
              >
                전체 삭제
              </button>
            </div>
          )}
          <ul id={listId} role="listbox" aria-label={isRecent ? '최근 검색어' : '추천 검색어'}>
            {items.map((text, i) => (
              <li
                key={text}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === act}
                onClick={() => pick(text)}
                onMouseEnter={() => setActive(i)}
                className={`flex h-10 cursor-pointer items-center gap-3 px-4 text-label ${
                  i === act ? 'bg-bg' : ''
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{text}</span>
                {isRecent && (
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-hidden // 줄(option) 이름에 섞이지 않게 — 키보드는 Delete
                    title="삭제"
                    onClick={(e) => {
                      e.stopPropagation()
                      removeRecent(text)
                    }}
                    className="text-muted hover:text-ink"
                  >
                    ✕
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
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
  count?: string // 예전 04 칩 줄의 '8건'. 목록 공통 상단(10/27)에선 개수를 카드 제목에 두므로 보통 안 넘김
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
      {count && <span className="ml-2 text-label font-bold text-ink">{count}</span>}
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
