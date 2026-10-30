import { Button, Pagination, SearchBox, Table, Tabs, Tag, type Column } from '@/shared/ui'
import { useFaqList, type CategoryFilter, type FaqRow } from '@/features/faq/hooks/useFaqList'
import { FaqFormModal } from './FaqFormModal'

// 09 FAQ 목록 (와이어프레임 09_FAQ관리, 10/30) — 분류 밑줄 탭(전체 + 10) → 검색칸 + [FAQ 추가] → 카드(FAQ 목록 n개)
// 줄 = 번호 · (전체 보기면 분류 태그) 질문 · [수정]. 줄을 누르면 아래로 답변 띠 (줄 끝 꺽쇠 없음)
// 체크박스 · [삭제] 없음 — 삭제는 [수정] 창 안에서, 모든 관리자 (10/30)
export function FaqPage() {
  const vm = useFaqList()

  const columns: Column<FaqRow>[] = [
    { key: 'no', header: '번호', width: 80, cell: (r) => <span className="text-sub">{r.no}</span> },
    {
      key: 'question',
      header: '질문',
      cell: (r) => (
        <span className="flex min-w-0 items-center gap-2.5">
          {/* 전체 보기에서만 분류 태그 (고른 분류 안에선 뻔하니 생략) */}
          {vm.category === '전체' && <Tag kind="gray">{r.category}</Tag>}
          <span
            className={`truncate text-body group-hover:text-action ${vm.openId === r.faqEntrySeq ? 'font-semibold' : ''}`}
          >
            {r.question}
          </span>
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

  // 분류 탭: 건수는 카드 제목('FAQ 목록 3개')에 — 탭에 숫자까지 붙이면 11개가 한 줄에 안 들어감
  const tabs: { key: CategoryFilter; label: string }[] = [
    { key: '전체', label: '전체' },
    ...vm.categories.map((c) => ({ key: c, label: c })),
  ]

  return (
    <div className="flex flex-col gap-6">
      <Tabs items={tabs} value={vm.category} onChange={vm.setCategory} />

      {/* 목록 맨 윗줄: 검색칸(버튼 앞까지) + [FAQ 추가] 48 — 08 · 04와 같은 틀 */}
      <div className="flex gap-6">
        <SearchBox
          value={vm.q}
          onChange={vm.setQ}
          placeholder="질문 · 답변 검색"
          className="min-w-0 flex-1"
        />
        <Button kind="primary" tall onClick={vm.openAdd}>
          FAQ 추가
        </Button>
      </div>

      <Table
        head={
          <h2 className="flex items-baseline gap-3.5 text-card font-bold">
            FAQ 목록
            <span className="text-label font-normal text-sub">{vm.count}개</span>
          </h2>
        }
        columns={columns}
        rows={vm.rows}
        rowKey={(r) => r.faqEntrySeq}
        onRowClick={(r) => vm.toggleOpen(r.faqEntrySeq)}
        expanded={(r) => vm.openId === r.faqEntrySeq}
        subRows={(r, { gridCols }) =>
          vm.openId === r.faqEntrySeq ? (
            // 펼친 줄과 같은 좌우(16 나옴) · 아래만 둥글게 → 줄 + 띠가 한 덩어리. 라벨은 첫 줄 기준선에
            <div className="-mx-4 rounded-b-lg bg-bg px-4 pt-1 pb-[22px]">
              <div className="grid items-baseline" style={{ gridTemplateColumns: gridCols }}>
                <span className="text-label font-semibold text-sub">답변</span>
                <p className="pr-4 text-body whitespace-pre-wrap">{r.answer}</p>
              </div>
            </div>
          ) : null
        }
        loading={vm.isLoading}
        empty={
          vm.listError ??
          (vm.q || vm.category !== '전체' ? '해당하는 FAQ가 없습니다.' : 'FAQ가 없습니다.')
        }
        footer={<Pagination page={vm.page} pages={vm.pages} onChange={vm.goPage} />}
      />

      {vm.modal && (
        <FaqFormModal
          key={vm.modal.kind === 'edit' ? vm.modal.faq.faqEntrySeq : 'add'} // 대상이 바뀌면 폼을 새로
          faq={vm.modal.kind === 'edit' ? vm.modal.faq : null}
          onClose={vm.closeModal}
        />
      )}
    </div>
  )
}
