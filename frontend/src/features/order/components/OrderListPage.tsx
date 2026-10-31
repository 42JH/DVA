import {
  Button,
  ChipGroup,
  DateField,
  Pagination,
  SearchBox,
  Table,
  Tag,
  type Column,
} from '@/shared/ui'
import { useOrderList, type OrderListRow } from '@/features/order/hooks/useOrderList'
import { OrderPartyCell } from './OrderPartyCell'

// 03 주문 내역 (와이어프레임 03_주문내역, 10/31)
// 1줄 검색(이름 · 전화번호 · 주소) + 날짜 칸 + [CSV 내보내기] [CSV로 추가] [주문 추가] → 2줄 상태 칩 → 카드 '주문 목록 n건'
// 줄 = 상태 | 접수 시각 | 보내는 분 | 받는 분 | 수거 희망 일시 | 품목
// shortcut: 주문 상세(줄 클릭) · 주문 추가 · CSV로 추가는 다음 작업 — 지금은 버튼만 자리를 잡고 비활성
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
      {/* 목록 맨 윗줄: 검색 + 날짜 칸 + 버튼 3개 (04 · 09와 같은 틀, 높이 48) */}
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
        <Button tall disabled>
          CSV로 추가
        </Button>
        <Button tall kind="primary" disabled>
          주문 추가
        </Button>
      </div>

      <ChipGroup name="상태" options={vm.statusOptions} value={vm.status} onChange={vm.setStatus} />

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
        rowKey={(r) => r.orderSeq}
        loading={vm.isLoading}
        empty={vm.listError ?? (vm.q ? '해당하는 주문이 없습니다.' : '주문 내역이 없습니다.')}
        footer={<Pagination page={vm.page} pages={vm.pages} onChange={vm.goPage} />}
      />
    </div>
  )
}
