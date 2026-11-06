import { useCallback, useRef, useState, type UIEvent } from 'react'
import { useLocation } from 'react-router'
import { fmtMonthDay } from '@/shared/lib/format'
import type { Ymd } from '@/shared/lib/dateRange'
import { Button, ConfirmDialog, DayPick, DayScroll, HeadPick, Highlight, TopBar } from '@/shared/ui'
import { OrderChip } from '@/shared/order/OrderChip'
import { OrderDetailModal } from '@/shared/order/OrderDetailModal'
import { orderNo } from '@/shared/order/labels'
import { useOrderList, type OrderListRow } from '@/features/order/hooks/useOrderList'
import { OrderEditModal } from './OrderEditModal'
import { OrderFormModal } from './OrderFormModal'

// 03 주문 내역 (Figma 디자인/목업 '프레임' 1521:7385, 11/06 새 시안) — 상단바 · 표 머리줄(📅 날짜 | 주문 상태 ⌄ | 보내는 분 | 받는 분 | 주문번호) · 줄 목록 · 아래 오른쪽 [추가]
// 줄(높이 72) = 시각 12 회색 | 작은 상태 칩(테두리 1 · 폭 63) | 보내는 분 '이름  주소' 한 줄 16/500 | 받는 분 | 주문번호 12 회색(오른쪽)
// 날이 바뀌는 첫 줄은 표 왼쪽 바깥에 '11월 3일' (머리줄 날짜 = 맨 위 줄의 날이라, 맨 위 줄이면 안 붙음)
// 칸 = 시안 자리(표 1172 기준): 시각 121 · 상태 140 · 보내는 분 398 · 받는 분 398(넓은 화면에선 둘이 같은 비율로) · 주문번호 115(오른쪽 맞춤)
// 열 머리 '주문 상태 ⌄'를 누르면 상태 고르기(서버 statusGroup). 검색은 상단바 공용 탭 검색(주문 탭이 먼저) 한 칸 — 보내는 분 · 받는 분 둘 다에서 찾고 Enter는 이 목록에 (11/05 사용자)
// 무한 스크롤 · 머리 날짜 = 맨 위 줄의 날 (shared/ui/DayScroll, 04와 같음). 줄을 누르면 주문 상세 창 (shared/order — 06 '주문 보기'와 같은 창)
// 상세 [수정] → 주문 수정 창(주문 추가와 같은 창, 값 채움) → 저장 · 취소하면 그 주문 상세로
// 칸 = Figma 자리(줄 1200 기준): 시각 126 · 상태 186 · 보내는 분 436 · 받는 분 342 · 주문번호 110(가운데). 넓은 화면에선 두 사람 칸이 같은 비율로 늘어남
const COLS = 'grid grid-cols-[121px_140px_minmax(0,398fr)_minmax(0,398fr)_115px]'
// 표 좌우 자리: 카드 왼쪽 100 · 오른쪽 100 (본문 여백 32 빼고 68). 줄 상자는 스크롤 막대 자리 때문에 오른쪽 90
const PAD = 'pr-[68px] pl-[68px]'

export function OrderListPage() {
  const vm = useOrderList()
  const key = useLocation().search // 조건이 바뀌면 머리를 고른 날짜로 (목록도 맨 위부터 새로)
  const [seen, setSeen] = useState<{ key: string; day: Ymd } | null>(null) // 맨 위에 보이는 줄의 날
  const day = (seen?.key === key && seen.day) || vm.anchor
  const onTop = useCallback((row: HTMLElement) => setSeen({ key, day: row.dataset.day! }), [key])
  const fold = useFoldOnScroll()
  // 날마다 첫 줄 — 그 줄 왼쪽에 '11월 3일' (머리줄 날짜와 같은 날이면 안 붙임)
  const firstOfDay = new Set(vm.feed.days.map((d) => d.rows[0]?.key))

  return (
    <div className="flex min-h-0 flex-[1_1_0px] flex-col" onScrollCapture={fold.onScroll}>
      <TopBar search={{ tab: 'order', q: vm.q, onApply: vm.setQ, onOrder: vm.openOrderSeq }} />
      {/* 표 머리줄: 목록을 내리면 위로 접히고 올리면 다시 나옴 (11/05 사용자). 접힌 동안만 잘라 냄 — 펼쳐 있을 땐 날짜 · '주문 상태 ⌄' 창이 아래로 나와야 해서 */}
      <div
        className={`grid shrink-0 transition-[grid-template-rows] duration-200 motion-reduce:transition-none ${fold.folded ? 'grid-rows-[0fr] overflow-hidden' : 'grid-rows-[1fr]'}`}
      >
        <div className="min-h-0" inert={fold.folded}>
          <div className={`${COLS} mt-v44 h-6 items-center ${PAD} text-body font-semibold`}>
            <DayPick small day={day} onPick={vm.setDate} />
            <HeadPick
              label="주문 상태"
              all="ALL"
              value={vm.group}
              options={vm.groups}
              onPick={vm.setGroup}
            />
            <span>보내는 분</span>
            <span>받는 분</span>
            <span className="text-right">주문번호</span>
          </div>
        </div>
      </div>
      <div className="mt-[10px] mr-[68px] ml-[68px] shrink-0 border-t border-sub" />
      {/* 줄 상자: 왼쪽 68 = 머리줄과 같은 선(날이 바뀌는 줄의 '11월 3일'은 그 왼쪽 여백에) · 오른쪽 90 = 68 + 32(막대를 카드 끝으로 뺀 만큼) − 10(막대) */}
      <DayScroll
        feed={vm.feed}
        onTop={onTop}
        row={(r) => (
          <OrderLine key={r.key} r={r} vm={vm} dayLabel={firstOfDay.has(r.key) && r.day !== day} />
        )}
        end={(hasRows) =>
          hasRows
            ? '이전 주문이 없습니다.'
            : vm.isFiltered
              ? '맞는 주문이 없습니다.'
              : '주문이 없습니다.'
        }
        className="pt-[5px] pr-[90px] pl-[68px]"
      />
      {/* 아래 오른쪽 [추가] (11/06 시안) · 취소 · 다시 접수 결과 한 줄은 그 왼쪽 */}
      <div className={`flex shrink-0 items-center justify-end gap-6 pt-3 ${PAD}`}>
        {vm.notice && (
          <p role="status" className="truncate text-label text-sub">
            {vm.notice}
          </p>
        )}
        <Button big kind="brand" onClick={vm.openAdd}>
          추가
        </Button>
      </div>

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

/** 한 줄 (11/06 시안 높이 72) — 누르면 주문 상세 창. dayLabel = 날이 바뀌는 첫 줄이면 표 왼쪽 바깥에 '11월 3일' */
function OrderLine({
  r,
  vm,
  dayLabel,
}: {
  r: OrderListRow
  vm: ReturnType<typeof useOrderList>
  dayLabel: boolean
}) {
  return (
    <button
      type="button"
      data-row={r.key}
      data-day={r.day}
      onClick={() => vm.openOrder(r)}
      className={`${COLS} relative h-[72px] w-full items-center border-b border-line/70 text-left hover:bg-bg`}
    >
      {dayLabel && (
        <span className="absolute top-1/2 -left-15 -translate-y-1/2 text-[12px] font-medium whitespace-nowrap">
          {fmtMonthDay(r.day)}
        </span>
      )}
      <span className="pl-[13px] text-[12px] text-sub">{r.time}</span>
      <span>
        <OrderChip small group={r.group} />
      </span>
      <Party p={r.sender} q={vm.q.trim()} />
      <Party p={r.receiver} q={vm.q.trim()} />
      <span className="text-right text-[12px] tracking-[-0.01em] text-sub">{r.orderNo}</span>
    </button>
  )
}

/** '이름  주소' 한 줄 (사이 20, 글자 16/500). 길면 주소부터 말줄임, 올리면 전체. 검색어와 맞은 자리는 하이라이트 */
function Party({ p, q }: { p: OrderListRow['sender']; q: string }) {
  return (
    <span
      title={[p.name, p.address].filter(Boolean).join(' ')}
      className="flex min-w-0 items-center gap-5 pr-6 text-body font-medium"
    >
      <span className={`shrink-0 ${p.name ? '' : 'text-muted'}`}>
        {p.name ? <Highlight text={p.name} q={q} /> : '—'}
      </span>
      <span className={`min-w-0 truncate ${p.address ? '' : 'text-muted'}`}>
        {p.address ? <Highlight text={p.address} q={q} /> : '—'}
      </span>
    </span>
  )
}

/** 목록을 내리면 접힘 · 올리면(또는 맨 위면) 펼침 — 줄 상자(DayScroll)의 스크롤을 바깥에서 잡음(capture, 스크롤은 위로 안 번져서)
 *  한 번에 크게 뛴 건 무시: 위에 날이 붙을 때 DayScroll이 보던 줄을 제자리에 두려고 scrollTop을 크게 옮김(사람 스크롤 아님) */
function useFoldOnScroll() {
  const [folded, setFolded] = useState(false)
  const last = useRef(0)
  const onScroll = (e: UIEvent) => {
    const y = (e.target as HTMLElement).scrollTop
    const d = y - last.current
    last.current = y
    if (y < 40) setFolded(false)
    else if (Math.abs(d) > 4 && Math.abs(d) < 250) setFolded(d > 0)
  }
  return { folded, onScroll }
}
