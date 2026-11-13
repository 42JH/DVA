// 입력 칸 공통 — 주문 · 사원 · CSV 창이 같이 씀. 글자: 칸 이름 12 · 입력 14 · 안내 · 오류 12
import { useId, useRef, useState, type ReactNode } from 'react'
import { Btn, Icon } from './controls'

const box = (error?: string | boolean) =>
  `flex h-9 items-center rounded-md bg-white px-3 ring-1 ring-inset focus-within:ring-ops-route ${error ? 'ring-ops-stop' : 'ring-ops-line'}`

export const Err = ({ children }: { children: ReactNode }) => (
  <p role="alert" className="text-[12px] whitespace-pre-line text-ops-stop">
    {children}
  </p>
)

export const Label = ({ children }: { children: ReactNode }) => (
  <span className="text-[12px] font-medium text-ops-sub">{children}</span>
)

export function TextInput({
  label,
  labelClassName,
  value,
  onChange,
  error,
  suffix,
  placeholder,
  inputMode,
  readOnly,
  invalid,
  autoFocus,
}: {
  label: string
  labelClassName?: string // 칸 이름을 제목처럼 크게 (TextAreaInput과 같음, 07 상담가 등록 · 수정)
  value: string
  onChange: (v: string) => void
  error?: string
  suffix?: string
  placeholder?: string
  inputMode?: 'numeric' | 'tel'
  readOnly?: boolean // 바꿀 수 없는 칸 (회색 바탕)
  invalid?: boolean // 글 없이 빨간 테두리만 (오류 글은 묶음 아래에 한 번)
  autoFocus?: boolean // 누르면 바로 칸이 열리는 곳 (07 상담가 이름 연필)
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      {labelClassName ? <span className={labelClassName}>{label}</span> : <Label>{label}</Label>}
      <span className={`${box(error || invalid)} ${readOnly ? 'bg-ops-paper! text-ops-sub' : ''}`}>
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          inputMode={inputMode}
          readOnly={readOnly}
          autoFocus={autoFocus}
          aria-invalid={!!error || invalid}
          className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-ops-faint"
        />
        {suffix && <span className="text-[13px] text-ops-sub">{suffix}</span>}
      </span>
      {error && <Err>{error}</Err>}
    </label>
  )
}

/** 여러 줄 입력 칸 (TextInput과 같은 선 · 글자). labelClassName = 칸 이름을 제목처럼 크게 (07 프롬프트 수정) */
export function TextAreaInput({
  label,
  labelClassName,
  value,
  onChange,
  error,
  placeholder,
  className = '',
}: {
  label: string
  labelClassName?: string
  value: string
  onChange: (v: string) => void
  error?: string
  placeholder?: string
  className?: string // 높이 등 (예: 글만큼 늘리기 [field-sizing:content])
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      {labelClassName ? <span className={labelClassName}>{label}</span> : <Label>{label}</Label>}
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        aria-invalid={!!error}
        className={`min-h-20 resize-none rounded-md bg-white px-3 py-2 text-[14px] leading-6 ring-1 outline-none ring-inset placeholder:text-ops-faint focus:ring-ops-route ${error ? 'ring-ops-stop' : 'ring-ops-line'} ${className}`}
      />
      {error && <Err>{error}</Err>}
    </label>
  )
}

/** 치는 대로 추천이 아래에 뜨는 입력 칸 (TextInput과 같은 모양). ↑ ↓로 옮기고 Enter로 고름, Esc · 칸 밖으로 나가면 닫힘 */
export function SuggestInput<T>({
  label,
  value,
  onChange,
  error,
  placeholder,
  inputMode,
  invalid,
  items,
  itemKey,
  renderItem,
  onPick,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  error?: string
  placeholder?: string
  inputMode?: 'numeric' | 'tel'
  invalid?: boolean
  items: T[]
  itemKey: (item: T) => string | number
  renderItem: (item: T) => ReactNode
  onPick: (item: T) => void
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const shown = open && items.length > 0
  const at = active < items.length ? active : -1 // 추천이 바뀌어 줄 수가 줄면 고른 줄 없음
  const pick = (item: T) => {
    onPick(item)
    setOpen(false)
    setActive(-1)
  }
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <Label>{label}</Label>
      <span className={`relative ${box(error || invalid)}`}>
        <input
          role="combobox"
          aria-expanded={shown}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={shown && at >= 0 ? `${id}-${at}` : undefined}
          value={value}
          onChange={(e) => {
            onChange(e.target.value)
            setOpen(true)
            setActive(-1)
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (!shown || e.nativeEvent.isComposing) return // 한글 조합 중 Enter는 글자 확정용
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              const step = e.key === 'ArrowDown' ? 1 : -1
              setActive((at + step + items.length) % items.length)
            } else if (e.key === 'Enter' && at >= 0) {
              e.preventDefault() // 폼 제출 대신 고르기
              pick(items[at])
            } else if (e.key === 'Escape') {
              // 추천만 닫고 창(<dialog>)은 그대로 — 브라우저가 Esc로 창을 닫는 기본 동작을 막음
              e.preventDefault()
              e.stopPropagation()
              setOpen(false)
            }
          }}
          placeholder={placeholder}
          inputMode={inputMode}
          autoComplete="off"
          aria-invalid={!!error || invalid}
          className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-ops-faint"
        />
        {shown && (
          <ul
            id={`${id}-list`}
            role="listbox"
            className="absolute top-full right-0 left-0 z-20 mt-1 max-h-60 overflow-auto rounded-md bg-white py-1 shadow-lg ring-1 ring-ops-line"
          >
            {items.map((item, i) => (
              <li
                key={itemKey(item)}
                id={`${id}-${i}`}
                role="option"
                aria-selected={i === at}
                // mousedown에서 막아야 칸이 포커스를 잃어 목록이 먼저 닫히지 않음
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(item)}
                onMouseEnter={() => setActive(i)}
                className={`cursor-pointer px-3 py-2 text-[13px] ${i === at ? 'bg-ops-route-soft' : ''}`}
              >
                {renderItem(item)}
              </li>
            ))}
          </ul>
        )}
      </span>
      {error && <Err>{error}</Err>}
    </label>
  )
}

/** 주소 칸 — 직접 칠 수 없고 누르면 검색 (오타 주소 방지) */
export function AddressButton({
  label = '주소',
  value,
  error,
  onClick,
}: {
  label?: string
  value: string
  error?: string
  onClick: () => void
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label>{label}</Label>
      <button
        type="button"
        onClick={onClick}
        className={`${box(error)} gap-2 text-left text-[14px] hover:bg-ops-paper`}
      >
        <Icon name="search" className="size-4 text-ops-faint" />
        <span className={`min-w-0 flex-1 truncate ${value ? '' : 'text-ops-faint'}`}>
          {value || '주소 검색'}
        </span>
      </button>
      {error && <Err>{error}</Err>}
    </div>
  )
}

/** 고르기 버튼 묶음 (결제 방식 · 역할) */
export function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T | null
  options: { value: T; label: string; disabledHint?: string }[] // disabledHint = 끄고 칸 안에 작게 이유 ('AI 미지원', 07 음성)
  onChange: (v: T) => void
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-col gap-1">
      <Label>{label}</Label>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={value === o.value}
            disabled={!!o.disabledHint}
            onClick={() => onChange(o.value)}
            className={`h-8 rounded-md px-3 text-[13px] font-medium ring-1 ring-inset disabled:pointer-events-none disabled:text-ops-faint ${value === o.value ? 'bg-ops-route-soft text-ops-route ring-ops-route' : 'ring-ops-line hover:bg-ops-paper'}`}
          >
            {o.label}
            {o.disabledHint && <span className="ml-1 text-[11px]">{o.disabledHint}</span>}
          </button>
        ))}
      </div>
    </div>
  )
}

/** 파일 칸 — 끌어다 놓기 · [파일 선택]. 고르면 파일 이름 줄 + [빼기] */
export function FileDrop({
  file,
  accept,
  error,
  onPick,
  onRemove,
}: {
  file: File | null
  accept: string
  error?: string
  onPick: (file: File) => void
  onRemove: () => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  return (
    <div className="flex flex-col gap-2">
      {file ? (
        <div className={`${box(error)} gap-2`}>
          <Icon name="file" className="size-4 text-ops-sub" />
          <span className="min-w-0 flex-1 truncate text-[14px]">{file.name}</span>
          <button
            type="button"
            onClick={onRemove}
            aria-label="파일 빼기"
            className="grid size-7 place-items-center rounded text-ops-sub hover:bg-ops-paper hover:text-ops-ink"
          >
            <Icon name="x" />
          </button>
        </div>
      ) : (
        <div
          onDragOver={(e) => {
            e.preventDefault()
            setOver(true)
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setOver(false)
            const f = e.dataTransfer.files[0]
            if (f) onPick(f)
          }}
          className={`flex flex-col items-center gap-2 rounded-md border border-dashed px-4 py-6 ${over ? 'border-ops-route bg-ops-route-soft' : 'border-ops-line bg-ops-paper'}`}
        >
          <p className="text-[13px] text-ops-sub">파일을 끌어다 놓거나</p>
          <Btn onClick={() => input.current?.click()}>파일 선택</Btn>
          <p className="text-[12px] text-ops-faint">엑셀(.xlsx)이나 CSV</p>
        </div>
      )}
      <input
        ref={input}
        type="file"
        accept={accept}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onPick(f)
          e.target.value = '' // 같은 파일을 다시 골라도 onChange가 오게
        }}
      />
      {error && <Err>{error}</Err>}
    </div>
  )
}
