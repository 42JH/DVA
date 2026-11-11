// FAQ — 전부 받아(수십 개) 분류 · 검색(띄어쓰기 · 초성)은 화면에서. 펼친 FAQ는 최근 고객 질문 사례를 따로 받음
import { useQuery } from '@tanstack/react-query'
import { useDeferredValue, useState } from 'react'
import { matchKo } from '@/shared/lib/search'
import { useListParams } from '@/shared/lib/useListParams'
import { FAQ_CATEGORIES, faqQueries, type Faq, type FaqCategory } from '@/features/faq/api/faqApi'
import { dateTime } from '@/shared/lib/when'

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

  const [adding, setAdding] = useState(false)

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
    addCategory: cat ?? null, // 추가 칸의 처음 분류 = 왼쪽에서 고른 분류. 전체면 없음(직접 고름, 11/11 — 전엔 말없이 '접수')
    startAdd: () => setAdding(true),
    finishAdd: () => setAdding(false),
  }
}

/** 펼친 FAQ의 최근 고객 질문 사례 (최대 10, 최신순) — 누르면 그 통화. enabled=false면 요청 안 함 */
export function useExamples(id: number, enabled = true) {
  const q = useQuery({ ...faqQueries.detail(id), enabled })
  // 최근 5개만 (11/09 사용자) — 서버 순서에 기대지 않고 최근 것부터
  return [...(q.data?.recentQuestions ?? [])]
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    .slice(0, 5)
    .map((e) => ({
      key: e.faqQuestionExampleSeq,
      text: e.questionText,
      at: dateTime(e.occurredAt),
      iso: e.occurredAt, // 통화 상세가 그 말로 스크롤하는 데 씀
      call: e.callSessionSeq,
    }))
}

export type FaqsVm = ReturnType<typeof useFaqs>
