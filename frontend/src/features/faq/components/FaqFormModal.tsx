import { Button, ConfirmDialog, FormModal, SelectField, TextArea, TextField } from '@/shared/ui'
import { useFaqForm } from '@/features/faq/hooks/useFaqForm'
import type { Faq } from '@/features/faq/hooks/useFaqList'
import type { UnansweredQuestion } from '@/features/faq/hooks/useUnansweredList'

// 09 FAQ 추가 · FAQ 수정 창 (와이어프레임 09_FAQ관리_FAQ추가 · _FAQ수정 · _삭제확인, 10/30) — 폭 680 · 분류 셀렉트 · 질문 · 답변 · [취소] [추가/저장]
// 수정 창은 왼쪽 아래 [삭제](빨간 테두리, 모든 관리자) → 확인 창 '정말로 삭제하시겠습니까?' “질문”
// AI 미답변에서 열면(from) 질문 칸 = 고객이 한 말 그대로 → 관리자가 다듬음. 분류 · 답변은 비어 있음
export function FaqFormModal({
  faq,
  from,
  onClose,
}: {
  faq: Faq | null
  from?: UnansweredQuestion
  onClose: () => void
}) {
  const vm = useFaqForm(faq, onClose, from)

  if (vm.confirmingDelete)
    return (
      <ConfirmDialog
        title="정말로 삭제하시겠습니까?"
        target={vm.deleteTarget}
        warn={vm.deleteError ?? undefined}
        okLabel="삭제"
        pending={vm.isDeleting}
        onOk={vm.confirmDelete}
        onClose={vm.cancelDelete}
      />
    )

  return (
    <FormModal
      title={vm.isEdit ? 'FAQ 수정' : 'FAQ 추가'}
      width={680}
      onClose={onClose}
      footer={
        <>
          {vm.isEdit && (
            <Button kind="dangerLine" className="mr-auto" onClick={vm.askDelete}>
              삭제
            </Button>
          )}
          <Button onClick={onClose}>취소</Button>
          <Button kind="primary" disabled={!vm.canSubmit} onClick={vm.submit}>
            {vm.isEdit ? '저장' : '추가'}
          </Button>
        </>
      }
    >
      <div className="grid gap-5">
        <SelectField
          label="분류"
          value={vm.category}
          onChange={vm.setCategory}
          options={vm.categoryOptions}
          placeholder="분류를 고르세요"
          error={vm.categoryError}
        />
        <TextField
          label="질문"
          maxLength={1000}
          value={vm.question}
          onChange={(e) => vm.setQuestion(e.target.value)}
          placeholder="오늘 접수하면 오늘 수거해 가나요?"
          error={vm.questionError}
        />
        <TextArea
          label="답변"
          maxLength={20000}
          value={vm.answer}
          onChange={(e) => vm.setAnswer(e.target.value)}
          placeholder="오전에 접수하시면 당일 수거하고, 오후에 접수하시면 다음 영업일에 수거합니다."
          error={vm.answerError}
        />
        {vm.errorMessage && (
          <p role="alert" className="text-label font-semibold text-danger">
            {vm.errorMessage}
          </p>
        )}
      </div>
    </FormModal>
  )
}
