import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError } from '@/shared/api/client'
import { pageSlice } from '@/shared/api/paging'
import { useListParams } from '@/shared/lib/useListParams'
import { FAQ_CATEGORIES, faqQueries, type Faq, type FaqCategory } from '@/features/faq/api/faqApi'

export type { Faq, FaqCategory } from '@/features/faq/api/faqApi'
export { FAQ_CATEGORIES } from '@/features/faq/api/faqApi'

/** 목록 한 줄 = FAQ + 화면 번호 (검색 · 분류 결과 안에서 1부터) */
export type FaqRow = Faq & { no: number }
export type CategoryFilter = '전체' | FaqCategory

const PAGE_SIZE = 20 // 한 쪽 20줄
const DEFAULTS = { q: '', category: '전체' } // URL 쿼리 기본값 (모듈 상수 — useListParams 규칙)

type Modal = { kind: 'add' } | { kind: 'edit'; faq: Faq } | null

/** 09 FAQ 목록 훅 — 전체를 받아 화면에서 검색 · 분류 · 쪽을 나눔. 답변 펼침과 추가 · 수정 창 상태
 * 10/30: 목록엔 체크박스 · [삭제] 없음 — 삭제는 수정 창 안에서 (useFaqForm), 모든 관리자 */
export function useFaqList() {
  // 검색어 · 분류 · 쪽은 URL 쿼리에 (뒤로가기 · 새로고침 · 주소 공유에도 그대로). 필터를 바꾸면 쪽은 1로
  const { params, page, set } = useListParams(DEFAULTS)
  const q = params.q
  const category = params.category as CategoryFilter
  const [openId, setOpenId] = useState<number | null>(null) // 답변 펼친 줄 (한 번에 하나)
  const [modal, setModal] = useState<Modal>(null)

  const list = useQuery(faqQueries.list())

  const needle = q.trim().toLowerCase()
  const searched = (list.data?.data ?? []).filter(
    (f) =>
      !needle ||
      f.question.toLowerCase().includes(needle) ||
      f.answer.toLowerCase().includes(needle),
  )
  const hit = searched
    .filter((f) => category === '전체' || f.category === category)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)) // 최근 만든 것이 1번. 수정은 자리 유지
  const sliced = pageSlice(hit, page, PAGE_SIZE) // 지워서 쪽이 줄면 마지막 쪽으로
  const rows: FaqRow[] = sliced.rows.map((faq, i) => ({
    ...faq,
    no: (sliced.page - 1) * PAGE_SIZE + i + 1, // 번호 = 보이는 순서 (쪽 반영)
  }))

  const listError =
    list.error instanceof ApiError && list.error.status === 403
      ? 'FAQ 관리 권한이 없습니다.'
      : (list.error?.message ?? null)

  return {
    q,
    setQ: (v: string) => {
      set({ q: v })
      setOpenId(null)
    },
    category,
    setCategory: (c: CategoryFilter) => {
      set({ category: c })
      setOpenId(null)
    },
    categories: FAQ_CATEGORIES.map((c) => c.name),

    rows,
    count: hit.length, // 'FAQ 목록 23개' (검색 · 분류 중엔 결과 수)
    isLoading: list.isPending,
    listError,
    page: sliced.page,
    pages: sliced.pages,
    goPage: (p: number) => {
      set({ page: p })
      setOpenId(null)
    },

    openId,
    toggleOpen: (id: number) => setOpenId((o) => (o === id ? null : id)),

    modal,
    openAdd: () => setModal({ kind: 'add' }),
    openEdit: (faq: Faq) => setModal({ kind: 'edit', faq }),
    closeModal: () => setModal(null),
  }
}
