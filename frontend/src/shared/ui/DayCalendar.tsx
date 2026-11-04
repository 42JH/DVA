import { useState } from 'react'
import { monthGrid, todayYmd, type Ymd } from '@/shared/lib/dateRange'
import { slideClass, useSlideDir } from '@/shared/lib/useSlideDir'

// 하루 고르기 달력 (Figma 'calendar_popover' 11/04 — 04 통화 날짜) — 356 · 한 달 · 일요일 시작 · 칸 44
// 머리 '2026년 10월'(22/700) ‹ › · 요일 17 · 날짜 18, 고른 날 = 파랑 원(34) · 오늘 이후 = 흐리게(못 고름)
// 아래 고른 날 '10.20'(18/700, 다른 해면 '2025.12.29') + [취소] [적용]. 기간 고르기 달력은 Calendar (옛 디자인 화면)

const DOW = ['일', '월', '화', '수', '목', '금', '토']
const pad = (n: number) => String(n).padStart(2, '0')
const BTN = 'h-10 w-18 rounded-lg text-strong font-bold'

const Chevron = ({ dir }: { dir: 'prev' | 'next' }) => (
  <svg
    viewBox="0 0 20 20"
    className="size-5"
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

export function DayCalendar({
  value,
  onApply,
  onCancel,
}: {
  value: Ymd
  onApply: (day: Ymd) => void
  onCancel: () => void
}) {
  const today = todayYmd()
  const [picked, setPicked] = useState(value)
  const [view, setView] = useState({ y: Number(value.slice(0, 4)), m: Number(value.slice(5, 7)) })
  const slide = slideClass(useSlideDir(view.y * 12 + view.m)) // ‹ › 방향에서 달이 미끄러져 들어옴
  const atThisMonth = `${view.y}-${pad(view.m)}` >= today.slice(0, 7) // 미래 달로는 못 감
  const move = (d: number) =>
    setView(({ y, m }) => {
      const t = new Date(y, m - 1 + d, 1)
      return { y: t.getFullYear(), m: t.getMonth() + 1 }
    })
  const label =
    picked.slice(0, 4) === today.slice(0, 4)
      ? `${picked.slice(5, 7)}.${picked.slice(8)}`
      : picked.replaceAll('-', '.')

  return (
    <div className="w-[356px] rounded-xl bg-surface p-6 shadow-[0_14px_40px_rgba(43,47,54,0.16)] ring-1 ring-line ring-inset">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => move(-1)}
          aria-label="이전 달"
          className="grid size-8 place-items-center rounded-lg text-sub hover:bg-bg"
        >
          <Chevron dir="prev" />
        </button>
        <span className="text-[22px] font-bold">
          {view.y}년 {view.m}월
        </span>
        <button
          type="button"
          onClick={() => move(1)}
          disabled={atThisMonth}
          aria-label="다음 달"
          className="grid size-8 place-items-center rounded-lg text-sub hover:bg-bg disabled:text-line disabled:hover:bg-transparent"
        >
          <Chevron dir="next" />
        </button>
      </div>

      <div key={`${view.y}-${view.m}`} className={`mt-3 ${slide}`}>
        <div className="grid grid-cols-7 text-center text-[17px] text-sub">
          {DOW.map((d) => (
            <span key={d} className="h-6 leading-6">
              {d}
            </span>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {monthGrid(view.y, view.m).map((d, i) => {
            if (d === null) return <span key={`b${i}`} />
            const k: Ymd = `${view.y}-${pad(view.m)}-${pad(d)}`
            const future = k > today
            const on = k === picked
            return (
              <button
                key={k}
                type="button"
                disabled={future}
                aria-pressed={on}
                aria-label={`${view.m}월 ${d}일`}
                onClick={() => setPicked(k)}
                className="group grid h-[38px] place-items-center"
              >
                <span
                  className={`grid size-[34px] place-items-center rounded-full text-strong ${
                    on
                      ? 'bg-brand font-bold text-white'
                      : future
                        ? 'text-muted'
                        : 'text-ink group-hover:bg-bg'
                  }`}
                >
                  {d}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="mt-3 flex items-center border-t border-line pt-4">
        <b className="text-strong font-bold">{label}</b>
        <button
          type="button"
          onClick={onCancel}
          className={`${BTN} ml-auto bg-surface ring-1 ring-line ring-inset hover:bg-bg`}
        >
          취소
        </button>
        <button
          type="button"
          onClick={() => onApply(picked)}
          className={`${BTN} ml-2 bg-brand text-white`}
        >
          적용
        </button>
      </div>
    </div>
  )
}
