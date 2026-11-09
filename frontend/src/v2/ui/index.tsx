// v2 운영 콘솔 공통 부품 (11/06 실험) — 기존 shared/ui와 섞지 않음. 색은 global.css의 ops-* 토큰
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { ACTION_BADGE_COLOR, ACTION_BADGE_SIZE } from '@/shared/ui/actionBadge'

export type Tone = 'idle' | 'wait' | 'done' | 'stop' | 'route' | 'cancel'

const TONE: Record<Tone, string> = {
  idle: 'bg-ops-idle-soft text-ops-sub',
  wait: 'bg-ops-wait-soft text-ops-wait',
  done: 'bg-ops-done-soft text-ops-done',
  stop: 'bg-ops-stop-soft text-ops-stop',
  cancel: 'bg-ops-cancel-soft text-ops-cancel',
  route: 'bg-ops-route-soft text-ops-route',
}

/** 상태 뱃지 — 목록 · 상세가 같은 것을 씀 (기업 피드백: 뱃지 색 통일) */
export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex h-[22px] shrink-0 items-center rounded px-1.5 text-[12px] font-medium whitespace-nowrap ${TONE[tone]}`}
    >
      {children}
    </span>
  )
}

const BTN = {
  primary: 'bg-ops-route-soft text-ops-route hover:bg-[#d6e4ff]',
  primaryLime: 'bg-[#eaf5d3] text-[#4d7a1f] hover:bg-[#dcebb4]',
  warning: ACTION_BADGE_COLOR.edit,
  dangerBadge: ACTION_BADGE_COLOR.delete,
  infoBadge: ACTION_BADGE_COLOR.info,
  neutralBadge: ACTION_BADGE_COLOR.neutral,
  plain: 'bg-white text-ops-ink ring-1 ring-ops-line ring-inset hover:bg-ops-paper',
  danger: 'bg-white text-ops-stop ring-1 ring-ops-line ring-inset hover:bg-ops-stop-soft',
  dangerFill: 'bg-ops-stop text-white hover:bg-[#c23030]', // 확인 창의 삭제 · 취소처럼 되돌릴 수 없는 일
  ghost: 'text-ops-sub hover:bg-ops-paper hover:text-ops-ink',
}

/** 버튼 높이 32 (기업 피드백: 버튼이 너무 큼) */
export function Btn({
  kind = 'plain',
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: keyof typeof BTN }) {
  return (
    <button
      type="button"
      {...rest}
      className={`${kind === 'warning' || kind === 'dangerBadge' || kind === 'infoBadge' || kind === 'neutralBadge' ? ACTION_BADGE_SIZE : 'inline-flex h-8 items-center justify-center rounded-md px-3 text-[13px] leading-none font-semibold'} shrink-0 gap-1.5 whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ops-route disabled:pointer-events-none disabled:opacity-40 ${BTN[kind]} ${className}`}
    />
  )
}

/** 시각 칸 머리 — 누르면 최신순 ↔ 오래된 순 (화살표 아래 = 최신이 위) */
export function SortTh({
  label,
  asc,
  onToggle,
  className = '',
}: {
  label: string
  asc: boolean
  onToggle: () => void
  className?: string
}) {
  return (
    <th scope="col" aria-sort={asc ? 'ascending' : 'descending'} className={className}>
      <button
        type="button"
        onClick={onToggle}
        title={asc ? '오래된 순 (누르면 최신순)' : '최신순 (누르면 오래된 순)'}
        className="inline-flex items-center gap-1 rounded outline-none hover:text-ops-route focus-visible:ring-2 focus-visible:ring-ops-route"
      >
        {label}
        <Icon name="chevron" className={`size-3.5 ${asc ? 'rotate-180' : ''}`} />
      </button>
    </th>
  )
}

/** 상태 묶음 고르기 — 옆에 건수 */
export function Segments<T extends string>({
  value,
  items,
  onPick,
  label,
}: {
  value: T
  items: { value: T; label: string; count?: number | null }[]
  onPick: (v: T) => void
  label: string
}) {
  return (
    <div role="tablist" aria-label={label} className="flex flex-wrap items-center gap-1">
      {items.map((it) => {
        const on = it.value === value
        return (
          <button
            key={it.value}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onPick(it.value)}
            className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[13px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ops-route ${on ? 'bg-white text-ops-ink shadow-[0_0_0_1px_var(--color-ops-line)]' : 'text-ops-sub hover:text-ops-ink'}`}
          >
            {it.label}
            {it.count != null && (
              <span className={`tabular-nums ${on ? 'text-ops-sub' : 'text-ops-faint'}`}>
                {it.count.toLocaleString('ko-KR')}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

const PATHS = {
  search: 'm21 21-4.3-4.3M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z',
  x: 'M18 6 6 18M6 6l12 12',
  plus: 'M12 5v14M5 12h14',
  phone:
    'M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2Z',
  box: 'M21 8 12 3 3 8v8l9 5 9-5V8ZM3 8l9 5 9-5M12 13v8',
  home: 'M3 10.5 12 3l9 7.5V21H3V10.5ZM9 21v-6h6v6',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.5 5h13L22 12v7a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-7l3.5-7Z',
  book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5v14ZM4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5',
  users:
    'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  building:
    'M3 21h18M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16M9 7h1M9 11h1M9 15h1M14 7h1M14 11h1M14 15h1',
  bot: 'M12 8V4H8M4 12a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v4a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4v-4ZM9 13v2M15 13v2',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z',
  chart: 'M3 3v18h18M7 16v-4M12 16V8M17 16v-7',
  out: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  arrowLeft: 'M19 12H5M12 19l-7-7 7-7',
  chevron: 'm6 9 6 6 6-6',
  chevrons: 'm11 17-5-5 5-5M18 17l-5-5 5-5', // « (오른쪽은 rotate-180)
  alert:
    'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  pin: 'M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0ZM12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  file: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6ZM14 3v6h6',
  sheet:
    'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6ZM14 3v6h6M9 14.5H7.5v4H9M13 14.5h-1.2a.8.8 0 0 0 0 1.6h.4a.8.8 0 0 1 0 1.6h-1.2M14.5 14.5l1 4 1-4',
  download: 'M12 3v12M7 10l5 5 5-5M4 21h16',
}
export type IconName = keyof typeof PATHS

export function Icon({ name, className = 'size-4' }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`shrink-0 ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={PATHS[name]} />
    </svg>
  )
}

/** 고객 용건 (택배 접수 · 주문 확인 · 접수 취소 · 문의) — 상태가 아니라 회색, 취소만 빨강
 *  max를 주면 그만큼만 보이고 나머지는 '외 N' (목록 칸이 좁을 때). 올리면 한 문장 설명 */
export function Kinds({
  kinds,
  max,
}: {
  kinds: { kind: string; label: string; title?: string }[]
  max?: number
}) {
  const shown = max ? kinds.slice(0, max) : kinds
  const rest = kinds.slice(shown.length)
  return (
    <>
      {shown.map((k) => (
        <span key={k.kind} title={k.title}>
          <Badge tone={k.kind === 'cancel' ? 'stop' : 'idle'}>{k.label}</Badge>
        </span>
      ))}
      {rest.length > 0 && (
        <span
          title={rest.map((k) => k.title ?? k.label).join(' ')}
          className="shrink-0 self-center text-[12px] text-ops-sub"
        >
          외 {rest.length}
        </span>
      )}
    </>
  )
}
