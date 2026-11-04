import { useId, useState, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router'
import { todayYmd } from '@/shared/lib/dateRange'
import { fmtPhone, fmtRowTime } from '@/shared/lib/format'
import { OrderDetailModal } from '@/shared/order/OrderDetailModal'
import { orderNo } from '@/shared/order/labels'
import { Highlight, Overlay } from '@/shared/ui'
import { useDashboardSearch } from '@/features/dashboard/hooks/useDashboardSearch'

// 02 통계 상단바 검색 (Figma '통계' 검색 필드 11/05 · FAQ 검색처럼 누르면 모달, 11/05 사용자)
// 상단바엔 검색칸 모양 버튼(296 × 32 · 선 field), 누르면 위쪽에 검색 창(폭 560 · 뒤 화면 안 어둡게 · 윗줄 잡고 옮김)
// 찾는 것: 주문번호 'DV-10519'(= 주문 번호 5자리, 'DV' 없이 숫자만 쳐도 0으로 시작하지 않으면) → 주문 줄, 누르면 주문 상세 창
//          이름 · 전화번호 → 최근 통화 8건(04와 같은 서버 검색), 누르면 06 통화 상세 · 아래 '모두 보기' = 04 통화 내역에 그 검색
// ↑↓ 줄 고르기 · Enter = 고른 줄, 안 골랐으면 주문번호면 주문 상세 · 아니면 04 검색 · ✕ · Esc · 바깥 클릭 = 닫기
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

const PLACEHOLDER = '주문 번호 · 이름 · 전화번호'

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
        {PLACEHOLDER}
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
  const [active, setActive] = useState(-1)
  const navigate = useNavigate()
  const listId = useId()
  const { typed, orderSeq, order, orderLoading, hits, total, searching } = useDashboardSearch(q)
  const orderFound = orderSeq !== null && !!order
  // 고를 수 있는 줄: [주문(있으면), 통화들]
  const rows = [...(orderFound ? ['order' as const] : []), ...hits.map((h) => h.callSessionSeq)]
  const today = todayYmd()

  const type = (v: string) => {
    setQ(v)
    setActive(-1)
  }
  const openOrder = () => {
    onOrder(orderSeq!)
  }
  const openCall = (id: number) => {
    onClose()
    navigate(`/calls/${id}`)
  }
  const searchCalls = () => {
    onClose()
    navigate(`/calls?${new URLSearchParams({ q: typed })}`)
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
      const row = rows[active]
      if (row === 'order' || (row === undefined && orderFound)) openOrder()
      else if (row !== undefined) openCall(row)
      else searchCalls()
    }
  }
  const rowClass = (i: number) =>
    `flex cursor-pointer items-baseline gap-4 px-6 py-3 ${i === active ? 'bg-bg' : ''}`

  return (
    <Overlay
      label="주문 · 통화 검색"
      onClose={onClose}
      top
      dim={false}
      movable
      boxClass="w-[min(560px,calc(100vw-160px))] overflow-hidden ring-1 ring-line"
    >
      <label
        data-drag
        className="flex h-14 shrink-0 cursor-move items-center gap-4 border-b border-line pr-4 pl-6"
      >
        <SearchIcon className="size-5 text-sub" />
        <input
          value={q}
          onChange={(e) => type(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={PLACEHOLDER}
          role="combobox"
          aria-label="주문 번호 · 이름 · 전화번호 검색"
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
        {typed ? (
          <ul id={listId} role="listbox" aria-label="검색 결과">
            {orderSeq !== null &&
              (orderFound ? (
                <li
                  id={`${listId}-0`}
                  role="option"
                  aria-selected={active === 0}
                  onMouseEnter={() => setActive(0)}
                  onClick={openOrder}
                  className={rowClass(0)}
                >
                  <span className="w-24 shrink-0 text-label text-sub">주문</span>
                  <span className="shrink-0 text-body font-semibold">{orderNo(orderSeq)}</span>
                  <span className="min-w-0 truncate text-label text-sub">
                    {order!.sender.name} → {order!.receiver.name}
                  </span>
                </li>
              ) : (
                <li className="px-6 py-3 text-label text-muted">
                  {orderLoading
                    ? `${orderNo(orderSeq)} 찾는 중…`
                    : `주문 ${orderNo(orderSeq)}은 없습니다.`}
                </li>
              ))}
            {hits.map((h, j) => {
              const i = j + (orderFound ? 1 : 0)
              return (
                <li
                  key={h.callSessionSeq}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => openCall(h.callSessionSeq)}
                  className={rowClass(i)}
                >
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
                </li>
              )
            })}
            {!hits.length && orderSeq === null && (
              <li className="px-6 py-6 text-body text-sub">
                {searching ? '찾는 중…' : '맞는 통화가 없습니다.'}
              </li>
            )}
          </ul>
        ) : (
          <p className="px-6 py-6 text-body break-keep text-sub">
            주문번호(예: DV-10519)로 주문을, 이름이나 전화번호로 통화를 찾아요.
          </p>
        )}
      </div>

      {typed && orderSeq === null && hits.length > 0 && (
        <button
          type="button"
          onClick={searchCalls}
          className="flex h-12 shrink-0 items-center justify-between border-t border-line px-6 text-label text-sub hover:bg-bg"
        >
          <span>
            “{typed}” 통화 {total}건 모두 보기
          </span>
          <kbd className="font-sans text-caption text-muted">Enter</kbd>
        </button>
      )}
    </Overlay>
  )
}
