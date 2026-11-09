// 통화 기록 한 줄씩 — 통화 상세 · 주문의 통화 창이 같이 씀
// 말: [이름 칸 | 말 | 시각] 줄 맞춤 (상자 없이 간격 · 굵기로만 나눔)
// AI 동작: 말 칸 아래로 들여 쓰고 가는 세로줄로 묶음. [종류 태그 | 내용 | 시각], 저장은 '칸 이름  값'
import type { CallActionKind } from './callDto'
import { fmtClock } from '@/shared/lib/format'

const GRID = 'grid grid-cols-[72px_minmax(0,1fr)_40px] gap-x-3'

const clock = (sec?: number | null) => (sec == null ? '' : fmtClock(sec))

/** 말 한 줄 */
export function Talk({
  ai,
  text,
  time,
  on = false,
  marked = false,
  onClick,
  dataKey,
}: {
  ai: boolean
  text: string
  time: string
  on?: boolean // 지금 듣는 말
  marked?: boolean // FAQ · 미답변에서 찾아온 말 (잠깐)
  onClick?: () => void // 이 말부터 듣기
  dataKey?: number
}) {
  const cls = `${GRID} w-full rounded-md px-3 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ops-route ${on ? 'bg-ops-route-soft' : marked ? 'bg-ops-wait-soft' : onClick ? 'hover:bg-ops-paper' : ''}`
  const inner = (
    <>
      <span
        className={`pt-px text-[12px] leading-6 font-semibold ${ai ? 'text-ops-route' : 'text-ops-ink'}`}
      >
        {ai ? 'AI 상담가' : '고객'}
      </span>
      <span className="text-[14px] leading-6 whitespace-pre-wrap">{text}</span>
      <span className="pt-px text-right text-[11px] leading-6 text-ops-faint tabular-nums">
        {time}
      </span>
    </>
  )
  return onClick ? (
    <button
      type="button"
      data-key={dataKey}
      onClick={onClick}
      title="이 말부터 듣기"
      className={cls}
    >
      {inner}
    </button>
  ) : (
    <div data-key={dataKey} className={cls}>
      {inner}
    </div>
  )
}

export interface AiStep {
  key: string | number
  kind: CallActionKind
  text: string
  atSec?: number | null // 통화 안 시각
  active?: boolean // 지금 듣는 말이 부른 동작
  onClick?: () => void // 그 말로 가서 듣기
}

const KIND: Record<CallActionKind, string> = {
  FIELD_SAVED: '저장',
  ADDRESS_SEARCH: '주소 검색',
  PIN_SEARCH: '주소록',
  PREVIOUS_ORDER_SEARCH: '주문 조회',
  ORDER_LOOKUP: '주문 조회',
  CUSTOMER_LOOKUP: '고객 조회',
  FAQ_SEARCH: 'FAQ 검색',
  ORDER_SUBMITTED: '접수 전송',
  ORDER_CANCELLED: '주문 취소',
}

/** '주소 검색 '독막로 301' → 1건' → 종류 말은 태그에 있으니 뺌. '보내는 분 이름 = 이서연' → [칸, 값] */
function body(kind: CallActionKind, text: string) {
  const label = KIND[kind]
  const rest = text.startsWith(label) ? text.slice(label.length).trim() || text : text
  const [field, value] = rest.split(' = ')
  return value === undefined ? { field: null, value: rest } : { field, value }
}

/** 연달아 나온 AI 동작 묶음 */
export function AiSteps({ steps }: { steps: AiStep[] }) {
  if (steps.length === 0) return null
  return (
    <ul aria-label="AI 동작" className="shrink-0 py-0.5">
      {steps.map((s) => {
        const b = body(s.kind, s.text)
        const inner = (
          <>
            <span />
            <span className="flex min-w-0 items-baseline gap-2 border-l-2 border-ops-line py-1 pl-3">
              <span className="shrink-0 rounded bg-ops-idle-soft px-1.5 text-[11px] leading-[18px] font-medium text-ops-sub">
                {KIND[s.kind]}
              </span>
              <span className="min-w-0 text-[13px] leading-5 text-ops-ink/90">
                {b.field && <span className="mr-1.5 text-ops-sub">{b.field}</span>}
                <span className="font-medium break-words">{b.value}</span>
              </span>
            </span>
            <span className="text-right text-[11px] leading-7 text-ops-faint tabular-nums">
              {clock(s.atSec)}
            </span>
          </>
        )
        const cls = `${GRID} w-full px-3 text-left outline-none ${s.active ? '[&>span:nth-child(2)]:border-ops-route [&>span:nth-child(2)]:bg-ops-route-soft' : ''}`
        return (
          <li key={s.key}>
            {s.onClick ? (
              <button
                type="button"
                onClick={s.onClick}
                title="이 동작을 부른 말부터 듣기"
                className={`${cls} focus-visible:ring-2 focus-visible:ring-ops-route focus-visible:ring-inset hover:[&>span:nth-child(2)]:bg-ops-paper`}
              >
                {inner}
              </button>
            ) : (
              <div className={cls}>{inner}</div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** AI 동작 줄 켜고 끄기 스위치 */
export function AiToggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className="inline-flex h-8 shrink-0 items-center gap-2 rounded-md px-2 text-[13px] font-medium text-ops-sub outline-none hover:bg-ops-paper hover:text-ops-ink focus-visible:ring-2 focus-visible:ring-ops-route"
    >
      <span
        aria-hidden
        className={`relative block h-4 w-7 shrink-0 rounded-full transition-colors ${on ? 'bg-ops-route' : 'bg-ops-line'}`}
      >
        <span
          className={`absolute top-0.5 left-0.5 block size-3 rounded-full bg-white shadow-sm transition-transform ${on ? 'translate-x-3' : 'translate-x-0'}`}
        />
      </span>
      AI 동작
    </button>
  )
}
