import type { ReactNode } from 'react'
import { COL, Button, ConfirmDialog, Table, TwoLines, type Column } from '@/shared/ui'
import type { UnansweredRow, useUnansweredList } from '@/features/faq/hooks/useUnansweredList'
import { FaqFormModal } from './FaqFormModal'

// AI 미답변 질문 표 + [FAQ 추가] · [삭제] 창 — 09 AI 미답변 화면과 01 홈 미리보기가 같이 씀
// 줄 = 통화 시작 시각 | 고객 · 발신번호 | “질문”(고객 말 그대로) | [FAQ 추가] [삭제]. 줄을 누르면 그 통화의 06 통화 상세
export function UnansweredTable({
  vm,
  head,
  empty,
  footer,
}: {
  vm: ReturnType<typeof useUnansweredList>
  head: ReactNode
  empty: string
  footer?: ReactNode
}) {
  const columns: Column<UnansweredRow>[] = [
    {
      key: 'time',
      header: '통화 시작 시각',
      width: COL.time,
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
      width: 160,
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
    <>
      <Table
        head={head}
        columns={columns}
        rows={vm.rows}
        rowKey={(r) => r.unansweredQuestionSeq}
        onRowClick={vm.openCall}
        loading={vm.isLoading}
        empty={vm.listError ?? empty}
        footer={footer}
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
    </>
  )
}
