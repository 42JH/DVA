import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { todayYmd } from '@/shared/lib/dateRange'
import { fmtPhone, fmtRowTime } from '@/shared/lib/format'
import { OrderDetailModal } from '@/shared/order/OrderDetailModal'
import { orderNo } from '@/shared/order/labels'
import { Highlight, Overlay } from '@/shared/ui'
import { SEARCH_PLACEHOLDER } from '@/shared/ui/TopSearch'
import { useDashboardSearch, type SearchTab } from '@/features/dashboard/hooks/useDashboardSearch'

// 02 통계 상단바 검색 (Figma '통계' 검색 필드 11/05 · FAQ 검색처럼 누르면 모달, 11/05 사용자)
// 상단바엔 검색칸 모양 버튼(296 × 32 · 선 field), 누르면 위쪽에 검색 창(폭 560 · 뒤 화면 안 어둡게 · 윗줄 잡고 옮김)
// 11/05 사용자: 창 위 탭으로 대상을 골라 검색 [통화 | 주문 | FAQ] (기본 통화). 탭을 바꿔도 검색어는 그대로
//   통화 = 이름 · 전화번호 → 최근 통화 8건(04와 같은 서버 검색), 누르면 06 · '모두 보기' = 04 통화 내역에 그 검색
//   주문 = 주문번호 'DV-10519'(숫자만 쳐도, 0으로 시작하지 않으면)면 그 주문, 아니면 이름 · 전화번호 → 최근 주문 8건. 누르면 주문 상세 창
//          '모두 보기' 없음 — 03 검색칸은 보내는 분 · 받는 분이 따로라 한 칸 검색어를 그대로 못 넘김
//   FAQ = 질문 · 답변 낱말(띄어쓰기 무시 · 초성) → 최근 만든 것부터 8건, 누르면 FAQ 상세 · '모두 보기' = 09 FAQ 목록에 그 검색
// ↑↓ 줄 고르기 · Enter = 고른 줄, 안 골랐으면 '모두 보기'(주문은 첫 줄) · ✕ · Esc · 바깥 클릭 = 닫기
// 최근 검색어는 안 남김 — 이름 · 전화번호는 개인정보 (04 통화 검색과 같은 규칙, shared/lib/recentSearches)

const SearchIcon = ({ className }: { className: string }) => (
  <svg
    viewBox="-0.58 -0.58 16 16"
    className={`shrink-0 ${className}`}
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    aria-hidden
  >
    <circle cx="6.08" cy="6.08" r="5.33" />
    <path d="M10.08 10.08l4 4" />
  </svg>
)

const XIcon = ({ className }: { className: string }) => (
  <svg viewBox="0 0 20 20" className={`stroke-current ${className}`} strokeWidth={1.8} aria-hidden>
    <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
  </svg>
)

const TABS: { key: SearchTab; label: string; placeholder: string; hint: string }[] = [
  {
    key: 'call',
    label: '통화',
    placeholder: '이름 · 전화번호',
    hint: '고객 이름이나 전화번호로 통화를 찾아요.',
  },
  {
    key: 'order',
    label: '주문',
    placeholder: '주문 번호 · 이름 · 전화번호',
    hint: '주문번호(예: DV-10519)나 보내는 분 · 받는 분의 이름 · 전화번호로 주문을 찾아요.',
  },
  {
    key: 'faq',
    label: 'FAQ',
    placeholder: '질문 · 답변 낱말',
    hint: '질문 · 답변의 낱말로 찾아요. 띄어쓰기는 무시하고, 초성으로도 찾을 수 있어요. (예: ㅅㄱ → 수거)',
  },
]

/** 검색 결과 한 줄 — 누르면 open */
type Row = { key: string; open: () => void; cells: ReactNode }

/** 상단바 검색칸 자리 — 누르면 검색 창. 주문을 고르면 창을 닫고 주문 상세 창 */
export function DashboardSearch() {
  const [open, setOpen] = useState(false)
  const [orderId, setOrderId] = useState<number | null>(null)
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className="flex h-8 w-[296px] items-center gap-6 justify-self-center rounded-lg border border-field bg-surface pr-6 pl-5 text-left text-body text-field hover:bg-bg"
      >
        <SearchIcon className="size-4" />
        {SEARCH_PLACEHOLDER}
      </button>
      {open && (
        <SearchModal
          onClose={() => setOpen(false)}
          onOrder={(id) => {
            setOpen(false)
            setOrderId(id)
          }}
        />
      )}
      {orderId !== null && <OrderDetailModal orderId={orderId} onClose={() => setOrderId(null)} />}
    </>
  )
}

function SearchModal({ onClose, onOrder }: { onClose: () => void; onOrder: (id: number) => void }) {
  const [q, setQ] = useState('')
  const [tab, setTab] = useState<SearchTab>('call')
  const [active, setActive] = useState(-1)
  const input = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()
  const listId = useId()
  const s = useDashboardSearch(q, tab)
  const { typed } = s
  const today = todayYmd()
  const meta = TABS.find((t) => t.key === tab)!
  const qs = new URLSearchParams({ q: typed }).toString()

  const go = (to: string) => {
    onClose()
    navigate(to)
  }
  const orderRow = (orderSeq: number, who: string, at?: string): Row => ({
    key: `o${orderSeq}`,
    open: () => onOrder(orderSeq),
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
  const rows: Row[] =
    tab === 'call'
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
        : s.faqs.map((f) => ({
            key: `f${f.faqEntrySeq}`,
            open: () => go(`/faqs/${f.faqEntrySeq}?${qs}`),
            cells: (
              <>
                <span className="w-24 shrink-0 text-label text-sub">{f.category}</span>
                <span className="min-w-0 truncate text-body">
                  <Highlight text={f.question} q={typed} />
                </span>
              </>
            ),
          }))
  // '모두 보기' — 그 화면 목록에 같은 검색 (주문은 없음: 위 주석)
  const all =
    !rows.length || tab === 'order'
      ? null
      : tab === 'call'
        ? { label: `통화 ${s.callTotal}건`, to: `/calls?${qs}` }
        : { label: `FAQ ${s.faqTotal}건`, to: `/faqs?${qs}` }
  const empty =
    s.orderSeq !== null
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
    } else if (e.key === 'Enter' && typed) {
      e.preventDefault()
      const row = rows[active] ?? (all ? null : rows[0])
      if (row) row.open()
      else if (all) go(all.to)
    }
  }

  return (
    <Overlay
      label="통화 · 주문 · FAQ 검색"
      onClose={onClose}
      top
      dim={false}
      movable
      boxClass="w-[min(560px,calc(100vw-160px))] overflow-hidden ring-1 ring-line"
    >
      {/* 탭 줄 = 잡고 끄는 곳 (탭 글자 말고 빈 곳) */}
      <div
        data-drag
        role="tablist"
        aria-label="검색 대상"
        className="flex h-12 shrink-0 cursor-move items-end gap-6 border-b border-line px-6"
      >
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={t.key === tab}
            onClick={() => pick(t.key)}
            className={`-mb-px h-10 cursor-pointer border-b-2 px-1 text-body ${
              t.key === tab
                ? 'border-brand font-semibold text-brand'
                : 'border-transparent text-sub hover:text-ink'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <label className="flex h-14 shrink-0 items-center gap-4 border-b border-line pr-4 pl-6">
        <SearchIcon className="size-5 text-sub" />
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
          className="min-w-0 flex-1 bg-transparent text-strong outline-none placeholder:text-muted"
        />
        <button
          type="button"
          aria-label="닫기"
          onClick={onClose}
          className="grid size-8 shrink-0 place-items-center rounded-lg text-sub hover:bg-bg hover:text-ink"
        >
          <XIcon className="size-5" />
        </button>
      </label>

      <div className="min-h-0 [scrollbar-width:thin] overflow-y-auto py-2">
        {!typed ? (
          <p className="px-6 py-6 text-body break-keep text-sub">{meta.hint}</p>
        ) : rows.length ? (
          <ul id={listId} role="listbox" aria-label="검색 결과">
            {rows.map((r, i) => (
              <li
                key={r.key}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={r.open}
                className={`flex cursor-pointer items-baseline gap-4 px-6 py-3 ${i === active ? 'bg-bg' : ''}`}
              >
                {r.cells}
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-6 py-6 text-body text-sub">{empty}</p>
        )}
      </div>

      {typed && all && (
        <button
          type="button"
          onClick={() => go(all.to)}
          className="flex h-12 shrink-0 items-center justify-between border-t border-line px-6 text-label text-sub hover:bg-bg"
        >
          <span>
            “{typed}” {all.label} 모두 보기
          </span>
          <kbd className="font-sans text-caption text-muted">Enter</kbd>
        </button>
      )}
    </Overlay>
  )
}
