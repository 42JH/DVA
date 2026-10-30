import {
  Button,
  ConfirmDialog,
  Pagination,
  SearchBox,
  Table,
  TwoLines,
  type Column,
} from '@/shared/ui'
import { useUnansweredList, type UnansweredRow } from '@/features/faq/hooks/useUnansweredList'
import { FaqFormModal } from './FaqFormModal'

// 09 AI 미답변 (와이어프레임 09_AI미답변 · _FAQ추가 · _삭제확인, 10/30) — 탭 줄 없음, 맨 윗줄 = 검색
// 카드 'AI 미답변 질문 n개' · 오래된 순 · 줄 = 통화 시작 시각 | 고객 · 발신번호 | “질문”(고객 말 그대로) | [FAQ 추가] [삭제]
// 줄을 누르면 그 통화의 06 통화 상세 (줄 끝 › 없음)
export function UnansweredPage() {
  const vm = useUnansweredList()

  const columns: Column<UnansweredRow>[] = [
    {
      key: 'time',
      header: '통화 시작 시각',
      width: 168,
      // 올해면 한 줄, 다른 해면 날짜 위 · 시각 아래 (연도 규칙 10/30)
      cell: (r) => (
        <div className="text-body text-sub">
          {r.time.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      ),
    },
    {
      key: 'customer',
      header: '고객 · 발신번호',
      width: 200,
      cell: (r) => <TwoLines top={r.customerName} bottom={r.phone} />,
    },
    {
      key: 'question',
      header: '질문',
      cell: (r) => <p className="truncate text-body">“{r.question}”</p>,
    },
    {
      key: 'actions',
      header: '',
      width: 196,
      align: 'right',
      cell: (r) => (
        // 줄 클릭(06으로 이동)과 분리
        <div className="flex justify-end gap-2" onClick={(e) => e.stopPropagation()}>
          <Button small onClick={() => vm.openAdd(r)}>
            FAQ 추가
          </Button>
          <Button small kind="dangerLine" onClick={() => vm.openDelete(r)}>
            삭제
          </Button>
        </div>
      ),
    },
  ]

  return (
    <div className="flex flex-col gap-6">
      <SearchBox value={vm.q} onChange={vm.setQ} placeholder="질문 · 이름 · 전화번호" />

      <Table
        head={
          <h2 className="flex items-baseline gap-3.5 text-card font-bold">
            AI 미답변 질문
            <span className="text-label font-normal text-sub">{vm.count}개</span>
          </h2>
        }
        columns={columns}
        rows={vm.rows}
        rowKey={(r) => r.unansweredQuestionSeq}
        onRowClick={vm.openCall}
        loading={vm.isLoading}
        empty={
          vm.listError ??
          (vm.q ? '해당하는 질문이 없습니다.' : 'AI가 답하지 못한 질문이 없습니다.')
        }
        footer={<Pagination page={vm.page} pages={vm.pages} onChange={vm.goPage} />}
      />

      {vm.modal?.kind === 'add' && (
        <FaqFormModal
          key={vm.modal.item.unansweredQuestionSeq}
          faq={null}
          from={vm.modal.item}
          onClose={vm.closeModal}
        />
      )}
      {vm.modal?.kind === 'delete' && (
        <ConfirmDialog
          title="정말로 삭제하시겠습니까?"
          target={`“${vm.modal.item.question}”`}
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
