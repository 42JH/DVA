import { Button, ConfirmDialog, Pagination, SearchBox, Table, Tag, type Column } from '@/shared/ui'
import { INACTIVE_TAG } from '@/features/company/labels'
import { useCompanyList, type CompanyRow } from '@/features/company/hooks/useCompanyList'
import { CompanyCsvModal } from './CompanyCsvModal'

// 08 기업관리 목록 (Figma 08_기업관리, 11/01) — 검색 + [삭제] [CSV로 기업 등록] → 표 '기업 목록 24곳'(체크 · 기업명 · 사원 수 · 월결제) → 쪽 번호
// 디자인과 다른 점 (11/01 결정): 월결제 열 · 비활성 태그 추가 (등록일 · 사원 수는 11/01 백엔드 반영으로 서버 값)
export function CompanyListPage() {
  const vm = useCompanyList()

  const columns: Column<CompanyRow>[] = [
    {
      key: 'name',
      header: '기업명',
      width: 320,
      cell: (r) => (
        <span className="flex items-center gap-2 text-body font-semibold">
          {r.name}
          {r.inactive && <Tag>{INACTIVE_TAG}</Tag>}
        </span>
      ),
    },
    {
      key: 'members',
      header: '사원 수',
      width: 160,
      cell: (r) => `${r.members}명`,
    },
    {
      key: 'date',
      header: '등록일',
      width: 160,
      cell: (r) => <span className="text-sub tabular-nums">{r.date}</span>,
    },
    {
      key: 'billing',
      header: '월결제',
      cell: (r) => <span className="text-sub">{r.billing}</span>,
    },
  ]

  return (
    <div className="flex flex-col gap-6">
      <div className="flex gap-3">
        <SearchBox
          value={vm.q}
          onChange={vm.setQ}
          placeholder="기업명 검색"
          className="min-w-0 flex-1"
        />
        <Button tall disabled={vm.selected.size === 0} onClick={vm.askDelete}>
          삭제
        </Button>
        <Button kind="primary" tall onClick={vm.openCsv}>
          CSV로 기업 등록
        </Button>
      </div>

      {(vm.deleteError ?? vm.loadError) && (
        <p role="alert" className="text-label text-danger">
          {vm.deleteError ?? vm.loadError}
        </p>
      )}

      <Table
        head={
          <h2 className="flex items-baseline gap-3.5 text-card font-bold">
            기업 목록
            <span className="text-label font-normal text-sub">{vm.total}곳</span>
          </h2>
        }
        columns={columns}
        rows={vm.rows}
        rowKey={(r) => r.id}
        onRowClick={(r) => vm.open(r.id)}
        selectable
        selected={vm.selected}
        onSelect={(id) => vm.toggle(Number(id))}
        onSelectAll={vm.toggleAll}
        loading={vm.isLoading}
        empty={vm.q ? '검색한 기업이 없습니다.' : '등록된 기업이 없습니다.'}
        footer={<Pagination page={vm.page} pages={vm.pages} onChange={vm.setPage} />}
      />

      {vm.confirming && (
        <ConfirmDialog
          title="기업을 삭제하시겠습니까?"
          target={
            vm.selectedNames.length > 2
              ? `${vm.selectedNames.slice(0, 2).join(', ')} 외 ${vm.selectedNames.length - 2}곳`
              : vm.selectedNames.join(', ')
          }
          warn="삭제하면 사원 소속 · 부서 · 공유 주소록이 함께 지워집니다. 고객 · 주문 기록은 남습니다."
          okLabel="삭제"
          pending={vm.deleting}
          onOk={() => void vm.removeSelected()}
          onClose={vm.cancelDelete}
        />
      )}
      {vm.csvOpen && <CompanyCsvModal onClose={vm.closeCsv} />}
    </div>
  )
}
