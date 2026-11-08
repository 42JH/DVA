// v2 입력 칸 공통 — 주문 · 사원 · CSV 창이 같이 씀. 글자: 칸 이름 12 · 입력 14 · 안내 · 오류 12
import { useRef, useState, type ReactNode } from 'react'
import { Btn, Icon } from './index'

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
  value,
  onChange,
  error,
  suffix,
  placeholder,
  inputMode,
  readOnly,
  invalid,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  error?: string
  suffix?: string
  placeholder?: string
  inputMode?: 'numeric' | 'tel'
  readOnly?: boolean // 바꿀 수 없는 칸 (회색 바탕)
  invalid?: boolean // 글 없이 빨간 테두리만 (오류 글은 묶음 아래에 한 번)
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <Label>{label}</Label>
      <span className={`${box(error || invalid)} ${readOnly ? 'bg-ops-paper! text-ops-sub' : ''}`}>
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          inputMode={inputMode}
          readOnly={readOnly}
          aria-invalid={!!error || invalid}
          className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-ops-faint"
        />
        {suffix && <span className="text-[13px] text-ops-sub">{suffix}</span>}
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
  options: { value: T; label: string }[]
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
            onClick={() => onChange(o.value)}
            className={`h-8 rounded-md px-3 text-[13px] font-medium ring-1 ring-inset ${value === o.value ? 'bg-ops-route-soft text-ops-route ring-ops-route' : 'ring-ops-line hover:bg-ops-paper'}`}
          >
            {o.label}
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
