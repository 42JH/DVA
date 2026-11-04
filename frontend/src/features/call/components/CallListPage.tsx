import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router'
import type { Ymd } from '@/shared/lib/dateRange'
import { useDismiss } from '@/shared/lib/useDismiss'
import { ExitGhost } from '@/shared/lib/useExitGhost'
import { DayCalendar, Highlight, TopBar } from '@/shared/ui'
import { useCallList, type CallListRow } from '@/features/call/hooks/useCallList'
import { CallFilter } from './CallFilter'
import { CallSearch } from './CallSearch'

// 04 통화 내역 (Figma 디자인/목업 '통화' 11/04) — 상단바(상태 · AI 미답변 알림) · 머리(📅 날짜 · 상담가 | 필터 · 검색칸) · 줄 목록
// 머리의 날짜 · 상담가는 맨 위 줄을 따라 바뀜. 날짜를 고르면 그 날로, 상담가를 고르면 그 상담가가 받은 가장 최근 통화로 이동
// 검색칸은 창 없이 치는 대로 목록이 바뀜 (11/04 사용자)
// 줄 = 시각 | 상담 유형 칩(접수 · 조회 · 취소 · FAQ, 두 번 이상이면 숫자) · 불만(빨간 알약, 올리면 근거) | 이름(신규면 new) | 전화번호 | 통화 시간
// 무한 스크롤 (11/04 사용자): 고른 날짜(기본 오늘)부터 — 아래로 내리면 지난 날, 위로 올리면 다음 날을 이어 받고, 머리 날짜는 맨 위 줄의 날짜를 따라감
// 목록만 스크롤(머리는 고정) · 줄을 누르면 06. 06에서 돌아오면 보던 자리 그대로 (받아 둔 목록 + 스크롤 위치)
// 높이는 본문에 딱 맞춤: flex-1(기준 0%)은 높이를 모르는 부모 안에서 내용만큼 커져 목록 대신 본문이 스크롤됨 → 기준 0px(flex-[1_1_0px])
const KIND_BG = {
  accept: 'bg-kind-accept',
  lookup: 'bg-kind-lookup',
  cancel: 'bg-kind-cancel',
  faq: 'bg-kind-faq',
} as const
const scrollMemo = new Map<string, number>() // 주소(조건)별 스크롤 위치 — 06 갔다 오면 그 자리로

const dayText = (day: Ymd) =>
  new Date(`${day}T00:00:00+09:00`).toLocaleDateString('ko-KR', {
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  })

export function CallListPage() {
  const vm = useCallList()
  const key = useLocation().search // 조건이 바뀌면 목록을 새로 (맨 위부터)
  // 맨 위에 보이는 줄의 날짜 · 상담가 (11/04 사용자: 둘 다 스크롤 따라 바뀜) — 조건이 바뀌면(key) 고른 날짜로 돌아감
  const [seen, setSeen] = useState<{ key: string; day: Ymd; persona: string | null } | null>(null)
  const now = seen?.key === key ? seen : null
  const day = now?.day ?? vm.anchor
  const persona = now?.persona ?? vm.activePersona // 맨 위 통화의 상담가를 모르면(분석 전) 지금 상담가
  const onTop = useCallback(
    (d: Ymd, p: string | null) => setSeen({ key, day: d, persona: p }),
    [key],
  )

  return (
    <div className="flex min-h-0 flex-[1_1_0px] flex-col">
      <TopBar date={false} className="-ml-4" />
      <div className="mt-2 flex h-[37px] shrink-0 items-center pr-[50px] pl-[58px]">
        <DayPick day={day} onPick={vm.setDate} />
        <PersonaToggle
          label={persona}
          personas={vm.personas}
          onPick={vm.pickPersona}
          jumping={vm.jumping}
          note={vm.jumpNote}
          onOpen={vm.resetJump}
        />
        <div className="ml-auto flex items-center gap-6">
          <CallFilter value={vm.form} active={vm.isFiltered} onApply={vm.applyForm} />
          <CallSearch q={vm.q} onSearch={vm.setQ} />
        </div>
      </div>
      <div className="mt-5 mr-[50px] ml-[58px] shrink-0 border-t border-line" />
      <DayList key={key} memoKey={key} vm={vm} onTop={onTop} />
    </div>
  )
}

/** 줄 목록 — 끝에 닿으면 그 방향 날을 더 받고, 위에 붙을 땐 보던 줄이 제자리에 있게 스크롤을 보정 */
function DayList({
  vm,
  memoKey,
  onTop,
}: {
  vm: ReturnType<typeof useCallList>
  memoKey: string
  onTop: (day: Ymd, persona: string | null) => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const top = useRef<HTMLDivElement>(null)
  const bottom = useRef<HTMLDivElement>(null)
  const anchor = useRef<{ key: string; top: number } | null>(null) // 맨 위에 보이는 줄과 그 위치
  const frame = useRef(0)
  const [edge, setEdge] = useState({ top: false, bottom: false })
  const loaded = vm.days.length > 0 // 첫 쪽(고른 날)을 받음 — 비어 있어도
  const hasRows = vm.days.some((d) => d.rows.length > 0)

  // 맨 위에 보이는 줄 → 머리 날짜 · 상담가 · 보정 기준 · 돌아올 자리
  const measure = useCallback(() => {
    const el = box.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const atTop = (n: Element | null | undefined) => n?.closest<HTMLElement>('[data-row]')
    const hit =
      atTop(document.elementFromPoint(r.left + r.width / 2, r.top + 10)) ??
      [...el.querySelectorAll<HTMLElement>('[data-row]')].find(
        (n) => n.getBoundingClientRect().bottom > r.top,
      )
    if (!hit) return
    anchor.current = { key: hit.dataset.row!, top: hit.getBoundingClientRect().top - r.top }
    // 상담가: 맨 위 줄이 분석 전이면 그 아래 줄들 중 처음 아는 것
    let n: Element | null = hit
    let persona: string | null = null
    while (n && !persona) {
      persona = (n as HTMLElement).dataset.persona ?? null
      n = n.nextElementSibling
    }
    onTop(hit.dataset.day!, persona)
    scrollMemo.set(memoKey, el.scrollTop)
  }, [memoKey, onTop])

  // 처음 그릴 때: 06에서 돌아왔으면 보던 자리로, 상담가를 골라 왔으면(at) 그 통화가 맨 위로
  const at = vm.at
  useLayoutEffect(() => {
    const el = box.current
    if (!hasRows || anchor.current || !el) return
    const saved = scrollMemo.get(memoKey)
    const target = at ? el.querySelector<HTMLElement>(`[data-row="${at}"]`) : null
    if (saved !== undefined) el.scrollTop = saved
    else if (target)
      el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top
    measure()
  }, [hasRows, memoKey, measure, at])

  // 위에 줄이 붙으면(다음 날 · 새 통화) 보던 줄이 제자리에 있게. 단 맨 위에서 가장 최신을 보는 중이면 새 통화가 위에 보이게 둠
  useLayoutEffect(() => {
    const el = box.current
    const a = anchor.current
    if (!el || !a || (el.scrollTop <= 0 && !vm.hasNewer)) return
    const node = el.querySelector<HTMLElement>(`[data-row="${a.key}"]`)
    if (!node) return
    const drift = node.getBoundingClientRect().top - el.getBoundingClientRect().top - a.top
    if (Math.abs(drift) >= 1) el.scrollTop += drift
  })

  // 위 · 아래 끝 감지 (400px 앞에서 미리)
  useEffect(() => {
    const root = box.current
    if (!root) return
    const io = new IntersectionObserver(
      (entries) =>
        setEdge((e) => {
          const n = { ...e }
          for (const en of entries)
            n[en.target === top.current ? 'top' : 'bottom'] = en.isIntersecting
          return n
        }),
      { root, rootMargin: '400px 0px' },
    )
    if (top.current) io.observe(top.current)
    if (bottom.current) io.observe(bottom.current)
    return () => io.disconnect()
  }, [])

  const { hasNewer, hasOlder, loadingNewer, loadingOlder, newerError, olderError, busy } = vm
  useEffect(() => {
    // 다음 날은 보던 줄(anchor)이 생긴 뒤에 — 그 전에 위에 붙이면 고른 날 대신 최신 날이 맨 위가 됨
    // 고른 날 · 그 전에 통화가 하나도 없을 때만 바로 다음 날들로 (가장 가까운 날이 맨 위)
    const canNewer = !!anchor.current || !hasOlder
    if (loaded && edge.top && hasNewer && canNewer && !loadingNewer && !newerError && !busy)
      vm.loadNewer()
  }, [loaded, edge.top, hasNewer, hasOlder, loadingNewer, newerError, busy, vm.days.length]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (loaded && edge.bottom && hasOlder && !loadingOlder && !olderError && !busy) vm.loadOlder()
  }, [loaded, edge.bottom, hasOlder, loadingOlder, olderError, busy, vm.days.length]) // eslint-disable-line react-hooks/exhaustive-deps

  const note = 'py-4 text-center text-body text-muted'
  const retry = (load: () => void) => (
    <p className={note}>
      불러오지 못했습니다.{' '}
      <button type="button" onClick={load} className="font-semibold text-brand hover:underline">
        다시 시도
      </button>
    </p>
  )

  return (
    <div
      ref={box}
      onScroll={() => {
        cancelAnimationFrame(frame.current)
        frame.current = requestAnimationFrame(measure)
      }}
      // 스크롤 막대는 카드 오른쪽 끝(디자인) — 본문 오른쪽 여백(32)까지 넓힘. 오른쪽 72 = 줄 끝이 디자인 1354(크롬 얇은 막대 10 포함)
      // 보정은 직접 하므로 브라우저 고정(overflow-anchor)은 끔
      className={`-mr-8 min-h-0 flex-[1_1_0px] [scrollbar-width:thin] [scrollbar-color:var(--color-line)_transparent] overflow-y-auto pt-1.5 pr-[72px] pl-[58px] transition-opacity [overflow-anchor:none] ${vm.stale ? 'opacity-50' : ''}`}
    >
      <div ref={top} aria-hidden className="h-px" />
      {loadingNewer && <p className={note}>불러오는 중…</p>}
      {newerError && retry(vm.loadNewer)}
      {vm.isLoading && <p className={note}>불러오는 중…</p>}
      {vm.error && <p className={note}>{vm.error}</p>}
      {vm.notice && <p className="py-2 text-center text-label text-muted">{vm.notice}</p>}
      {/* 통화가 없는 날(조건에 안 맞는 날 포함)은 문구 없이 건너뜀 (11/04 사용자) */}
      {vm.days.map(
        ({ day, rows }) =>
          rows.length > 0 && (
            <section key={day} aria-label={dayText(day)}>
              {rows.map((r) => (
                <CallLine key={r.callSessionSeq} r={r} q={vm.q} />
              ))}
            </section>
          ),
      )}
      <div ref={bottom} aria-hidden className="h-px" />
      {loadingOlder && <p className={note}>불러오는 중…</p>}
      {olderError && retry(vm.loadOlder)}
      {loaded && !hasOlder && (
        <>
          <p className={note}>
            {hasRows
              ? '이전 통화가 없습니다.'
              : vm.q || vm.isFiltered
                ? '맞는 통화가 없습니다.'
                : '통화가 없습니다.'}
          </p>
          {/* 끝까지 내렸을 때 마지막 줄이 바닥에 붙지 않게 여유 (11/04 사용자) */}
          <div aria-hidden className="h-40" />
        </>
      )}
    </div>
  )
}

/** 한 줄 (Figma 행 높이 70 · 글자 20) — 줄 전체가 06 링크 */
function CallLine({ r, q }: { r: CallListRow; q: string }) {
  return (
    <Link
      to={`/calls/${r.callSessionSeq}`}
      data-row={r.callSessionSeq}
      data-day={r.day}
      data-persona={r.persona ?? undefined}
      // 칸 = Figma 자리(행 1200 기준): 시각 170 · 칩(남는 폭) · 이름 113 · 번호 171 · 통화 시간 120(오른쪽 맞춤). 칸 폭이 고정이라 줄마다 자리가 같음
      className="grid h-[70px] grid-cols-[170px_minmax(0,1fr)_113px_171px_120px] items-center border-b border-bg pr-[15px] pl-2 text-card hover:bg-bg"
    >
      <span className="text-sub">{r.time}</span>
      <span className="flex min-w-0 items-center gap-2 pr-4">
        {r.counts ? (
          r.kinds.map((k) => (
            <span
              key={k.kind}
              className={`grid h-7 min-w-19 shrink-0 place-items-center px-3 ${KIND_BG[k.kind]}`}
            >
              {k.label}
            </span>
          ))
        ) : (
          <span className="text-body text-muted">분석 전</span>
        )}
        {r.complaint && <Complaint c={r.complaint} />}
      </span>
      <span className="flex min-w-0 items-start font-medium" title={r.name}>
        <span className="truncate">
          <Highlight text={r.name} q={q} />
        </span>
        {r.isNew && <sup className="mt-1 ml-1 text-[12px] font-normal text-brand">new</sup>}
      </span>
      <span className="font-medium tabular-nums">
        <Highlight text={r.phone} q={q} />
      </span>
      <span className="text-right text-sub">{r.duration}</span>
    </Link>
  )
}

/** 불만 알약 — 마우스를 올리면 아래에 고객이 한 말(근거) */
function Complaint({ c }: { c: NonNullable<CallListRow['complaint']> }) {
  return (
    <span className="group/c relative ml-auto shrink-0">
      <span className="inline-flex h-7 items-center rounded-xl bg-danger px-3 text-body font-bold text-white">
        {c.label}
      </span>
      <span
        role="tooltip"
        className="invisible absolute top-full left-0 z-10 mt-2 flex flex-col gap-1 rounded-lg bg-surface py-1 pr-7 pl-3 text-body whitespace-nowrap text-sub shadow-[0_4px_10px_rgba(0,0,0,0.07)] group-hover/c:visible"
      >
        {c.reasons.map((t, i) => (
          <span key={i} className="flex h-6 items-center gap-2">
            <svg
              viewBox="0 0 24 24"
              className="size-6 shrink-0"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M12 10.5V7M12 14h.01M7 18v2.34c0 .53 0 .8.11.94a.5.5 0 0 0 .39.19c.18 0 .38-.17.8-.5l2.39-1.91c.49-.39.73-.58 1-.72.24-.12.5-.21.76-.27.3-.06.61-.06 1.23-.06h2.52c1.68 0 2.52 0 3.16-.33a3 3 0 0 0 1.31-1.31c.33-.64.33-1.48.33-3.16V7.8c0-1.68 0-2.52-.33-3.16a3 3 0 0 0-1.31-1.31C18.72 3 17.88 3 16.2 3H7.8c-1.68 0-2.52 0-3.16.33a3 3 0 0 0-1.31 1.31C3 5.28 3 6.12 3 7.8V14c0 .93 0 1.4.1 1.78a3 3 0 0 0 2.12 2.12c.39.1.85.1 1.78.1Z" />
            </svg>
            {t}
          </span>
        ))}
      </span>
    </span>
  )
}

/** 📅 날짜 — 누르면 아래에 하루 고르기 달력 (고르면 그 날부터) */
function DayPick({ day, onPick }: { day: Ymd; onPick: (d: Ymd) => void }) {
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
        aria-label={`${dayText(day)} — 날짜 고르기`}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-3 text-title font-normal hover:text-brand"
      >
        <svg
          viewBox="0 0 32 32"
          className="size-8 shrink-0"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M28 13.33H4M21.33 2.67V8M10.67 2.67V8M14 18.67l2-1.34V24M14.33 24h3.34M10.4 29.33h11.2c2.24 0 3.36 0 4.22-.43a4 4 0 0 0 1.75-1.75c.43-.86.43-1.98.43-4.22v-11.2c0-2.24 0-3.36-.43-4.22a4 4 0 0 0-1.75-1.75c-.86-.43-1.98-.43-4.22-.43H10.4c-2.24 0-3.36 0-4.22.43a4 4 0 0 0-1.75 1.75C4 8.37 4 9.49 4 11.73v11.2c0 2.24 0 3.36.43 4.22a4 4 0 0 0 1.75 1.75c.86.43 1.98.43 4.22.43Z" />
        </svg>
        {dayText(day)}
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

/** 날짜 옆 상담가 이름 — 맨 위 통화를 받은 상담가(스크롤 따라 바뀜). 누르고 고르면 그 상담가가 받은 가장 최근 통화로 (11/04 사용자) */
function PersonaToggle({
  label,
  personas,
  onPick,
  jumping,
  note,
  onOpen,
}: {
  label: string | null
  personas: { personaSeq: number; name: string; inUse: boolean }[]
  onPick: (personaSeq: number) => void
  jumping: boolean
  note: string | null // 찾지 못함 · 받은 통화 없음
  onOpen: () => void
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(open, root, close)
  return (
    <div ref={root} className="relative mt-[10px] ml-6 flex items-baseline gap-3">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (!open) onOpen()
          setOpen((o) => !o)
        }}
        className="text-body font-semibold hover:text-brand"
      >
        {label ?? '상담가'}
      </button>
      {(jumping || note) && (
        <span className="text-caption text-muted">{jumping ? '찾는 중…' : note}</span>
      )}
      {open && (
        <div
          role="menu"
          aria-label="상담가 — 고르면 그 상담가가 받은 가장 최근 통화로"
          className="absolute top-full left-0 z-20 mt-2 w-max min-w-44 origin-top-left overflow-hidden rounded-xl bg-surface py-1 shadow-[0_12px_12px_rgba(0,0,0,0.08),0_2px_4px_rgba(0,0,0,0.04)] ring-1 ring-line motion-safe:animate-pop-in"
        >
          {personas.map((p) => (
            <button
              key={p.personaSeq}
              type="button"
              role="menuitem"
              onClick={() => {
                onPick(p.personaSeq)
                close()
              }}
              className={`flex h-11 w-full items-center gap-2 px-4 text-left text-body ${p.name === label ? 'font-semibold text-brand' : 'text-ink hover:bg-bg'}`}
            >
              {p.name}
              {p.inUse && <span className="text-caption font-normal text-muted">사용 중</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
