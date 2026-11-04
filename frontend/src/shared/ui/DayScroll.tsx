import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router'
import { fmtLongDay } from '@/shared/lib/format'
import type { DayFeed } from '@/shared/lib/useDayFeed'

// 날짜별 무한 목록의 줄 상자 (04 통화 · 03 주문, Figma 11/04) — 데이터는 shared/lib/useDayFeed
// 끝에 닿으면 그 방향 날을 더 받고, 위에 붙을 땐 보던 줄이 제자리에 있게 스크롤을 보정. 목록만 스크롤(머리는 고정)
// row: data-row(줄 키) · data-day(그 줄의 날)를 단 요소를 key와 함께 돌려줌. 맨 위에 보이는 줄이 바뀌면 onTop(그 요소) — 머리 날짜 등
// 조건(주소 쿼리)이 바뀌면 새로 그림(맨 위부터). 상세에 갔다 오면 보던 자리 그대로 (받아 둔 목록 + 스크롤 위치)
// 높이는 본문에 딱 맞춤: flex-1(기준 0%)은 높이를 모르는 부모 안에서 내용만큼 커져 목록 대신 본문이 스크롤됨 → 기준 0px(flex-[1_1_0px])
const scrollMemo = new Map<string, number>() // 주소(경로 + 조건)별 스크롤 위치

interface Props<R> {
  feed: DayFeed<R>
  row: (r: R) => ReactNode
  onTop: (row: HTMLElement) => void
  end: (hasRows: boolean) => string // 목록 끝 문구 ('이전 통화가 없습니다.' · '맞는 통화가 없습니다.')
  at?: number | null // 처음 그릴 때 이 줄(data-row)을 맨 위로
  className: string // 줄 자리 맞춤 (안쪽 여백)
}

export function DayScroll<R>(props: Props<R>) {
  const { pathname, search } = useLocation()
  return <Rows key={pathname + search} memoKey={pathname + search} {...props} />
}

function Rows<R>({
  feed,
  row,
  onTop,
  end,
  at,
  className,
  memoKey,
}: Props<R> & { memoKey: string }) {
  const box = useRef<HTMLDivElement>(null)
  const top = useRef<HTMLDivElement>(null)
  const bottom = useRef<HTMLDivElement>(null)
  const anchor = useRef<{ key: string; top: number } | null>(null) // 맨 위에 보이는 줄과 그 위치
  const frame = useRef(0)
  const [edge, setEdge] = useState({ top: false, bottom: false })
  const loaded = feed.days.length > 0 // 첫 쪽(고른 날)을 받음 — 비어 있어도
  const hasRows = feed.days.some((d) => d.rows.length > 0)

  // 맨 위에 보이는 줄 → 머리(onTop) · 보정 기준 · 돌아올 자리
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
    onTop(hit)
    scrollMemo.set(memoKey, el.scrollTop)
  }, [memoKey, onTop])

  // 처음 그릴 때: 상세에서 돌아왔으면 보던 자리로, 옮겨 왔으면(at) 그 줄이 맨 위로
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

  // 위에 줄이 붙으면(다음 날 · 새 건) 보던 줄이 제자리에 있게. 단 맨 위에서 가장 최신을 보는 중이면 새 건이 위에 보이게 둠
  useLayoutEffect(() => {
    const el = box.current
    const a = anchor.current
    if (!el || !a || (el.scrollTop <= 0 && !feed.hasNewer)) return
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

  const { hasNewer, hasOlder, loadingNewer, loadingOlder, newerError, olderError, busy } = feed
  useEffect(() => {
    // 다음 날은 보던 줄(anchor)이 생긴 뒤에 — 그 전에 위에 붙이면 고른 날 대신 최신 날이 맨 위가 됨
    // 고른 날 · 그 전에 건이 하나도 없을 때만 바로 다음 날들로 (가장 가까운 날이 맨 위)
    const canNewer = !!anchor.current || !hasOlder
    if (loaded && edge.top && hasNewer && canNewer && !loadingNewer && !newerError && !busy)
      feed.loadNewer()
  }, [loaded, edge.top, hasNewer, hasOlder, loadingNewer, newerError, busy, feed.days.length]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (loaded && edge.bottom && hasOlder && !loadingOlder && !olderError && !busy) feed.loadOlder()
  }, [loaded, edge.bottom, hasOlder, loadingOlder, olderError, busy, feed.days.length]) // eslint-disable-line react-hooks/exhaustive-deps

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
      // 스크롤 막대는 카드 오른쪽 끝(디자인) — 본문 오른쪽 여백(32)까지 넓힘. 줄 자리는 className(안쪽 여백)으로
      // 막대 자리는 늘 비워 둠(gutter) — 줄이 적어 막대가 없을 때도 줄 끝이 머리 줄과 같은 선
      // 보정은 직접 하므로 브라우저 고정(overflow-anchor)은 끔
      className={`-mr-8 min-h-0 flex-[1_1_0px] [scrollbar-width:thin] [scrollbar-color:var(--color-line)_transparent] [scrollbar-gutter:stable] overflow-y-auto transition-opacity [overflow-anchor:none] ${feed.stale ? 'opacity-50' : ''} ${className}`}
    >
      <div ref={top} aria-hidden className="h-px" />
      {loadingNewer && <p className={note}>불러오는 중…</p>}
      {newerError && retry(feed.loadNewer)}
      {feed.isLoading && <p className={note}>불러오는 중…</p>}
      {feed.error && <p className={note}>{feed.error}</p>}
      {feed.notice && <p className="py-2 text-center text-label text-muted">{feed.notice}</p>}
      {/* 건이 없는 날(조건에 안 맞는 날 포함)은 문구 없이 건너뜀 (11/04 사용자) */}
      {feed.days.map(
        ({ day, rows }) =>
          rows.length > 0 && (
            <section key={day} aria-label={fmtLongDay(day)}>
              {rows.map(row)}
            </section>
          ),
      )}
      <div ref={bottom} aria-hidden className="h-px" />
      {loadingOlder && <p className={note}>불러오는 중…</p>}
      {olderError && retry(feed.loadOlder)}
      {loaded && !hasOlder && (
        <>
          <p className={note}>{end(hasRows)}</p>
          {/* 끝까지 내렸을 때 마지막 줄이 바닥에 붙지 않게 여유 (11/04 사용자) */}
          <div aria-hidden className="h-40" />
        </>
      )}
    </div>
  )
}
