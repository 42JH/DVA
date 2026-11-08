// v2 FAQ — 전부 받아(수십 개) 분류 · 검색(띄어쓰기 · 초성)은 화면에서. 펼친 FAQ는 최근 고객 질문 사례를 따로 받음
import { useQuery } from '@tanstack/react-query'
import { useDeferredValue, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { matchKo } from '@/shared/lib/search'
import { useListParams } from '@/shared/lib/useListParams'
import { FAQ_CATEGORIES, faqQueries, type Faq, type FaqCategory } from '@/features/faq/api/faqApi'
import type { UnansweredQuestion } from '@/features/faq/api/unansweredApi'
import { dateTime } from '@/v2/lib/when'

const DEFAULTS = { q: '', cat: '', open: '' }
const newest = (a: Faq, b: Faq) => Date.parse(b.createdAt) - Date.parse(a.createdAt)

export function useFaqs() {
  const { params, set } = useListParams(DEFAULTS)
  const dq = useDeferredValue(params.q)
  const cat = FAQ_CATEGORIES.some((c) => c.name === params.cat) ? (params.cat as FaqCategory) : null
  const list = useQuery(faqQueries.list())
  const all = list.data ?? []
  const rows = (
    dq
      ? all.filter((f) => matchKo(f.question, dq) || matchKo(f.answer, dq))
      : all.filter((f) => !cat || f.category === cat)
  ).sort(newest)

  // 미답변 [FAQ로 만들기]로 왔으면 추가 칸을 고객 말로 채워 엶 (저장하면 그 질문이 처리됨) — 저장 · 취소하면 미답변으로 돌아감
  const state = useLocation().state as { from?: UnansweredQuestion; back?: string } | null
  const navigate = useNavigate()
  const [adding, setAdding] = useState(!!state?.from)
  const finishAdd = () => {
    setAdding(false)
    if (state?.back) navigate(state.back)
  }

  return {
    q: params.q,
    setQ: (q: string) => set({ q, open: '' }),
    cat,
    setCat: (c: FaqCategory | null) => set({ cat: c ?? '', q: '', open: '' }),
    cats: FAQ_CATEGORIES.map((c) => ({
      name: c.name,
      count: all.filter((f) => f.category === c.name).length,
    })),
    total: all.length,
    rows,
    open: Number(params.open) || null,
    toggle: (id: number) => set({ open: params.open === String(id) ? '' : String(id) }),
    isLoading: list.isPending,
    error: list.error ? 'FAQ를 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.' : null,
    adding,
    from: state?.from,
    addCategory: cat ?? FAQ_CATEGORIES[0].name,
    startAdd: () => setAdding(true),
    finishAdd,
  }
}

/** 펼친 FAQ의 최근 고객 질문 사례 (최대 10, 최신순) — 누르면 그 통화. enabled=false면 요청 안 함 */
export function useExamples(id: number, enabled = true) {
  const q = useQuery({ ...faqQueries.detail(id), enabled })
  return (q.data?.recentQuestions ?? []).map((e) => ({
    key: e.faqQuestionExampleSeq,
    text: e.questionText,
    at: dateTime(e.occurredAt),
    iso: e.occurredAt, // 통화 상세가 그 말로 스크롤하는 데 씀
    call: e.callSessionSeq,
  }))
}

export type FaqsVm = ReturnType<typeof useFaqs>
