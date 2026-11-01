import {
  Button,
  ConfirmDialog,
  DateField,
  Pagination,
  SearchBox,
  Table,
  Tabs,
  Tag,
  type Column,
} from '@/shared/ui'
import { OrderDetailModal } from '@/shared/order/OrderDetailModal'
import { useOrderList, type OrderListRow } from '@/features/order/hooks/useOrderList'
import { OrderEditModal } from './OrderEditModal'
import { OrderFormModal } from './OrderFormModal'
import { OrderPartyCell } from './OrderPartyCell'

// 03 주문 내역 (와이어프레임 03_주문내역, 10/31)
// 상태 탭(맨 위, 11/01) → 검색(이름 · 전화번호 · 주소) + 날짜 칸 + [CSV 내보내기] [주문 추가] → 카드 '주문 목록 n건'
// 줄 = 배송 상세 하나(보내는 분 1 + 받는 분 1, 11/01): 상태 | 접수 시각 | 보내는 분 | 받는 분 | 수거 희망 일시 | 품목
// 줄을 누르면 주문 상세 창 (shared/order 공용 — 06 '주문 보기'와 같은 창). 접수 중 · 취소도 열림 (11/01)
// 상세 [수정] → 주문 수정 창(주문 추가와 같은 창, 값 채움) → 저장 · 취소하면 그 주문 상세로
export function OrderListPage() {
  const vm = useOrderList()

  // 값이 없으면(접수 중) 흐린 '—'
  const orDash = (text: string | null) =>
    text ? (
      <span className="text-body">{text}</span>
    ) : (
      <span className="text-body text-muted">—</span>
    )

  const columns: Column<OrderListRow>[] = [
    {
      key: 'status',
      header: '상태',
      width: 112,
      cell: (r) => <Tag kind={r.statusTag}>{r.statusLabel}</Tag>,
    },
    {
      key: 'receivedAt',
      header: '접수 시각',
      width: 120,
      cell: (r) => (
        <div className="text-body text-sub">
          {r.receivedAt.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      ),
    },
    {
      key: 'sender',
      header: '보내는 분',
      width: 281,
      cell: (r) => <OrderPartyCell party={r.sender} />,
    },
    {
      key: 'receiver',
      header: '받는 분',
      width: 281,
      cell: (r) => <OrderPartyCell party={r.receiver} />,
    },
    {
      key: 'pickupAt',
      header: '수거 희망 일시',
      width: 120,
      cell: (r) => orDash(r.pickupAt),
    },
    { key: 'items', header: '품목', cell: (r) => orDash(r.items) },
  ]

  return (
    <div className="flex flex-col gap-4">
      {/* 상태 탭 — 04 통화 내역 · 09 FAQ처럼 맨 위 밑줄 탭 (11/01, 칩 버튼에서 바꿈) */}
      <Tabs
        items={vm.statusOptions.map((o) => ({ key: o.value, label: o.label }))}
        value={vm.status}
        onChange={vm.setStatus}
      />
      {/* 목록 맨 윗줄: 검색 + 날짜 칸 + 버튼 2개 (04 · 09와 같은 틀, 높이 48) */}
      <div className="flex items-center gap-3">
        <SearchBox
          value={vm.q}
          onChange={vm.setQ}
          placeholder="이름 · 전화번호 · 주소"
          className="min-w-0 flex-1"
        />
        <DateField value={vm.range} onChange={vm.setRange} />
        <Button
          tall
          className="ml-3"
          disabled={!vm.canExport || vm.exporting}
          onClick={vm.exportCsv}
        >
          {vm.exporting ? '내보내는 중…' : 'CSV 내보내기'}
        </Button>
        <Button tall kind="primary" onClick={vm.openAdd}>
          주문 추가
        </Button>
      </div>

      {vm.notice && (
        <p role="status" className="text-label text-action">
          {vm.notice}
        </p>
      )}

      <Table
        head={
          <h2 className="flex items-baseline gap-3.5 text-card font-bold">
            주문 목록
            <span className="text-label font-normal text-sub">
              {vm.count.toLocaleString('ko-KR')}건
            </span>
          </h2>
        }
        columns={columns}
        rows={vm.rows}
        rowKey={(r) => r.key}
        onRowClick={vm.openOrder}
        loading={vm.isLoading}
        empty={vm.listError ?? (vm.q ? '해당하는 주문이 없습니다.' : '주문 내역이 없습니다.')}
        footer={<Pagination page={vm.page} pages={vm.pages} onChange={vm.goPage} />}
      />

      {vm.modal?.kind === 'cancel' && (
        <ConfirmDialog
          title="주문을 취소하시겠습니까?"
          target={`주문 ${vm.modal.id}번`}
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
          title="디버에 다시 접수할까요?"
          target={`주문 ${vm.modal.id}번`}
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
          onClose={vm.backToDetail}
        />
      )}
    </div>
  )
}
