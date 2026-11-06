import { useQuery } from '@tanstack/react-query'
import { useDeferredValue } from 'react'
import { ApiError } from '@/shared/api/client'
import { pageSlice } from '@/shared/api/paging'
import { matchKo } from '@/shared/lib/search'
import { useListParams } from '@/shared/lib/useListParams'
import { FAQ_CATEGORIES, faqQueries, type Faq, type FaqCategory } from '@/features/faq/api/faqApi'

export type { Faq, FaqCategory } from '@/features/faq/api/faqApi'
export { FAQ_CATEGORIES } from '@/features/faq/api/faqApi'

const PAGE_SIZE = 10 // 한 쪽 10줄 (Figma 'FAQ' 11/04 — 900 높이 화면에 쪽 번호까지 한눈에)
const FIRST = FAQ_CATEGORIES[0].name // 처음 고른 분류 = 접수
// URL 쿼리 기본값 (모듈 상수 — useListParams 규칙). open = 펼친 FAQ 번호 (검색 창 · 최근 조회 · 뒤로가기로 다시 펼쳐지게)
const DEFAULTS = { q: '', category: FIRST as string, open: '' }

export const isCategory = (v: string | null): v is FaqCategory =>
  FAQ_CATEGORIES.some((c) => c.name === v)

const enc = encodeURIComponent
/** FAQ 화면 주소 */
export const faqTo = {
  list: (c?: FaqCategory | '') => (c ? `/faqs?category=${enc(c)}` : '/faqs'),
  search: (q: string) => `/faqs?q=${enc(q)}`,
}

/** 검색 — 질문 · 답변에서 (띄어쓰기 · 초성 규칙), 모든 분류, 최근 만든 것이 위 */
const newest = (a: Faq, b: Faq) => Date.parse(b.createdAt) - Date.parse(a.createdAt)
const searchFaqs = (all: Faq[], q: string) =>
  all.filter((f) => matchKo(f.question, q) || matchKo(f.answer, q)).sort(newest)

const errorOf = (e: Error | null) =>
  e instanceof ApiError && e.status === 403 ? 'FAQ 관리 권한이 없습니다.' : (e?.message ?? null)

/** 09 FAQ 목록 훅 (Figma 'FAQ' 11/06) — 왼쪽에서 고른 분류의 질문만. 상단바 검색어가 있으면 모든 분류에서 찾음('전체' 탭이 없어진 대신)
 *  전체를 받아 화면에서 검색(띄어쓰기 · 초성) · 최신순 · 쪽 나누기. 분류를 누르면(링크) 검색어 · 쪽 · 펼침은 지워짐
 *  질문을 누르면 그 자리에서 답변이 펼쳐짐 (한 번에 하나) */
export function useFaqList() {
  const { params, page, set } = useListParams(DEFAULTS)
  const q = params.q
  const dq = useDeferredValue(q) // 글자마다 전체 FAQ를 거르니 목록 · 추천은 한 박자 늦게 (11/02)
  const category = isCategory(params.category) ? params.category : FIRST // 주소에 모르는 분류가 오면 첫 분류로
  const open = Number(params.open) || null

  const list = useQuery(faqQueries.list())
  const all = list.data ?? []
  const hit = dq ? searchFaqs(all, dq) : all.filter((f) => f.category === category).sort(newest) // 최근 만든 것이 위. 수정은 자리 유지
  const sliced = pageSlice(hit, page, PAGE_SIZE) // 지워서 쪽이 줄면 마지막 쪽으로

  return {
    q,
    setQ: (v: string) => set({ q: v, open: '' }),
    category: q ? null : category, // 검색 중엔 고른 분류 없음 (결과가 모든 분류라)
    addCategory: category, // 추가하면 들어갈 분류 = 왼쪽에서 마지막에 고른 것
    listTo: faqTo.list(category), // 경로 'FAQ' — 검색을 풀고 보던 분류 목록으로
    startAdd: () => set({ q: '', open: '' }), // [추가] — 검색 · 펼침을 풀고 그 분류 1쪽 (새 칸은 맨 위)
    rows: sliced.rows,
    open,
    toggle: (id: number) => set({ open: open === id ? '' : String(id), page: sliced.page }),
    isLoading: list.isPending,
    error: errorOf(list.error),
    page: sliced.page,
    pages: sliced.pages,
    goPage: (p: number) => set({ page: p, open: '' }),
  }
}

/** 옛 상세 주소 /faqs/:id (검색 창 · 최근 조회 · 다른 화면 링크) → 그 FAQ가 있는 분류 · 쪽에서 펼친 목록 주소. 받는 중이면 null
 *  ?q=가 있으면 그 검색 결과 안에서 */
export function useFaqOpenTo(id: number, q: string): string | null {
  const list = useQuery(faqQueries.list())
  if (!list.data) return list.isError ? faqTo.list() : null
  const f = list.data.find((x) => x.faqEntrySeq === id)
  if (!f) return q ? faqTo.search(q) : faqTo.list() // 지워진 FAQ
  const rows = q
    ? searchFaqs(list.data, q)
    : list.data.filter((x) => x.category === f.category).sort(newest)
  const page = Math.max(1, Math.ceil((rows.findIndex((x) => x.faqEntrySeq === id) + 1) / PAGE_SIZE))
  const sp = new URLSearchParams(q ? { q } : { category: f.category })
  if (page > 1) sp.set('page', String(page))
  sp.set('open', String(id))
  return `/faqs?${sp}`
}

/** 이 FAQ로 AI가 답한 최근 고객 질문 사례 (펼친 답변 아래) — GET /faqs/{id}의 recentQuestions. 못 받으면 칸째 안 보임 */
export function useRecentQuestions(id: number) {
  return useQuery(faqQueries.detail(id)).data?.recentQuestions ?? []
}
