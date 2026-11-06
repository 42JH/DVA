import { useContext } from 'react'
import { NewLook } from './newLook'

// 수량 칸 '서류 [− 0 +]' (03 주문 추가 품목) — 칸 높이 32 · 선은 안쪽 ring. 0이면 [−] 흐리게
// 새 디자인 창(Dialog) 안이면 라벨 16 · 선 = 검색칸 색 · [+] 파랑 (newLook.ts)
export function Stepper({
  label,
  value,
  onChange,
  max = 99,
  editable = false,
}: {
  label: string
  value: number
  onChange: (n: number) => void
  max?: number
  editable?: boolean // 가운데 숫자를 직접 입력 (03 주문 추가). 0은 빈 칸, max는 [+]만 막음 — 넘는 값은 화면이 오류로 알림
}) {
  const fresh = useContext(NewLook)
  const btn = 'grid size-8 place-items-center text-body disabled:text-muted'
  return (
    <span className="flex items-center gap-2">
      <span className={`text-sub ${fresh ? 'text-body' : 'text-label'}`}>{label}</span>
      <span
        className={`flex h-7 items-center rounded-lg bg-surface ring-1 ring-inset ${fresh ? 'ring-field' : 'ring-line'}`}
      >
        <button
          type="button"
          className={`${btn} text-sub`}
          disabled={value <= 0}
          onClick={() => onChange(value - 1)}
          aria-label={`${label} 빼기`}
        >
          −
        </button>
        {editable ? (
          <input
            className="w-8 text-center text-body font-bold"
            inputMode="numeric"
            aria-label={`${label} 수량`}
            value={value || ''}
            onChange={(e) => onChange(Number(e.target.value.replace(/\D/g, '').slice(0, 3)))}
          />
        ) : (
          <span className="w-6 text-center text-body font-bold" aria-live="polite">
            {value}
          </span>
        )}
        <button
          type="button"
          className={`${btn} font-bold ${fresh ? 'text-brand' : 'text-action'}`}
          disabled={value >= max}
          onClick={() => onChange(value + 1)}
          aria-label={`${label} 더하기`}
        >
          +
        </button>
      </span>
    </span>
  )
}
