// 수량 칸 '서류 [− 0 +]' (03 주문 추가 품목) — 칸 높이 32 · 선은 안쪽 ring. 0이면 [−] 흐리게
export function Stepper({
  label,
  value,
  onChange,
  max = 99,
}: {
  label: string
  value: number
  onChange: (n: number) => void
  max?: number
}) {
  const btn = 'grid size-8 place-items-center text-body disabled:text-muted'
  return (
    <span className="flex items-center gap-2">
      <span className="text-label text-sub">{label}</span>
      <span className="flex h-8 items-center rounded-lg bg-surface ring-1 ring-line ring-inset">
        <button
          type="button"
          className={`${btn} text-sub`}
          disabled={value <= 0}
          onClick={() => onChange(value - 1)}
          aria-label={`${label} 빼기`}
        >
          −
        </button>
        <span className="w-6 text-center text-body font-bold" aria-live="polite">
          {value}
        </span>
        <button
          type="button"
          className={`${btn} font-bold text-action`}
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
