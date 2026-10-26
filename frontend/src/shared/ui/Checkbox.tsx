// 체크박스 20x20 · 모서리 4. state: off · on · some(일부 선택, 머리 칸)
export function Checkbox({
  state,
  onChange,
  label,
}: {
  state: 'off' | 'on' | 'some'
  onChange: () => void
  label: string // 스크린리더용
}) {
  const on = state !== 'off'
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state === 'some' ? 'mixed' : on}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation() // 줄 클릭(상세 이동)과 분리
        onChange()
      }}
      className={`grid size-5 shrink-0 place-items-center rounded ${on ? 'bg-action' : 'border-[1.5px] border-muted bg-surface'}`}
    >
      {on && (
        <svg
          viewBox="0 0 20 20"
          className="size-5 stroke-white"
          fill="none"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {state === 'on' ? <path d="M5 10l3.5 3.5L15 6.5" /> : <path d="M5 10h10" />}
        </svg>
      )}
    </button>
  )
}
