import { useCallback, useRef, useState } from 'react'
import { useLocation } from 'react-router'
import type { Ymd } from '@/shared/lib/dateRange'
import { useDismiss } from '@/shared/lib/useDismiss'
import { useLiveSearch } from '@/shared/lib/useLiveSearch'
import { Button, ConfirmDialog, DayPick, DayScroll, Highlight, TopBar } from '@/shared/ui'
import { OrderChip } from '@/shared/order/OrderChip'
import { OrderDetailModal } from '@/shared/order/OrderDetailModal'
import { orderNo } from '@/shared/order/labels'
import type { StatusGroup } from '@/features/order/api/orderApi'
import { useOrderList, type OrderListRow } from '@/features/order/hooks/useOrderList'
import { OrderEditModal } from './OrderEditModal'
import { OrderFormModal } from './OrderFormModal'

// 03 주문 내역 (Figma 디자인/목업 '주문' 11/04) — 04 통화와 같은 틀: 상단바 · 머리(📅 날짜 | [추가]) · 검색칸(보내는 분 ≫ 받는 분) · 열 머리 · 줄 목록
// 줄 = 시각 | 상태 칩(shared/order/OrderChip — 상세 창 머리와 같은 칩) | 보내는 분(이름 · 주소) | 받는 분 | 주문번호
// 열 머리 '주문 상태 ⌄'를 누르면 상태 고르기(서버 statusGroup). 검색칸은 치는 대로 — 보내는 분 칸은 보내는 분에서만, 받는 분 칸은 받는 분에서만 찾음
// 무한 스크롤 · 머리 날짜 = 맨 위 줄의 날 (shared/ui/DayScroll, 04와 같음). 줄을 누르면 주문 상세 창 (shared/order — 06 '주문 보기'와 같은 창)
// 상세 [수정] → 주문 수정 창(주문 추가와 같은 창, 값 채움) → 저장 · 취소하면 그 주문 상세로
// 칸 = Figma 자리(줄 1200 기준): 시각 126 · 상태 186 · 보내는 분 436 · 받는 분 342 · 주문번호 110(가운데). 넓은 화면에선 두 사람 칸이 같은 비율로 늘어남
const COLS = 'grid grid-cols-[126px_186px_minmax(0,436fr)_minmax(0,342fr)_110px]'

export function OrderListPage() {
  const vm = useOrderList()
  const key = useLocation().search // 조건이 바뀌면 머리를 고른 날짜로 (목록도 맨 위부터 새로)
  const [seen, setSeen] = useState<{ key: string; day: Ymd } | null>(null) // 맨 위에 보이는 줄의 날
  const day = (seen?.key === key && seen.day) || vm.anchor
  const onTop = useCallback((row: HTMLElement) => setSeen({ key, day: row.dataset.day! }), [key])

  return (
    <div className="flex min-h-0 flex-[1_1_0px] flex-col">
      <TopBar />
      <div className="mt-2 flex h-[37px] shrink-0 items-center gap-6 pr-[50px] pl-[58px]">
        <DayPick day={day} onPick={vm.setDate} />
        {vm.notice && (
          <p role="status" className="ml-auto truncate text-label text-sub">
            {vm.notice}
          </p>
        )}
        <Button big kind="brand" onClick={vm.openAdd} className={vm.notice ? '' : 'ml-auto'}>
          추가
        </Button>
      </div>
      {/* 검색칸은 그 칸의 사람 열에 맞춤 (테두리가 글자보다 4 왼쪽). ≫는 두 칸 사이 가운데 */}
      <div className={`${COLS} mt-[29px] h-9 shrink-0 pr-[50px] pl-[58px]`}>
        <div className="col-start-3 -ml-1 flex min-w-0 items-center">
          <PartySearch who="보내는 분" q={vm.sender} onSearch={vm.setSender} />
          <svg
            viewBox="0 0 40 40"
            className="mx-auto -my-0.5 size-10 shrink-0 text-brand"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M10 28.33 18.33 20 10 11.67M21.67 28.33 30 20l-8.33-8.33" />
          </svg>
        </div>
        <div className="-ml-1 flex min-w-0">
          <PartySearch who="받는 분" q={vm.receiver} onSearch={vm.setReceiver} />
        </div>
      </div>
      <div
        className={`${COLS} mt-5 h-7 shrink-0 items-center pr-[50px] pl-[58px] text-card font-semibold`}
      >
        <StatusPick value={vm.group} options={vm.groups} onPick={vm.setGroup} />
        <span>보내는 분</span>
        <span>받는 분</span>
        <span className="text-center">주문번호</span>
      </div>
      <div className="mt-5 mr-[50px] ml-[58px] shrink-0 border-t border-line" />
      {/* 왼쪽 58 · 오른쪽 72 = 04 통화와 같은 자리(줄 1200, 끝 1354 — 크롬 얇은 막대 10 포함, 11/04 사용자: 두 화면 날짜 · 목록 위치 맞춤) · 위 3 = 첫 줄 글자 자리 */}
      <DayScroll
        feed={vm.feed}
        onTop={onTop}
        row={(r) => <OrderLine key={r.key} r={r} vm={vm} />}
        end={(hasRows) =>
          hasRows
            ? '이전 주문이 없습니다.'
            : vm.isFiltered
              ? '맞는 주문이 없습니다.'
              : '주문이 없습니다.'
        }
        className="pt-[3px] pr-[72px] pl-[58px]"
      />

      {vm.modal?.kind === 'cancel' && (
        <ConfirmDialog
          big
          title="주문을 취소하시겠습니까?"
          target={`${orderNo(vm.modal.id)} 주문`}
          warn={
            vm.modal.parcelCount > 1
              ? `이 주문의 배송 ${vm.modal.parcelCount}건이 모두 취소됩니다. 결제 전 주문만 취소할 수 있습니다.`
              : '취소하면 되돌릴 수 없습니다. 결제 전 주문만 취소할 수 있습니다.'
          }
          note={vm.actionError ?? undefined}
          okLabel="주문 취소"
          pending={vm.acting}
          onOk={vm.confirmAction}
          onClose={vm.backFromConfirm}
        />
      )}
      {vm.modal?.kind === 'retry' && (
        <ConfirmDialog
          big
          title="디버에 다시 접수할까요?"
          target={`${orderNo(vm.modal.id)} 주문`}
          note={
            vm.actionError ??
            '결제는 다시 하지 않습니다. 디버에 이미 접수됐을 수 있으니, 디버에서 이 주문이 없는지 먼저 확인해 주세요.'
          }
          okLabel="다시 접수"
          okKind="primary"
          pending={vm.acting}
          onOk={vm.confirmAction}
          onClose={vm.backFromConfirm}
        />
      )}
      {vm.modal?.kind === 'add' && (
        <OrderFormModal onDone={vm.closeModal} onClose={vm.closeModal} />
      )}
      {vm.modal?.kind === 'detail' && (
        <OrderDetailModal
          orderId={vm.modal.id}
          parcelSeq={vm.modal.parcelSeq}
          onClose={vm.closeModal}
          onEdit={vm.editOrder}
          onCancel={vm.askCancel}
          onRetry={vm.askRetry}
        />
      )}
      {vm.modal?.kind === 'edit' && (
        <OrderEditModal
          key={vm.modal.id}
          orderId={vm.modal.id}
          parcelSeq={vm.modal.parcelSeq}
          onDone={vm.backToDetail}
          // 인자 없이 — ✕ · [취소]가 넘기는 클릭 이벤트가 안내 문구(notice)로 들어가 화면이 깨졌음 (11/04)
          onClose={() => vm.backToDetail()}
        />
      )}
    </div>
  )
}

/** 한 줄 (Figma 줄 간격 97 · 글자 20) — 누르면 주문 상세 창. 글은 줄 가운데보다 4.5 아래(디자인: 위 25 · 아래 16) */
function OrderLine({ r, vm }: { r: OrderListRow; vm: ReturnType<typeof useOrderList> }) {
  return (
    <button
      type="button"
      data-row={r.key}
      data-day={r.day}
      onClick={() => vm.openOrder(r)}
      className={`${COLS} h-[97px] w-full items-center border-b border-bg pt-[9px] text-left text-card hover:bg-bg`}
    >
      <span className="pl-0.5 text-sub">{r.time}</span>
      <span>
        <OrderChip group={r.group} />
      </span>
      <Party p={r.sender} q={vm.sender.trim()} />
      <Party p={r.receiver} q={vm.receiver.trim()} />
      <span className="text-center">{r.orderNo}</span>
    </button>
  )
}

/** 이름 위 · 주소 아래 (줄 간격 32). 길면 말줄임, 올리면 전체. 검색칸 글과 맞은 자리는 하이라이트 */
function Party({ p, q }: { p: OrderListRow['sender']; q: string }) {
  return (
    <span className="flex min-w-0 flex-col gap-1 pr-6 font-medium">
      {[p.name, p.address].map((t, i) => (
        <span key={i} title={t} className={`truncate ${t ? '' : 'text-muted'}`}>
          {t ? <Highlight text={t} q={q} /> : '—'}
        </span>
      ))}
    </span>
  )
}

/** 보내는 분 · 받는 분 검색칸 (Figma '검색 필드' 11/04 — 320 × 36, 선 1 · 모서리 8). 치는 대로 목록이 바뀜 */
function PartySearch({
  who,
  q,
  onSearch,
}: {
  who: string
  q: string
  onSearch: (q: string) => void
}) {
  const { text, setText, clear, onKeyDown } = useLiveSearch(q, onSearch)
  return (
    <label className="flex h-9 w-[320px] min-w-0 shrink items-center gap-4 rounded-lg border border-field bg-surface pr-2 pl-5 focus-within:border-brand">
      <svg
        viewBox="-0.58 -0.58 16 16"
        className="size-4 shrink-0 text-field"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        aria-hidden
      >
        <circle cx="6.08" cy="6.08" r="5.33" />
        <path d="M10.08 10.08l4 4" />
      </svg>
      <input
        type="search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="이름 · 주소"
        aria-label={`${who} 검색 (이름 · 주소)`}
        className="min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-muted [&::-webkit-search-cancel-button]:hidden"
      />
      {text && (
        <button
          type="button"
          aria-label={`${who} 검색 지우기`}
          onClick={clear}
          className="grid size-6 shrink-0 place-items-center rounded text-sub hover:bg-bg hover:text-ink"
        >
          <svg viewBox="0 0 20 20" className="size-4 stroke-current" strokeWidth={1.8} aria-hidden>
            <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </label>
  )
}

/** 열 머리 '주문 상태 ⌄' — 누르면 상태 고르기. 고르면 머리가 그 상태 이름(파랑)으로 */
function StatusPick({
  value,
  options,
  onPick,
}: {
  value: StatusGroup
  options: { value: StatusGroup; label: string }[]
  onPick: (g: StatusGroup) => void
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(open, root, close)
  const on = value !== 'ALL'
  return (
    <div ref={root} className="relative col-start-2 ml-[7px] justify-self-start">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-1 ${on ? 'text-brand' : 'hover:text-brand'}`}
      >
        {on ? options.find((o) => o.value === value)?.label : '주문 상태'}
        <svg
          viewBox="0 0 24 24"
          className={`size-6 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          aria-label="주문 상태 — 고르면 그 상태만"
          className="absolute top-full left-0 z-20 mt-2 w-max min-w-44 origin-top-left overflow-hidden rounded-xl bg-surface py-1 shadow-[0_12px_12px_rgba(0,0,0,0.08),0_2px_4px_rgba(0,0,0,0.04)] ring-1 ring-line motion-safe:animate-pop-in"
        >
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="menuitemradio"
              aria-checked={o.value === value}
              onClick={() => {
                onPick(o.value)
                close()
              }}
              className={`flex h-11 w-full items-center px-4 text-left text-body ${o.value === value ? 'font-semibold text-brand' : 'font-normal text-ink hover:bg-bg'}`}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
