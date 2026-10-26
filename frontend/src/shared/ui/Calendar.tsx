import { useState } from 'react'
import { Button } from './Button'
import { fmtRange, monthGrid, pickRange, rangeDays, todayYmd, type Ymd } from '../lib/dateRange'

// 기간 선택 달력 (와이어프레임 12 Calendar · 02 대시보드) — 한 달 · 일요일 시작 · 칸 44
// 오늘 = 남색 테두리 · 오늘 이후 = 흐리게(못 고름) · 시작/끝 = 남색 원 · 사이 = 옅은 띠 · 아래 '10.01 ~ 10.15 15일' + [취소] [적용]
// 범위 계산은 shared/lib/dateRange.ts (자체 검사 있음)

const DOW = ['일', '월', '화', '수', '목', '금', '토']
const pad = (n: number) => String(n).padStart(2, '0')

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
  const [view, setView] = useState(() => {
    const base = value?.from ?? today
    return { y: Number(base.slice(0, 4)), m: Number(base.slice(5, 7)) }
  })
  const [range, setRange] = useState<{ from?: Ymd; to?: Ymd }>(value ?? {})

  const move = (d: number) =>
    setView(({ y, m }) => {
      const t = new Date(y, m - 1 + d, 1)
      return { y: t.getFullYear(), m: t.getMonth() + 1 }
    })
  const cells = monthGrid(view.y, view.m)
  const key = (d: number): Ymd => `${view.y}-${pad(view.m)}-${pad(d)}`
  const complete = range.from && range.to ? { from: range.from, to: range.to } : null

  return (
    <div className="w-[356px] rounded-xl border border-line bg-surface p-6 shadow-[0_14px_40px_rgba(43,47,54,0.16)]">
      <div className="mb-3 flex items-center justify-between">
        <button
          type="button"
          onClick={() => move(-1)}
          aria-label="이전 달"
          className="grid size-8 place-items-center rounded-lg text-sub hover:bg-bg"
        >
          ‹
        </button>
        <span className="text-strong font-bold">
          {view.y}년 {view.m}월
        </span>
        <button
          type="button"
          onClick={() => move(1)}
          aria-label="다음 달"
          className="grid size-8 place-items-center rounded-lg text-sub hover:bg-bg"
        >
          ›
        </button>
      </div>
      <div className="grid grid-cols-7 text-center text-caption text-sub">
        {DOW.map((d) => (
          <span key={d} className="h-7 leading-7">
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
              className={`relative grid h-11 place-items-center ${
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
      <div className="mt-3 flex items-center justify-between border-t border-line pt-4">
        <span className="text-label">
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
        </span>
        <div className="flex gap-2">
          <Button onClick={onCancel}>취소</Button>
          <Button kind="primary" disabled={!complete} onClick={() => complete && onApply(complete)}>
            적용
          </Button>
        </div>
      </div>
    </div>
  )
}
