import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError } from '@/shared/api/client'
import {
  FAQ_CATEGORIES,
  createFaq,
  faqQueries,
  updateFaq,
  type Faq,
  type FaqCategory,
  type FaqInput,
} from '@/features/faq/api/faqApi'

/** 09 질의 추가 · 수정 폼 훅 — 분류 · 질문 · 답변, 공백 검사(명세서: question/answer 공백 불가) · 서버 칸별 오류 · 저장 */
export function useFaqForm(faq: Faq | null, onDone: () => void) {
  const qc = useQueryClient()
  const [category, setCategory] = useState<FaqCategory | ''>(faq?.category ?? '') // 추가는 비워 두고 고르게 (기본값이 쓰레기통이 되지 않게)
  const [question, setQuestion] = useState(faq?.question ?? '')
  const [answer, setAnswer] = useState(faq?.answer ?? '')
  // FAQ-02 멱등키 — 창을 열 때 하나. 본문이 바뀌면 새 키 (같은 키에 다른 본문은 422)
  const [key, setKey] = useState(() => crypto.randomUUID())
  const edit =
    <T>(set: (v: T) => void) =>
    (v: T) => {
      set(v)
      setKey(crypto.randomUUID())
    }

  const mutation = useMutation({
    mutationFn: async () => {
      const input: FaqInput = {
        category: category as FaqCategory,
        question: question.trim(),
        answer: answer.trim(),
      }
      if (!faq) return createFaq(input, key)
      const patch: Partial<FaqInput> = {}
      if (input.category !== faq.category) patch.category = input.category
      if (input.question !== faq.question) patch.question = input.question
      if (input.answer !== faq.answer) patch.answer = input.answer
      if (Object.keys(patch).length) await updateFaq(faq.faqEntrySeq, patch) // 안 바뀌었으면 요청 없이 닫음
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: faqQueries.all() })
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
    category,
    categoryOptions: FAQ_CATEGORIES.map((c) => ({ value: c.name, label: c.name })),
    question,
    answer,
    setCategory: edit((v: string) => setCategory(v as FaqCategory | '')),
    setQuestion: edit(setQuestion),
    setAnswer: edit(setAnswer),
    categoryError: fieldError('category'),
    questionError: fieldError('question'),
    answerError: fieldError('answer'),
    errorMessage,
    canSubmit:
      category !== '' && question.trim() !== '' && answer.trim() !== '' && !mutation.isPending,
    isSubmitting: mutation.isPending,
    submit: () => mutation.mutate(),
  }
}
