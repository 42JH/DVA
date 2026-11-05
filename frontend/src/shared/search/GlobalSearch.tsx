import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { todayYmd } from '@/shared/lib/dateRange'
import { fmtPhone, fmtRowTime } from '@/shared/lib/format'
import {
  clearRecentViews,
  forgetView,
  useRecentViews,
  type RecentView,
} from '@/shared/lib/recentViews'
import { matchKo, memberMatches, parseOrderNo } from '@/shared/lib/search'
import { OrderDetailModal } from '@/shared/order/OrderDetailModal'
import { orderNo } from '@/shared/order/labels'
import { useOrderDetail } from '@/shared/order/useOrderDetail'
import { Highlight } from '@/shared/ui/Highlight'
import { Overlay } from '@/shared/ui/Modal'
import { MenuIcon } from '@/shared/ui/Sidebar'
import { searchQueries, type FaqHit } from './searchApi'

// 상단바 공용 검색 (11/05 사용자: 모든 화면 상단바 공통 = 상태 · 검색 · 알림. 설정 화면만 검색 없음)
// 상단바엔 검색칸 모양 버튼(폭 317 · 높이 32 · 선 field · 안내 '어떤 정보를 찾고 계신가요?'), 누르면 위쪽에 검색 창
// 창: 맨 위 검색칸 · 가운데 결과(칸이 비면 '최근 조회') · 맨 아래 탭 [통화 | 주문 | FAQ | 기업] 알약 (11/05 사용자 시안)
//   처음 열면 그 화면의 탭(통계 · 그 밖 화면은 주문). 탭을 바꿔도 검색어는 그대로
//   통화 = 이름 · 전화번호 → 최근 8건, 누르면 06 통화 상세
//   주문 = 주문번호 'DV-10519'(숫자만 쳐도, 0으로 시작하지 않으면)면 그 주문, 아니면 이름 · 전화번호 · 주소 → 최근 8건. 누르면 주문 상세 창
//   FAQ = 질문 · 답변 낱말(띄어쓰기 무시 · 초성) → 최근 만든 것부터 8건, 누르면 FAQ 상세
//   기업 = 기업명(띄어쓰기 무시 · 초성) → 8곳, 누르면 기업 상세
// Enter · '모두 보기' = 그 탭 목록에 검색 — 지금 화면의 탭이면 이 화면 목록에(onApply), 아니면 그 목록 화면으로 이동(?q=)
// ↑↓ 줄 고르기 · Enter = 고른 줄 · ✕ · Esc · 바깥 클릭 = 닫기 · 검색칸 줄 · 탭 줄의 빈 곳을 잡고 끌어 옮김
// 최근 검색어는 없앰(11/05) → '최근 조회': 그 탭에서 최근 연 상세 7개(아이콘 · 이름), 누르면 바로 그 상세 (shared/lib/recentViews)

export type SearchTab = 'call' | 'order' | 'faq' | 'company'

export interface SearchProps {
  tab: SearchTab // 처음 열 때 고른 탭 = 이 화면의 탭
  q?: string // 이 화면 목록에 적용된 검색어 (상단바 칸에 보이고 ✕로 지움)
  onApply?: (q: string) => void // 이 화면 탭의 Enter · 모두 보기 · ✕ — 없으면 목록 화면으로 이동
  onOrder?: (orderSeq: number) => void // 주문 줄을 누르면 — 없으면 보기 전용 주문 상세 창 (03은 수정 · 취소가 되는 자기 창)
}

const SEARCH_PLACEHOLDER = '어떤 정보를 찾고 계신가요?'

const TABS: { key: SearchTab; label: string; list: string; placeholder: string }[] = [
  {
    key: 'call',
    label: '통화',
    list: '/calls',
    placeholder: '고객 이름이나 전화번호를 입력해 주세요',
  },
  {
    key: 'order',
    label: '주문',
    list: '/orders',
    placeholder: '주문번호나 고객 정보를 입력해 주세요',
  },
  {
    key: 'faq',
    label: 'FAQ',
    list: '/faqs',
    placeholder: '찾으시는 FAQ를 검색해 주세요',
  },
  {
    key: 'company',
    label: '기업',
    list: '/companies',
    placeholder: '회사명이나 사원 정보를 입력해 주세요',
  },
]

const SHOW = 8
const newest = (a: FaqHit, b: FaqHit) => Date.parse(b.createdAt) - Date.parse(a.createdAt)

const SearchIcon = ({ className }: { className: string }) => (
  <svg
    viewBox="0 0 20 20"
    className={`shrink-0 stroke-field ${className}`}
    fill="none"
    strokeWidth={1.6}
    strokeLinecap="round"
    aria-hidden
  >
    <circle cx="8.5" cy="8.5" r="6" />
    <path d="M13 13l4.5 4.5" />
  </svg>
)

const XIcon = ({ className }: { className: string }) => (
  <svg viewBox="0 0 20 20" className={`stroke-current ${className}`} strokeWidth={1.8} aria-hidden>
    <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
  </svg>
)

/** 최근 조회 줄 앞 아이콘 (11/05 시안) — 통화 = 전화기 · 주문 = 상자 · FAQ = Q · 기업 = 건물 */
function KindIcon({ kind }: { kind: RecentView['kind'] }) {
  if (kind === 'faq') return <span className="w-4 shrink-0 text-center text-body text-sub">Q</span>
  if (kind === 'call')
    return (
      <svg
        viewBox="0 0 24 24"
        className="size-4 shrink-0 text-sub"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M6.84 3H4.2C3.48 3 3 3.6 3 4.32C3.24 12.84 9.96 19.56 18.48 19.8C19.2 19.8 19.8 19.32 19.8 18.6V15.96L15.48 14.04L13.56 16.08C11.19 14.77 9.23 12.81 7.92 10.44L9.96 8.52L6.84 3Z" />
      </svg>
    )
  return <MenuIcon name={kind === 'order' ? 'box' : 'building'} className="size-4 text-sub" />
}

/** 상단바 검색칸 자리 — 누르면 검색 창. 이 화면 목록에 검색 중이면 검색어와 ✕(검색 지우기) */
export function GlobalSearch(props: SearchProps) {
  const [open, setOpen] = useState(false)
  const [orderId, setOrderId] = useState<number | null>(null)
  const text = props.onApply ? (props.q ?? '') : ''
  return (
    <>
      <div className="relative">
        <button
          type="button"
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
          className="flex h-8 w-full items-center gap-6 rounded-lg bg-surface pr-9 pl-5 text-left text-body ring-1 ring-field ring-inset hover:bg-bg"
        >
          <SearchIcon className="size-4" />
          <span className={`truncate ${text ? 'text-ink' : 'text-field'}`}>
            {text || SEARCH_PLACEHOLDER}
          </span>
        </button>
        {text && (
          <button
            type="button"
            aria-label="검색 지우기"
            onClick={() => props.onApply?.('')}
            className="absolute top-1/2 right-2 grid size-6 -translate-y-1/2 place-items-center rounded text-sub hover:bg-bg hover:text-ink"
          >
            <XIcon className="size-4" />
          </button>
        )}
      </div>
      {open && (
        <SearchModal
          {...props}
          initial={text}
          onClose={() => setOpen(false)}
          openOrder={(id) => {
            setOpen(false)
            if (props.onOrder) props.onOrder(id)
            else setOrderId(id)
          }}
        />
      )}
      {orderId !== null && <OrderDetailModal orderId={orderId} onClose={() => setOrderId(null)} />}
    </>
  )
}

/** 고른 탭만 요청. 서버 검색(통화 · 주문)은 0.25초 멈춘 뒤에 (칠 때마다 요청하지 않게) */
function useSearchData(typed: string, tab: SearchTab) {
  const [term, setTerm] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setTerm(typed), 250)
    return () => clearTimeout(t)
  }, [typed])

  const orderSeq = tab === 'order' ? parseOrderNo(typed) : null
  const order = useOrderDetail(orderSeq)
  const calls = useQuery(searchQueries.calls(tab === 'call' ? term : ''))
  const orders = useQuery(searchQueries.orders(tab === 'order' && orderSeq === null ? term : ''))
  const faqs = useQuery(searchQueries.faqs(tab === 'faq'))
  const companies = useQuery(searchQueries.companies(tab === 'company'))
  const members = useQuery(searchQueries.directory(tab === 'company' ? term : ''))
  const faqHits = typed
    ? (faqs.data ?? [])
        .filter((f) => matchKo(f.question, typed) || matchKo(f.answer, typed))
        .sort(newest)
    : []
  const companyHits = typed ? (companies.data ?? []).filter((c) => matchKo(c.name, typed)) : []
  // 사원으로 찾은 기업 — 서버 검색 결과에서 이름 · 전화번호 · 부서가 맞은 사원만 (기업명 · 주소로만 맞은 건 뺌). 실패해도 기업명 줄은 그대로
  const memberHits =
    tab === 'company' && typed !== '' && term !== ''
      ? (members.data?.data ?? []).filter((m) => memberMatches(m, term))
      : []
  const server = tab === 'call' ? calls : orders
  const ready = typed !== '' && term !== ''

  return {
    calls: tab === 'call' && ready ? (calls.data?.data ?? []) : [],
    callTotal: calls.data?.total_count ?? 0,
    orderSeq,
    order: order.order, // 없으면(404 · 받는 중) null
    orderLoading: order.isLoading,
    orders: tab === 'order' && orderSeq === null && ready ? (orders.data?.data ?? []) : [],
    orderTotal: orders.data?.total_count ?? 0,
    faqs: faqHits.slice(0, SHOW),
    faqTotal: faqHits.length,
    companies: companyHits.slice(0, SHOW),
    companyTotal: companyHits.length,
    members: memberHits.slice(0, SHOW),
    searching:
      tab === 'faq'
        ? faqs.isPending
        : tab === 'company'
          ? companies.isPending || term !== typed || members.isFetching
          : term !== typed || server.isFetching,
    error: (tab === 'faq' ? faqs : tab === 'company' ? companies : server).error?.message ?? null,
  }
}

/** 검색 결과 한 줄 — 누르면 open */
type Row = { key: string; open: () => void; cells: ReactNode }

function SearchModal({
  tab: firstTab,
  onApply,
  initial,
  onClose,
  openOrder,
}: SearchProps & {
  initial: string
  onClose: () => void
  openOrder: (orderSeq: number) => void
}) {
  const [q, setQ] = useState(initial)
  const [tab, setTab] = useState<SearchTab>(firstTab)
  const [active, setActive] = useState(-1)
  const input = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()
  const listId = useId()
  const typed = q.trim()
  const s = useSearchData(typed, tab)
  const today = todayYmd()
  const meta = TABS.find((t) => t.key === tab)!
  const recent = useRecentViews(tab)

  const go = (to: string) => {
    onClose()
    navigate(to)
  }
  // 그 탭 목록에 검색 — 이 화면의 탭이면 이 화면 목록에, 아니면 그 목록 화면으로
  const apply = () => {
    if (tab === firstTab && onApply) {
      onApply(typed)
      onClose()
    } else go(typed ? `${meta.list}?${new URLSearchParams({ q: typed })}` : meta.list)
  }
  const orderRow = (orderSeq: number, who: string, at?: string): Row => ({
    key: `o${orderSeq}`,
    open: () => openOrder(orderSeq),
    cells: (
      <>
        <span className="w-24 shrink-0 text-body font-semibold">{orderNo(orderSeq)}</span>
        <span className="min-w-0 truncate text-body">
          <Highlight text={who} q={typed} />
        </span>
        {at && (
          <span className="ml-auto shrink-0 text-label text-sub">{fmtRowTime(at, today)}</span>
        )}
      </>
    ),
  })
  // 최근 조회 한 줄 — 누르면 그 상세 (주문은 상세 창). 오른쪽 ✕ = 이 기록만 지움
  const recentRow = (v: RecentView): Row => ({
    key: `r${v.kind}${v.id}`,
    open: () =>
      v.kind === 'order'
        ? openOrder(v.id)
        : go(
            v.kind === 'call'
              ? `/calls/${v.id}`
              : v.kind === 'faq'
                ? `/faqs/${v.id}`
                : `/companies/${v.id}`,
          ),
    cells: (
      <>
        <KindIcon kind={v.kind} />
        <span className="flex min-w-0 items-center gap-2.5 text-body">
          {v.kind === 'order' && <span className="shrink-0">{orderNo(v.id)}</span>}
          <span className="truncate">{v.label}</span>
          {v.to !== undefined && (
            <>
              <span aria-label="에서" className="shrink-0 font-semibold">
                ≫
              </span>
              <span className="truncate">{v.to}</span>
            </>
          )}
          {v.sub?.map((t) => (
            <span key={t} className="shrink-0 tabular-nums">
              {t}
            </span>
          ))}
        </span>
        <button
          type="button"
          aria-label={`최근 조회 ${v.label} 지우기`}
          onClick={(e) => {
            e.stopPropagation() // 줄(상세로 이동)까지 번지지 않게
            forgetView(v.kind, v.id)
            setActive(-1)
          }}
          className="ml-auto grid size-7 shrink-0 place-items-center rounded text-muted hover:bg-surface hover:text-ink"
        >
          <XIcon className="size-4" />
        </button>
      </>
    ),
  })
  const rows: Row[] = !typed
    ? recent.map(recentRow)
    : tab === 'call'
      ? s.calls.map((h) => ({
          key: `c${h.callSessionSeq}`,
          open: () => go(`/calls/${h.callSessionSeq}`),
          cells: (
            <>
              <span className="w-24 shrink-0 text-label text-sub">
                {h.startedAt ? fmtRowTime(h.startedAt, today) : '통화'}
              </span>
              <span className="min-w-0 truncate text-body">
                <Highlight text={h.customerName ?? '이름 없음'} q={typed} />
              </span>
              <span className="ml-auto shrink-0 text-label text-sub tabular-nums">
                <Highlight
                  text={h.callerPhoneNumber ? fmtPhone(h.callerPhoneNumber) : ''}
                  q={typed}
                />
              </span>
            </>
          ),
        }))
      : tab === 'order'
        ? s.orderSeq !== null
          ? s.order
            ? [orderRow(s.orderSeq, `${s.order.sender.name} → ${s.order.receiver.name}`)]
            : []
          : s.orders.map((o) =>
              orderRow(
                o.orderSeq,
                `${o.parcels[0]?.origin.name ?? '—'} → ${o.parcels[0]?.destination.name ?? '—'}`,
                o.createdAt,
              ),
            )
        : tab === 'faq'
          ? s.faqs.map((f) => ({
              key: `f${f.faqEntrySeq}`,
              open: () => go(`/faqs/${f.faqEntrySeq}?${new URLSearchParams({ q: typed })}`),
              cells: (
                <>
                  <span className="w-24 shrink-0 text-label text-sub">{f.category}</span>
                  <span className="min-w-0 truncate text-body">
                    <Highlight text={f.question} q={typed} />
                  </span>
                </>
              ),
            }))
          : [
              ...s.companies.map((c) => ({
                key: `g${c.organizationSeq}`,
                open: () => go(`/companies/${c.organizationSeq}`),
                cells: (
                  <>
                    <span className="min-w-0 truncate text-body">
                      <Highlight text={c.name} q={typed} />
                    </span>
                    <span className="ml-auto shrink-0 text-label text-sub">
                      사원 {c.memberCount}명
                    </span>
                  </>
                ),
              })),
              // 사원으로 찾은 기업: 기업명 · 사원 이름 · 전화번호 (최근 조회 기업 줄과 같은 차림)
              ...s.members.map((m): Row => ({
                key: `m${m.membershipSeq}`,
                open: () => go(`/companies/${m.organizationSeq}`),
                cells: (
                  <>
                    <span className="min-w-0 truncate text-body">{m.organizationName}</span>
                    <span className="shrink-0 text-body">
                      <Highlight text={m.addressData.name} q={typed} />
                    </span>
                    {m.departmentName && (
                      <span className="min-w-0 truncate text-label text-sub">
                        <Highlight text={m.departmentName} q={typed} />
                      </span>
                    )}
                    <span className="ml-auto shrink-0 text-label text-sub tabular-nums">
                      {fmtPhone(m.addressData.phoneNumber)}
                    </span>
                  </>
                ),
              })),
            ]
  const total = {
    call: s.callTotal,
    order: s.orderTotal,
    faq: s.faqTotal,
    company: s.companyTotal,
  }[tab]
  // '모두 보기' — 주문번호로 찾은 주문 하나는 목록 검색이 아니라 그 주문
  // 기업 탭은 기업명으로 맞은 게 있을 때만 (08 목록 검색은 기업명만 — 사원으로만 찾았으면 목록엔 안 나옴)
  const all =
    rows.length && s.orderSeq === null && (tab !== 'company' || total > 0)
      ? `${meta.label} ${total}건`
      : null
  const empty = s.error
    ? s.error
    : s.orderSeq !== null
      ? s.orderLoading
        ? `${orderNo(s.orderSeq)} 찾는 중…`
        : `주문 ${orderNo(s.orderSeq)}은 없습니다.`
      : s.searching
        ? '찾는 중…'
        : `맞는 ${meta.label}${tab === 'call' ? '가' : '이'} 없습니다.`

  const type = (v: string) => {
    setQ(v)
    setActive(-1)
  }
  const pick = (t: SearchTab) => {
    setTab(t)
    setActive(-1)
    input.current?.focus() // 탭을 눌러도 바로 이어서 칠 수 있게
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return // 한글 조합을 끝내는 Enter · 방향키
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!rows.length) return
      e.preventDefault()
      const down = e.key === 'ArrowDown' // 끝에서 다시 처음으로 돎
      setActive(down ? (active + 1) % rows.length : active <= 0 ? rows.length - 1 : active - 1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const row = rows[active] ?? (s.orderSeq !== null ? rows[0] : undefined)
      if (row) row.open()
      else apply() // 빈 칸이면 이 화면 검색을 지움 · 목록 화면으로
    }
  }

  return (
    <Overlay
      label="통화 · 주문 · FAQ · 기업 검색"
      onClose={onClose}
      top
      dim={false}
      movable
      boxClass="h-[min(440px,calc(100dvh-120px))] w-[min(560px,calc(100vw-160px))] overflow-hidden ring-1 ring-line"
    >
      {/* 검색칸 줄 = 잡고 끄는 곳 (입력칸 · ✕ 말고) */}
      <label
        data-drag
        className="flex h-14 shrink-0 cursor-move items-center border-b border-line px-6"
      >
        <input
          ref={input}
          autoFocus
          value={q}
          onChange={(e) => type(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={meta.placeholder}
          role="combobox"
          aria-label={`${meta.label} 검색`}
          aria-expanded={rows.length > 0}
          aria-controls={listId}
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
          className="min-w-0 flex-1 bg-transparent text-strong outline-none placeholder:text-field"
        />
      </label>

      {/* 남는 높이를 채우고 안에서 스크롤 — 막대는 숨김(11/05 시안) */}
      <div className="min-h-0 flex-1 [scrollbar-width:none] overflow-y-auto py-2 [&::-webkit-scrollbar]:hidden">
        {!typed && rows.length > 0 && (
          <p className="flex items-center justify-between px-6 pt-2 pb-1 text-label font-medium text-ink">
            최근 조회
            <button
              type="button"
              onClick={() => {
                clearRecentViews(tab) // 이 탭만
                setActive(-1)
              }}
              className="text-caption font-normal text-sub hover:text-ink"
            >
              전체 삭제
            </button>
          </p>
        )}
        {rows.length ? (
          <ul id={listId} role="listbox" aria-label={typed ? '검색 결과' : '최근 조회'}>
            {rows.map((r, i) => (
              <li
                key={r.key}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={r.open}
                className={`flex cursor-pointer gap-4 px-6 ${typed ? 'items-baseline py-3' : 'items-center py-1.5'} ${i === active ? 'bg-bg' : ''}`}
              >
                {r.cells}
              </li>
            ))}
          </ul>
        ) : (
          // 칸이 비고 최근 조회도 없으면 빈 칸 (찾는 법 안내 글은 뺌 — 11/05 사용자)
          typed && <p className="px-6 py-6 text-body break-keep text-sub">{empty}</p>
        )}
      </div>

      {typed && all && (
        <button
          type="button"
          onClick={apply}
          className="flex h-12 shrink-0 items-center justify-between border-t border-line px-6 text-label text-sub hover:bg-bg"
        >
          <span>
            “{typed}” {all} 모두 보기
          </span>
          <kbd className="font-sans text-caption text-muted">Enter</kbd>
        </button>
      )}
      {/* 탭 = 맨 아래 알약 (11/05 사용자 시안). 줄의 빈 곳도 잡고 끄는 곳 */}
      <div
        data-drag
        role="tablist"
        aria-label="검색 대상"
        className="flex h-11 shrink-0 cursor-move items-center gap-1 border-t border-line px-4"
      >
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={t.key === tab}
            onClick={() => pick(t.key)}
            className={`h-7 cursor-pointer rounded-full px-3 text-label ${
              t.key === tab ? 'bg-brand/10 font-semibold text-brand' : 'text-sub hover:text-ink'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
    </Overlay>
  )
}
