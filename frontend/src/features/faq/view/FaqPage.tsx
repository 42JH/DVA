import {
  Button,
  ConfirmDialog,
  PageHeader,
  Pagination,
  SearchBox,
  Table,
  type Column,
} from '../../../shared/ui'
import { useFaqListViewModel, type FaqRow } from '../viewmodel/useFaqListViewModel'
import { FaqFormModal } from './FaqFormModal'

// 09 FAQ 관리 (와이어프레임 09_FAQ관리) — 검색칸 → 카드(FAQ 목록 · [삭제] [질의 추가]) → 번호 · 질문 · [수정] ▾ → 펼치면 회색 띠에 답변
export function FaqPage() {
  const vm = useFaqListViewModel()

  const columns: Column<FaqRow>[] = [
    { key: 'no', header: '번호', width: 80, cell: (r) => <span className="text-sub">{r.no}</span> },
    {
      key: 'question',
      header: '질문',
      cell: (r) => (
        <span
          className={`truncate text-body group-hover:text-action ${vm.openId === r.faqEntrySeq ? 'font-semibold' : ''}`}
        >
          {r.question}
        </span>
      ),
    },
    {
      key: 'edit',
      header: '',
      width: 96,
      align: 'right',
      cell: (r) => (
        <Button
          small
          onClick={(e) => {
            e.stopPropagation() // 줄 클릭(펼침)과 분리
            vm.openEdit(r)
          }}
        >
          수정
        </Button>
      ),
    },
  ]

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="FAQ 관리" />

      <SearchBox value={vm.q} onChange={vm.setQ} placeholder="질문 · 답변 검색" />

      <Table
        head={
          <>
            <h2 className="flex items-baseline gap-3.5 text-card font-bold">
              FAQ 목록
              <span className="text-label font-normal text-sub">{vm.count}개</span>
            </h2>
            <div className="flex gap-3">
              <Button kind="dangerLine" disabled={vm.selected.size === 0} onClick={vm.openDelete}>
                삭제
              </Button>
              <Button kind="primary" onClick={vm.openAdd}>
                질의 추가
              </Button>
            </div>
          </>
        }
        columns={columns}
        rows={vm.rows}
        rowKey={(r) => r.faqEntrySeq}
        onRowClick={(r) => vm.toggleOpen(r.faqEntrySeq)}
        expanded={(r) => vm.openId === r.faqEntrySeq}
        selectable
        selected={vm.selected}
        onSelect={vm.toggleSelect}
        onSelectAll={vm.toggleSelectAll}
        subRows={(r, { gridCols }) =>
          vm.openId === r.faqEntrySeq ? (
            // 펼친 줄과 같은 좌우(16 나옴) · 아래만 둥글게 → 줄 + 띠가 한 덩어리. 라벨은 첫 줄 기준선에
            <div className="-mx-4 rounded-b-lg bg-bg px-4 pt-1 pb-[22px]">
              <div className="grid items-baseline" style={{ gridTemplateColumns: gridCols }}>
                <span />
                <span className="text-label font-semibold text-sub">답변</span>
                <p className="pr-4 text-body whitespace-pre-wrap">{r.answer}</p>
              </div>
            </div>
          ) : null
        }
        loading={vm.isLoading}
        empty={vm.listError ?? (vm.q ? '검색 결과가 없습니다.' : 'FAQ가 없습니다.')}
        footer={<Pagination page={vm.page} pages={vm.pages} onChange={vm.goPage} />}
      />

      {(vm.modal?.kind === 'add' || vm.modal?.kind === 'edit') && (
        <FaqFormModal
          key={vm.modal.kind === 'edit' ? vm.modal.faq.faqEntrySeq : 'add'} // 대상이 바뀌면 폼을 새로
          faq={vm.modal.kind === 'edit' ? vm.modal.faq : null}
          onClose={vm.closeModal}
        />
      )}
      {vm.modal?.kind === 'delete' && (
        <ConfirmDialog
          title="정말로 삭제하시겠습니까?"
          target={`선택한 FAQ ${vm.selected.size}개`}
          warn={vm.deleteError ?? undefined}
          okLabel="삭제"
          pending={vm.isDeleting}
          onOk={vm.confirmDelete}
          onClose={vm.closeModal}
        />
      )}
    </div>
  )
}
