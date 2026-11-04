import { useQuery } from '@tanstack/react-query'
import { useDeferredValue } from 'react'
import { ApiError } from '@/shared/api/client'
import { pageSlice } from '@/shared/api/paging'
import { matchKo } from '@/shared/lib/search'
import { useListParams } from '@/shared/lib/useListParams'
import { FAQ_CATEGORIES, faqQueries, type Faq, type FaqCategory } from '@/features/faq/api/faqApi'
import { heardQuestions } from '@/features/faq/api/faqHeard'

export type { Faq, FaqCategory } from '@/features/faq/api/faqApi'
export { FAQ_CATEGORIES } from '@/features/faq/api/faqApi'

const PAGE_SIZE = 10 // 한 쪽 10줄 (Figma 'FAQ' 11/04 — 900 높이 화면에 쪽 번호까지 한눈에)
const FIRST = FAQ_CATEGORIES[0].name // 처음 고른 분류 = 접수
const DEFAULTS = { q: '', category: FIRST as string } // URL 쿼리 기본값 (모듈 상수 — useListParams 규칙)

export const isCategory = (v: string | null): v is FaqCategory =>
  FAQ_CATEGORIES.some((c) => c.name === v)

const enc = encodeURIComponent
/** FAQ 화면 주소 — 검색으로 들어가면 ?q=를 달고 다녀서 경로('“박스” 검색 > “박스” 검색 상세') · 하이라이트가 이어짐 (11/04) */
export const faqTo = {
  list: (c?: FaqCategory | '') => (c ? `/faqs?category=${enc(c)}` : '/faqs'),
  search: (q: string) => `/faqs?q=${enc(q)}`,
  detail: (id: number, q?: string) => `/faqs/${id}${q ? `?q=${enc(q)}` : ''}`,
  edit: (id: number, q?: string) => `/faqs/${id}/edit${q ? `?q=${enc(q)}` : ''}`,
}

/** 검색 — 질문 · 답변에서 (띄어쓰기 · 초성 규칙), 모든 분류, 최근 만든 것이 위 */
const newest = (a: Faq, b: Faq) => Date.parse(b.createdAt) - Date.parse(a.createdAt)
const searchFaqs = (all: Faq[], q: string) =>
  all.filter((f) => matchKo(f.question, q) || matchKo(f.answer, q)).sort(newest)

const errorOf = (e: Error | null) =>
  e instanceof ApiError && e.status === 403 ? 'FAQ 관리 권한이 없습니다.' : (e?.message ?? null)

/** 09 FAQ 목록 훅 (Figma 'FAQ' 11/04) — 왼쪽에서 고른 분류의 질문만. 상단바 검색어가 있으면 모든 분류에서 찾음('전체' 탭이 없어진 대신)
 *  전체를 받아 화면에서 검색(띄어쓰기 · 초성) · 최신순 · 쪽 나누기. 분류를 누르면(링크) 검색어 · 쪽은 지워짐 */
export function useFaqList() {
  const { params, page, set } = useListParams(DEFAULTS)
  const q = params.q
  const dq = useDeferredValue(q) // 글자마다 전체 FAQ를 거르니 목록 · 추천은 한 박자 늦게 (11/02)
  const category = isCategory(params.category) ? params.category : FIRST // 주소에 모르는 분류가 오면 첫 분류로

  const list = useQuery(faqQueries.list())
  const all = list.data ?? []
  const hit = dq ? searchFaqs(all, dq) : all.filter((f) => f.category === category).sort(newest) // 최근 만든 것이 위. 수정은 자리 유지
  const sliced = pageSlice(hit, page, PAGE_SIZE) // 지워서 쪽이 줄면 마지막 쪽으로

  return {
    q,
    setQ: (v: string) => set({ q: v }),
    category: q ? null : category, // 검색 중엔 고른 분류 없음 (결과가 모든 분류라)
    addTo: `/faqs/new?category=${enc(category)}`,
    listTo: faqTo.list(category), // 경로 'FAQ' — 검색을 풀고 보던 분류 목록으로 // 작성 화면은 지금 분류를 골라 둔 채로
    rows: sliced.rows,
    isLoading: list.isPending,
    error: errorOf(list.error),
    page: sliced.page,
    pages: sliced.pages,
    goPage: (p: number) => set({ page: p }),
  }
}

/** 09 FAQ 한 건 (상세 · 수정) — 받아 둔 목록에서 찾음 (수십 개라 목록을 다 받음, GET /faqs/{id}를 따로 안 부름) */
export function useFaqDetail(id: number) {
  const list = useQuery(faqQueries.list())
  return {
    faq: list.data?.find((f) => f.faqEntrySeq === id) ?? null,
    isLoading: list.isPending,
    error: errorOf(list.error),
  }
}

/** 검색 창(FaqSearchModal) — 치는 동안 맞는 FAQ (한 박자 늦게, 목록과 같은 규칙) */
export function useFaqSearch(q: string) {
  const dq = useDeferredValue(q)
  const list = useQuery(faqQueries.list())
  return dq.trim() ? searchFaqs(list.data ?? [], dq) : []
}

/** 이 FAQ로 AI가 답한 최근 고객 질문 (상세 아래) — 지금은 목데이터(faqHeard.ts). API가 생기면 여기서 useQuery로 */
export function useHeardQuestions(faq: Faq | null) {
  return faq ? heardQuestions(faq) : []
}
