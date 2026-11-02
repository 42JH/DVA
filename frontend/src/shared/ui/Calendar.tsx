import { useState } from 'react'
import { Button } from './Button'
import {
  fmtRange,
  monthGrid,
  pickRange,
  rangeDays,
  todayYmd,
  type Ymd,
} from '@/shared/lib/dateRange'
import { slideClass, useSlideDir } from '@/shared/lib/useSlideDir'

// 기간 선택 달력 (와이어프레임 12 Calendar · 02 대시보드) — 한 달 · 일요일 시작 · 칸 44
// 오늘 = 남색 테두리 · 오늘 이후 = 흐리게(못 고름) · 시작/끝 = 남색 원 · 사이 = 옅은 띠 · 아래 '10.01 ~ 10.15 15일' + [취소] [적용]
// 11/01: 머리의 '2026년'을 누르면 연도 판(12년씩), '11월'을 누르면 월 판(12달) → 고르면 날짜 판으로 돌아옴
//        ‹ › 는 판에 따라 달 · 해 · 12해씩 움직이고, 판이 그 방향에서 미끄러져 들어옴. 판을 바꿀 땐 떠오름
// 범위 계산은 shared/lib/dateRange.ts (자체 검사 있음)

const DOW = ['일', '월', '화', '수', '목', '금', '토']
const pad = (n: number) => String(n).padStart(2, '0')
type Mode = 'day' | 'month' | 'year'

/** 달 이동 화살표 — 글자(‹ ›)가 아니라 16 칸 아이콘 (페이지 번호 화살표와 같은 모양) */
function Chevron({ dir }: { dir: 'prev' | 'next' }) {
  return (
    <svg
      viewBox="0 0 20 20"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {dir === 'prev' ? <path d="M12 5l-5 5 5 5" /> : <path d="M8 5l5 5-5 5" />}
    </svg>
  )
}

/** 월 · 연도 판의 칸 (3 × 4, 높이 44) — 고른 것은 옅은 남색 · 굵게, 미래는 흐리게(못 고름) */
function Cell({
  label,
  selected,
  disabled,
  onClick,
}: {
  label: string
  selected: boolean
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`h-10 rounded-lg text-label ${
        selected
          ? 'bg-action-soft font-bold text-action'
          : disabled
            ? 'text-muted'
            : 'text-ink hover:bg-bg'
      }`}
    >
      {label}
    </button>
  )
}

export function Calendar({
  value,
  onApply,
  onCancel,
}: {
  value?: { from: Ymd; to: Ymd }
  onApply: (range: { from: Ymd; to: Ymd }) => void
  onCancel: () => void
}) {
  const today = todayYmd()
  const todayY = Number(today.slice(0, 4))
  const todayM = Number(today.slice(5, 7))
  const [view, setView] = useState(() => {
    const base = value?.from ?? today
    return { y: Number(base.slice(0, 4)), m: Number(base.slice(5, 7)) }
  })
  const [range, setRange] = useState<{ from?: Ymd; to?: Ymd }>(value ?? {})
  const [mode, setMode] = useState<Mode>('day')
  const [anim, setAnim] = useState<'slide' | 'fade'>('slide') // ‹ › 는 미끄러짐, 판 바꾸기는 떠오름

  const yearBase = Math.floor(view.y / 12) * 12 // 연도 판 = 12년 묶음 (2016 ~ 2027)
  const move = (d: number) => {
    setAnim('slide')
    setView(({ y, m }) => {
      if (mode === 'year') return { y: y + 12 * d, m }
      if (mode === 'month') return { y: y + d, m }
      const t = new Date(y, m - 1 + d, 1)
      return { y: t.getFullYear(), m: t.getMonth() + 1 }
    })
  }
  const switchMode = (next: Mode) => {
    setAnim('fade')
    setMode(next)
  }
  // 판이 어디로 움직였는지 (useSlideDir) — 날짜 판은 달 번호, 월 판은 해, 연도 판은 12년 묶음 번호
  const idx = mode === 'day' ? view.y * 12 + view.m : mode === 'month' ? view.y : yearBase / 12
  const dir = useSlideDir(idx)
  const bodyClass = anim === 'fade' ? 'motion-safe:animate-page-in' : slideClass(dir)

  const cells = monthGrid(view.y, view.m)
  const key = (d: number): Ymd => `${view.y}-${pad(view.m)}-${pad(d)}`
  const complete = range.from && range.to ? { from: range.from, to: range.to } : null
  const headBtn = 'rounded-lg px-2 py-1 text-strong font-bold hover:bg-bg'

  return (
    // 선은 안쪽 ring — 안쪽 폭이 정확히 356 − 48 = 308 = 44 × 7 (칸이 소수점에 안 걸리게)
    <div className="w-[356px] rounded-xl bg-surface p-6 shadow-[0_14px_40px_rgba(43,47,54,0.16)] ring-1 ring-line ring-inset">
      <div className="mb-3 flex items-center justify-between">
        <button
          type="button"
          onClick={() => move(-1)}
          aria-label={mode === 'day' ? '이전 달' : mode === 'month' ? '이전 해' : '이전 12년'}
          className="grid size-8 place-items-center rounded-lg text-sub hover:bg-bg"
        >
          <Chevron dir="prev" />
        </button>
        {mode === 'year' ? (
          <span className="text-strong font-bold">
            {yearBase}년 ~ {yearBase + 11}년
          </span>
        ) : (
          <span className="flex items-center">
            <button type="button" onClick={() => switchMode('year')} className={headBtn}>
              {view.y}년
            </button>
            {mode === 'day' && (
              <button type="button" onClick={() => switchMode('month')} className={headBtn}>
                {view.m}월
              </button>
            )}
          </span>
        )}
        <button
          type="button"
          onClick={() => move(1)}
          aria-label={mode === 'day' ? '다음 달' : mode === 'month' ? '다음 해' : '다음 12년'}
          className="grid size-8 place-items-center rounded-lg text-sub hover:bg-bg"
        >
          <Chevron dir="next" />
        </button>
      </div>

      {/* 판: key 가 바뀌면 새로 그려져 애니메이션이 돎 */}
      <div key={`${mode}-${idx}`} className={bodyClass}>
        {mode === 'day' && (
          <>
            <div className="grid grid-cols-7 text-center text-caption text-sub">
              {DOW.map((d) => (
                <span key={d} className="h-6 leading-6">
                  {d}
                </span>
              ))}
            </div>
            <div className="grid grid-cols-7">
              {cells.map((d, i) => {
                if (d === null) return <span key={`b${i}`} />
                const k = key(d)
                const future = k > today
                const isFrom = k === range.from
                const isTo = k === range.to
                const inside = !!range.from && !!range.to && k > range.from && k < range.to
                const isEdge = isFrom || isTo
                return (
                  <button
                    key={k}
                    type="button"
                    disabled={future}
                    onClick={() => setRange((r) => pickRange(r, k))}
                    className={`relative grid h-10 place-items-center ${
                      inside ? 'bg-action-soft' : ''
                    } ${isFrom && range.to ? 'rounded-l-full bg-action-soft' : ''} ${isTo ? 'rounded-r-full bg-action-soft' : ''}`}
                  >
                    <span
                      className={`grid size-[34px] place-items-center rounded-full text-label ${
                        isEdge
                          ? 'bg-action font-bold text-white'
                          : future
                            ? 'text-muted'
                            : inside
                              ? 'font-semibold text-action'
                              : k === today
                                ? 'border-[1.5px] border-action font-semibold text-ink'
                                : 'text-ink'
                      }`}
                    >
                      {d}
                    </span>
                  </button>
                )
              })}
            </div>
          </>
        )}
        {mode === 'month' && (
          <div className="grid grid-cols-3 gap-1">
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
              <Cell
                key={m}
                label={`${m}월`}
                selected={m === view.m}
                disabled={view.y > todayY || (view.y === todayY && m > todayM)}
                onClick={() => {
                  setView((v) => ({ ...v, m }))
                  switchMode('day')
                }}
              />
            ))}
          </div>
        )}
        {mode === 'year' && (
          <div className="grid grid-cols-3 gap-1">
            {Array.from({ length: 12 }, (_, i) => yearBase + i).map((y) => (
              <Cell
                key={y}
                label={`${y}년`}
                selected={y === view.y}
                disabled={y > todayY}
                onClick={() => {
                  setView((v) => ({ y, m: Math.min(v.m, y === todayY ? todayM : 12) })) // 올해면 미래 달로 가지 않게
                  switchMode('month')
                }}
              />
            ))}
          </div>
        )}
      </div>

      {/* 기간 글은 버튼 옆이 아니라 위 한 줄에 — 다른 해가 섞이면 '2025.11.02 ~ 2026.11.02 366일'이 버튼 옆 폭에 안 들어가 두 줄로 접히며 높이가 뛰었음 (11/02) */}
      <div className="mt-3 border-t border-line pt-4">
        <p className="truncate text-label">
          {complete ? (
            <>
              <b className="font-bold text-ink">{fmtRange(complete.from, complete.to)}</b>{' '}
              <span className="text-sub">{rangeDays(complete.from, complete.to)}일</span>
            </>
          ) : (
            <span className="text-muted">
              {range.from ? '끝 날짜를 고르세요' : '시작 날짜를 고르세요'}
            </span>
          )}
        </p>
        <div className="mt-3 flex justify-end gap-2">
          <Button onClick={onCancel}>취소</Button>
          <Button kind="primary" disabled={!complete} onClick={() => complete && onApply(complete)}>
            적용
          </Button>
        </div>
      </div>
    </div>
  )
}
