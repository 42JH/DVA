// 토글 40x24 (와이어프레임 04 Switch) — 켬 = 남색 바탕 흰 손잡이 · 끔 = 옅은 바탕 회색 선 회색 손잡이. 06 'AI 동작 표시'
export function Switch({
  on,
  onChange,
  label,
}: {
  on: boolean
  onChange: (on: boolean) => void
  label: string // 옆에 보이는 글 ('AI 동작 표시')
}) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-3 text-label font-semibold text-ink">
      {label}
      <button
        type="button"
        role="switch"
        aria-checked={on}
        onClick={() => onChange(!on)}
        className={`relative h-6 w-10 rounded-full transition-colors ${on ? 'bg-action' : 'border border-muted bg-bg'}`}
      >
        <span
          className={`absolute top-1/2 size-[18px] -translate-y-1/2 rounded-full transition-[left] ${
            on ? 'left-[19px] bg-white' : 'left-[3px] bg-muted'
          }`}
        />
      </button>
    </label>
  )
}
