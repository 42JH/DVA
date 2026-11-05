import { useState } from 'react'
import { DUR_MAX } from '@/features/call/hooks/useCallList'

// 04 통화 필터 '통화 시간' (11/05) — 창 너비 막대(얇은 선 + 흰 손잡이) 아래에 [ 3  분 ] ~ [ 10  분 ] 입력칸
// 손잡이와 칸은 같은 값: 칸에 치면 손잡이가, 손잡이를 끌면 칸이 바뀜. 끝(DUR_MAX)이면 '분+' = 위 제한 없음
const THUMB = 24
const RANGE =
  'pointer-events-none absolute inset-0 appearance-none bg-transparent outline-none ' +
  '[&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:size-6 [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-[0_1px_4px_rgba(0,0,0,0.2)] ' +
  '[&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:size-6 [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-white [&::-moz-range-thumb]:shadow-[0_1px_4px_rgba(0,0,0,0.2)] ' +
  'focus-visible:[&::-webkit-slider-thumb]:ring-2 focus-visible:[&::-webkit-slider-thumb]:ring-brand/40'

/** 분 입력칸. 치는 동안은 글자 그대로 두고, 칸을 떠날 때(또는 Enter) 한 번만 고쳐서 올림 */
function MinuteBox({
  label,
  value,
  plus,
  onCommit,
}: {
  label: string
  value: number
  plus?: boolean
  onCommit: (v: number) => void
}) {
  const [text, setText] = useState<string | null>(null) // null = 안 치는 중 → value를 보여 줌
  const commit = () => {
    const n = Math.floor(Number(text))
    if (text !== '' && Number.isFinite(n)) onCommit(n) // 빈칸 · 글자는 버리고 원래 값으로
    setText(null)
  }
  return (
    <label className="flex h-10 flex-1 items-center gap-2 rounded-lg bg-surface px-3.5 ring-1 ring-line ring-inset focus-within:ring-[1.5px] focus-within:ring-brand">
      <input
        inputMode="numeric"
        aria-label={label}
        value={text ?? String(value)}
        onFocus={(e) => {
          setText(String(value))
          e.target.select()
        }}
        onChange={(e) => setText(e.target.value.replace(/\D/g, ''))}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        className="w-full min-w-0 bg-transparent text-body text-ink outline-none"
      />
      <span className="shrink-0 text-body text-sub">{plus && text === null ? '분+' : '분'}</span>
    </label>
  )
}

export function DurationRange({
  min,
  max,
  onChange,
}: {
  min: number
  max: number
  onChange: (min: number, max: number) => void
}) {
  const at = (v: number) => v / DUR_MAX
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
  const setMin = (v: number) => onChange(clamp(v, 0, max), max)
  const setMax = (v: number) => onChange(min, clamp(v, min, DUR_MAX))

  return (
    <div className="flex flex-col gap-4">
      <div className="relative h-6">
        <div
          aria-hidden
          className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-line"
        />
        <div
          aria-hidden
          className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-brand"
          style={{
            // 손잡이 가운데부터 가운데까지 — range는 손잡이 반만큼 안쪽에서 움직임
            left: `calc(${THUMB / 2}px + (100% - ${THUMB}px) * ${at(min)})`,
            width: `calc((100% - ${THUMB}px) * ${at(max) - at(min)})`,
          }}
        />
        <input
          type="range"
          min={0}
          max={DUR_MAX}
          value={min}
          aria-label="통화 시간 최소(분)"
          onChange={(e) => setMin(Number(e.target.value))}
          className={`${RANGE} ${min >= DUR_MAX - 1 ? 'z-10' : ''}`} // 오른쪽 끝에 겹치면 최소 손잡이가 위로 (잡을 수 있게)
        />
        <input
          type="range"
          min={0}
          max={DUR_MAX}
          value={max}
          aria-label="통화 시간 최대(분)"
          onChange={(e) => setMax(Number(e.target.value))}
          className={RANGE}
        />
      </div>
      <div className="flex items-center gap-2">
        <MinuteBox label="통화 시간 최소(분) 입력" value={min} onCommit={setMin} />
        <span className="text-body font-bold text-ink">~</span>
        <MinuteBox
          label="통화 시간 최대(분) 입력"
          value={max}
          plus={max >= DUR_MAX}
          onCommit={setMax}
        />
      </div>
    </div>
  )
}
