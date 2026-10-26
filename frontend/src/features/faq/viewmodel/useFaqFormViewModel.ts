import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError } from '../../../shared/api/client'
import { createFaq, faqKeys, updateFaq, type Faq, type FaqInput } from '../model/faqApi'

/** 09 질의 추가 · 수정 폼 ViewModel — 입력값 · 공백 검사(명세서: question/answer 공백 불가) · 서버 칸별 오류 · 저장 */
export function useFaqFormViewModel(faq: Faq | null, onDone: () => void) {
  const qc = useQueryClient()
  const [question, setQuestion] = useState(faq?.question ?? '')
  const [answer, setAnswer] = useState(faq?.answer ?? '')
  // FAQ-02 멱등키 — 창을 열 때 하나. 본문이 바뀌면 새 키 (같은 키에 다른 본문은 422)
  const [key, setKey] = useState(() => crypto.randomUUID())
  const edit = (set: (v: string) => void) => (v: string) => {
    set(v)
    setKey(crypto.randomUUID())
  }

  const mutation = useMutation({
    mutationFn: async () => {
      const input: FaqInput = { question: question.trim(), answer: answer.trim() }
      if (!faq) return createFaq(input, key)
      const patch: Partial<FaqInput> = {}
      if (input.question !== faq.question) patch.question = input.question
      if (input.answer !== faq.answer) patch.answer = input.answer
      if (Object.keys(patch).length) await updateFaq(faq.faqEntrySeq, patch) // 안 바뀌었으면 요청 없이 닫음
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: faqKeys.all })
      onDone()
    },
  })

  const err = mutation.error
  const fieldError = (field: keyof FaqInput) =>
    err instanceof ApiError ? err.details.find((d) => d.field === field)?.reason : undefined
  const errorMessage = !err
    ? null
    : err instanceof ApiError && err.details.length
      ? null // 칸별 오류는 칸 아래에
      : err instanceof ApiError && err.status === 409
        ? '같은 요청을 처리하는 중입니다. 잠시 뒤 목록을 확인해 주세요.'
        : err.message

  return {
    isEdit: faq !== null,
    question,
    answer,
    setQuestion: edit(setQuestion),
    setAnswer: edit(setAnswer),
    questionError: fieldError('question'),
    answerError: fieldError('answer'),
    errorMessage,
    canSubmit: question.trim() !== '' && answer.trim() !== '' && !mutation.isPending,
    isSubmitting: mutation.isPending,
    submit: () => mutation.mutate(),
  }
}
