import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError } from '@/shared/api/client'
import {
  FAQ_CATEGORIES,
  createFaq,
  deleteFaq,
  faqQueries,
  updateFaq,
  type Faq,
  type FaqCategory,
  type FaqInput,
} from '@/features/faq/api/faqApi'
import {
  convertToFaq,
  unansweredQueries,
  type UnansweredQuestion,
} from '@/features/faq/api/unansweredApi'

/** 09 FAQ 추가 · 수정 창 훅 — 분류 · 질문 · 답변, 공백 검사(명세: 공백만 입력 불가) · 서버 칸별 오류 · 저장
 * 10/30: 수정 창 안 [삭제] (모든 관리자) → 확인 창. AI 미답변에서 열면(from) 질문 = 고객이 한 말 그대로 미리 채움,
 * 추가는 API-27 하나로 (FAQ 생성 + 그 질문 처리됨을 서버가 한 번에) */
export function useFaqForm(faq: Faq | null, onDone: () => void, from?: UnansweredQuestion) {
  const qc = useQueryClient()
  const [category, setCategory] = useState<FaqCategory | ''>(faq?.category ?? '') // 추가는 비워 두고 고르게 (기본값이 쓰레기통이 되지 않게)
  const [question, setQuestion] = useState(faq?.question ?? from?.question ?? '')
  const [answer, setAnswer] = useState(faq?.answer ?? '')
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const mutation = useMutation({
    mutationFn: async () => {
      const input: FaqInput = {
        category: category as FaqCategory,
        question: question.trim(),
        answer: answer.trim(),
      }
      if (!faq) {
        if (from) await convertToFaq(from.unansweredQuestionSeq, input)
        else await createFaq(input)
        return
      }
      const changed =
        input.category !== faq.category ||
        input.question !== faq.question ||
        input.answer !== faq.answer
      if (changed) await updateFaq(faq.faqEntrySeq, input) // 세 칸 다 보냄 (부분 수정 없음). 안 바뀌었으면 요청 없이 닫음
    },
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: faqQueries.all() }),
        from && qc.invalidateQueries({ queryKey: unansweredQueries.all() }),
      ])
      onDone()
    },
    // 없어졌거나(404) 다른 관리자가 먼저 처리한(409 INVALID_STATE) 질문 · FAQ → 목록을 다시 받아 지금 상태로
    onError: (e) => {
      if (e instanceof ApiError && (e.status === 404 || e.code === 'INVALID_STATE')) {
        void qc.invalidateQueries({ queryKey: faqQueries.all() })
        if (from) void qc.invalidateQueries({ queryKey: unansweredQueries.all() })
      }
    },
  })

  const remove = useMutation({
    mutationFn: () => deleteFaq(faq!.faqEntrySeq),
    onSuccess: onDone,
    onSettled: () => qc.invalidateQueries({ queryKey: faqQueries.all() }), // 404(이미 지워짐)여도 목록은 다시 받음
  })

  const err = mutation.error
  // 같은 질문의 FAQ가 이미 있음 (409 DUPLICATE_RESOURCE) → 질문 칸 아래에 서버 문구
  const duplicate = err instanceof ApiError && err.code === 'DUPLICATE_RESOURCE'
  // 칸별 오류 경로는 'question' 또는 'items.0.question' (추가는 items 배열이라)
  const fieldError = (field: keyof FaqInput) =>
    err instanceof ApiError
      ? err.details.find((d) => d.field.replace(/^items\.\d+\./, '') === field)?.reason
      : undefined
  const errorMessage = !err
    ? null
    : duplicate || (err instanceof ApiError && err.details.length)
      ? null // 칸별 오류는 칸 아래에
      : err instanceof ApiError && err.code === 'INVALID_STATE'
        ? '이미 처리된 질문입니다. 목록을 확인해 주세요.'
        : err.message

  return {
    isEdit: faq !== null,
    category,
    categoryOptions: FAQ_CATEGORIES.map((c) => ({ value: c.name, label: c.name })),
    question,
    answer,
    setCategory: (v: string) => setCategory(v as FaqCategory | ''),
    setQuestion,
    setAnswer,
    categoryError: fieldError('category'),
    questionError: duplicate ? err.message : fieldError('question'),
    answerError: fieldError('answer'),
    errorMessage,
    canSubmit:
      category !== '' && question.trim() !== '' && answer.trim() !== '' && !mutation.isPending,
    isSubmitting: mutation.isPending,
    submit: () => mutation.mutate(),

    // 삭제 (수정 창에서만): [삭제] → 확인 창 → [삭제]. [취소]는 수정 창으로 돌아감 (적던 내용 그대로)
    confirmingDelete,
    askDelete: () => {
      remove.reset() // 지난번 실패 문구가 새 확인 창에 먼저 뜨지 않게
      setConfirmingDelete(true)
    },
    cancelDelete: () => setConfirmingDelete(false),
    confirmDelete: () => remove.mutate(),
    isDeleting: remove.isPending,
    deleteError: remove.error?.message ?? null,
    deleteTarget: `“${faq?.question ?? ''}”`,
  }
}
