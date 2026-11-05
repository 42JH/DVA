import { useCallback, useRef, useState, type ReactNode } from 'react'
import { useDismiss } from '@/shared/lib/useDismiss'
import { KIND_LABEL } from '@/features/call/labels'
import { DurationRange } from './DurationRange'
import { KINDS, NO_FILTER, type CallFilterForm } from '@/features/call/hooks/useCallList'

// 04 통화 필터 (Figma '필터 팝오버' 11/04) — 머리의 필터 아이콘을 누르면 아래에 360 창. 고친 값은 [적용]을 눌러야 목록에 반영
// 고객 구분 [전체 | 신규] · 상담 유형 접수 · 조회 · 취소 · FAQ(하나라도 한 통화). 고객 유형(기업 · 개인)은 뺌 — 통화 목록 API에 값이 없음 (11/04 사용자)
// 통화 시간 0~20분 = DurationRange (막대 + 아래 분 입력칸) · 초기화 = 창 안 값만 처음으로
const CHIP = 'h-8 min-w-15 rounded-full px-4 text-body font-semibold'
const chipTone = (on: boolean) =>
  on ? 'bg-brand text-white' : 'bg-surface text-sub ring-1 ring-line ring-inset hover:bg-bg'

const FilterIcon = () => (
  <svg
    viewBox="0 0 32 32"
    className="size-8"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M5.33 8h5.34M16 8h10.67M5.33 16h13.34M24 16h2.67M5.33 24H8M13.33 24h13.34" />
    <circle cx="13.33" cy="8" r="2.67" />
    <circle cx="21.33" cy="16" r="2.67" />
    <circle cx="10.67" cy="24" r="2.67" />
  </svg>
)

/** 필터 아이콘 + 창. 거르고 있으면 아이콘이 파랑 + 점 */
export function CallFilter({
  value,
  active,
  onApply,
}: {
  value: CallFilterForm
  active: boolean
  onApply: (f: CallFilterForm) => void
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(open, root, close)
  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-label={active ? '필터 (적용 중)' : '필터'}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`relative grid size-8 place-items-center rounded-lg hover:bg-bg ${active ? 'text-brand' : 'text-ink'}`}
      >
        <FilterIcon />
        {active && <span className="absolute top-0.5 right-0.5 size-2 rounded-full bg-brand" />}
      </button>
      {open && (
        <FilterPanel
          initial={value}
          onApply={(f) => {
            onApply(f)
            close()
          }}
        />
      )}
    </div>
  )
}

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="flex flex-col gap-4">
    <h3 className="text-label font-bold">{title}</h3>
    {children}
  </section>
)

function FilterPanel({
  initial,
  onApply,
}: {
  initial: CallFilterForm
  onApply: (f: CallFilterForm) => void
}) {
  const [f, setF] = useState(initial)
  const toggle = (k: (typeof KINDS)[number]) =>
    setF((x) => ({
      ...x,
      kinds: x.kinds.includes(k)
        ? x.kinds.filter((y) => y !== k)
        : KINDS.filter((y) => y === k || x.kinds.includes(y)),
    }))

  return (
    <div
      role="dialog"
      aria-label="필터"
      className="absolute top-full right-0 z-20 mt-3 flex w-[360px] origin-top-right flex-col gap-4 rounded-xl bg-surface p-5 shadow-[0_12px_12px_rgba(0,0,0,0.08),0_2px_4px_rgba(0,0,0,0.04)] ring-1 ring-line motion-safe:animate-pop-in"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-strong font-bold">필터</h2>
        <button
          type="button"
          onClick={() => setF(NO_FILTER)}
          className="text-label font-medium text-sub hover:text-ink"
        >
          초기화
        </button>
      </div>
      <hr className="border-line" />

      <Section title="고객 구분">
        <div
          role="radiogroup"
          aria-label="고객 구분"
          className="grid h-8 w-[120px] grid-cols-2 rounded-full bg-line p-0.5"
        >
          {[false, true].map((v) => (
            <button
              key={String(v)}
              type="button"
              role="radio"
              aria-checked={f.newOnly === v}
              onClick={() => setF((x) => ({ ...x, newOnly: v }))}
              className={`rounded-full text-label font-bold ${f.newOnly === v ? 'bg-brand text-white' : 'text-sub'}`}
            >
              {v ? '신규' : '전체'}
            </button>
          ))}
        </div>
      </Section>

      <Section title="상담 유형">
        <div className="flex flex-wrap gap-2">
          {KINDS.map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={f.kinds.includes(k)}
              onClick={() => toggle(k)}
              className={`${CHIP} ${chipTone(f.kinds.includes(k))}`}
            >
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
      </Section>
      <hr className="border-line" />

      <Section title="통화 시간">
        <DurationRange
          min={f.min}
          max={f.max}
          onChange={(min, max) => setF((x) => ({ ...x, min, max }))}
        />
      </Section>
      <hr className="border-line" />

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => onApply(f)}
          className="h-8 w-18 rounded-lg bg-brand text-strong font-bold text-white"
        >
          적용
        </button>
      </div>
    </div>
  )
}
