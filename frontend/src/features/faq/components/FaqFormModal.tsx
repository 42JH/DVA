import { Button, FormModal, SelectField, TextArea, TextField } from '@/shared/ui'
import { useFaqForm } from '@/features/faq/hooks/useFaqForm'
import type { Faq } from '@/features/faq/hooks/useFaqList'

// 09 질의 추가 · 질의 수정 창 (와이어프레임 09_FAQ관리_질의추가 v2) — 폭 680 · 분류 셀렉트(정의 한 줄) · 질문 44 · 답변 180 · [취소] [추가/저장]
export function FaqFormModal({ faq, onClose }: { faq: Faq | null; onClose: () => void }) {
  const vm = useFaqForm(faq, onClose)
  return (
    <FormModal
      title={vm.isEdit ? '질의 수정' : '질의 추가'}
      width={680}
      onClose={onClose}
      footer={
        <>
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
          value={vm.question}
          onChange={(e) => vm.setQuestion(e.target.value)}
          placeholder="주말에도 방문 수거를 하나요?"
          error={vm.questionError}
          autoFocus={!vm.isEdit && vm.category !== ''}
        />
        <TextArea
          label="답변"
          value={vm.answer}
          onChange={(e) => vm.setAnswer(e.target.value)}
          placeholder="토요일은 오전 9시부터 오후 1시까지 방문 수거를 합니다."
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
