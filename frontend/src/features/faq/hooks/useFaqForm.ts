import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError } from '@/shared/api/client'
import {
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

/** 09 FAQ 인라인 추가 · 수정 (Figma 'FAQ 등록' · 'FAQ 수정' 11/06 — 목록 줄 안에서 질문 · 답변만, 분류 고르기 없음)
 * 분류: 수정 = 그 FAQ 분류 그대로 · 추가 = 왼쪽에서 고른 분류(글을 쓰다 분류를 바꿔도 따라감). 공백만 입력 불가 · 서버 칸별 오류 · 저장
 * AI 미답변 [+]로 연 추가(from)는 질문 = 고객이 한 말 그대로 미리 채움, 저장은 API-27 하나로 (FAQ 생성 + 그 질문 처리됨을 서버가 한 번에) */
export function useFaqForm({
  faq = null,
  from,
  category: picked,
  onSaved,
}: {
  faq?: Faq | null
  from?: UnansweredQuestion
  category?: FaqCategory // 추가할 때 넣을 분류
  onSaved: (category: FaqCategory) => void // 저장(추가 · 수정)에 성공하면 그 분류
}) {
  const qc = useQueryClient()
  const category = faq?.category ?? picked
  const [question, setQuestion] = useState(faq?.question ?? from?.question ?? '')
  const [answer, setAnswer] = useState(faq?.answer ?? '')

  const mutation = useMutation({
    mutationFn: async () => {
      const input: FaqInput = {
        category: category!,
        question: question.trim(),
        answer: answer.trim(),
      }
      if (!faq) {
        if (from) await convertToFaq(from.unansweredQuestionSeq, input)
        else await createFaq(input)
        return
      }
      const changed = input.question !== faq.question || input.answer !== faq.answer
      if (changed) await updateFaq(faq.faqEntrySeq, input) // 세 칸 다 보냄 (부분 수정 없음). 안 바뀌었으면 요청 없이 닫음
    },
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: faqQueries.all() }),
        from && qc.invalidateQueries({ queryKey: unansweredQueries.all() }),
      ])
      onSaved(category!)
    },
    // 없어졌거나(404) 다른 관리자가 먼저 처리한(409 INVALID_STATE) 질문 · FAQ → 목록을 다시 받아 지금 상태로
    onError: (e) => {
      if (e instanceof ApiError && (e.status === 404 || e.code === 'INVALID_STATE')) {
        void qc.invalidateQueries({ queryKey: faqQueries.all() })
        if (from) void qc.invalidateQueries({ queryKey: unansweredQueries.all() })
      }
    },
  })

  const err = mutation.error
  // 같은 질문의 FAQ가 이미 있음 (409 DUPLICATE_RESOURCE) → 서버 문구 그대로
  const duplicate = err instanceof ApiError && err.code === 'DUPLICATE_RESOURCE'
  // 칸별 오류 경로는 'question' 또는 'items.0.question' (추가는 items 배열이라)
  const fieldError = (field: keyof FaqInput) =>
    err instanceof ApiError
      ? err.details.find((d) => d.field.replace(/^items\.\d+\./, '') === field)?.reason
      : undefined
  const error = !err
    ? null
    : duplicate
      ? err.message
      : (fieldError('question') ??
        fieldError('answer') ??
        fieldError('category') ??
        (err instanceof ApiError && err.code === 'INVALID_STATE'
          ? '이미 처리된 질문입니다. 목록을 확인해 주세요.'
          : err.message))

  return {
    question,
    answer,
    setQuestion,
    setAnswer,
    error, // 한 줄 — 저장 · 취소 왼쪽
    canSubmit: !!category && question.trim() !== '' && answer.trim() !== '' && !mutation.isPending,
    submit: () => mutation.mutate(),
  }
}

/** FAQ 삭제 — 펼친 줄의 휴지통 → 확인 창 → [삭제]. 404(이미 지워짐)여도 목록은 다시 받음 */
export function useFaqDelete(faq: Faq, onDeleted: () => void) {
  const qc = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const remove = useMutation({
    mutationFn: () => deleteFaq(faq.faqEntrySeq),
    onSuccess: onDeleted,
    onSettled: () => qc.invalidateQueries({ queryKey: faqQueries.all() }),
  })
  return {
    confirming,
    ask: () => {
      remove.reset() // 지난번 실패 문구가 새 확인 창에 먼저 뜨지 않게
      setConfirming(true)
    },
    cancel: () => setConfirming(false),
    confirm: () => remove.mutate(),
    pending: remove.isPending,
    error: remove.error?.message ?? null,
    target: `“${faq.question}”`,
  }
}
