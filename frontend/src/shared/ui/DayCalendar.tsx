import { useCallback, useRef, useState } from 'react'
import { monthGrid, todayYmd, type Ymd } from '@/shared/lib/dateRange'
import { fmtLongDay, fmtMonthDay } from '@/shared/lib/format'
import { useDismiss } from '@/shared/lib/useDismiss'
import { ExitGhost } from '@/shared/lib/useExitGhost'
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

/** 날짜별 목록 머리의 📅 날짜 (04 통화 · 03 주문, Figma 11/04) — 누르면 아래에 하루 고르기 달력 (고르면 그 날부터) */
/** small = 표 머리줄 첫 칸 (03 주문 11/06 시안) — 달력 16 · '11월 4일' 16/600 */
export function DayPick({
  day,
  onPick,
  small,
}: {
  day: Ymd
  onPick: (d: Ymd) => void
  small?: boolean
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const pop = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(open, root, close)
  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${fmtLongDay(day)} — 날짜 고르기`}
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center hover:text-brand ${small ? 'gap-2 text-body font-semibold' : 'gap-3 text-title font-normal'}`}
      >
        <svg
          viewBox="0 0 32 32"
          className={`shrink-0 ${small ? 'size-4' : 'size-8'}`}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M28 13.33H4M21.33 2.67V8M10.67 2.67V8M14 18.67l2-1.34V24M14.33 24h3.34M10.4 29.33h11.2c2.24 0 3.36 0 4.22-.43a4 4 0 0 0 1.75-1.75c.43-.86.43-1.98.43-4.22v-11.2c0-2.24 0-3.36-.43-4.22a4 4 0 0 0-1.75-1.75c-.86-.43-1.98-.43-4.22-.43H10.4c-2.24 0-3.36 0-4.22.43a4 4 0 0 0-1.75 1.75C4 8.37 4 9.49 4 11.73v11.2c0 2.24 0 3.36.43 4.22a4 4 0 0 0 1.75 1.75c.86.43 1.98.43 4.22.43Z" />
        </svg>
        {small ? fmtMonthDay(day) : fmtLongDay(day)}
      </button>
      {open && (
        <div
          ref={pop}
          className="absolute top-full left-0 z-20 mt-3 origin-top-left motion-safe:animate-pop-in"
        >
          <ExitGhost target={pop} />
          <DayCalendar
            value={day}
            onApply={(d) => {
              onPick(d)
              close()
            }}
            onCancel={close}
          />
        </div>
      )}
    </div>
  )
}
