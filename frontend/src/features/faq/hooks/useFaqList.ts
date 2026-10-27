import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError } from '@/shared/api/client'
import { pageSlice } from '@/shared/api/paging'
import { useListParams } from '@/shared/lib/useListParams'
import { useSession } from '@/shared/auth/useSession'
import {
  FAQ_CATEGORIES,
  deleteFaq,
  faqQueries,
  type Faq,
  type FaqCategory,
} from '@/features/faq/api/faqApi'

export type { Faq, FaqCategory } from '@/features/faq/api/faqApi'
export { FAQ_CATEGORIES } from '@/features/faq/api/faqApi'

/** 목록 한 줄 = FAQ + 화면 번호 (검색 · 분류 결과 안에서 1부터) */
export type FaqRow = Faq & { no: number }
export type CategoryFilter = '전체' | FaqCategory

const PAGE_SIZE = 20 // 한 쪽 20줄
const DEFAULTS = { q: '', category: '전체' } // URL 쿼리 기본값 (모듈 상수 — useListParams 규칙)

type Modal = { kind: 'add' } | { kind: 'edit'; faq: Faq } | { kind: 'delete' } | null

/** 09 FAQ 목록 훅 — 전체를 받아 화면에서 검색 · 분류 · 쪽을 나눔. 펼침 · 선택 · 창 상태와 삭제(슈퍼바이저만) */
export function useFaqList() {
  const qc = useQueryClient()
  // 검색어 · 분류 · 쪽은 URL 쿼리에 (뒤로가기 · 새로고침 · 주소 공유에도 그대로). 필터를 바꾸면 쪽은 1로
  const { params, page, set } = useListParams(DEFAULTS)
  const q = params.q
  const category = params.category as CategoryFilter
  const [openId, setOpenId] = useState<number | null>(null) // 답변 펼친 줄 (한 번에 하나)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [modal, setModal] = useState<Modal>(null)

  const list = useQuery(faqQueries.list())
  const { isSystemAdmin: canDelete } = useSession() // 삭제(와 체크박스)는 슈퍼바이저 = 명세 SYSTEM_ADMIN 만

  const needle = q.trim().toLowerCase()
  const searched = (list.data?.data ?? []).filter(
    (f) =>
      !needle ||
      f.question.toLowerCase().includes(needle) ||
      f.answer.toLowerCase().includes(needle),
  )
  // 분류별 건수는 검색 결과 기준 (검색 중이면 그 안에서 분류가 몇 개인지)
  const counts = Object.fromEntries(
    FAQ_CATEGORIES.map((c) => [c.name, searched.filter((f) => f.category === c.name).length]),
  ) as Record<FaqCategory, number>
  const hit = searched
    .filter((f) => category === '전체' || f.category === category)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)) // 최근 만든 것이 1번. 수정은 자리 유지
  const sliced = pageSlice(hit, page, PAGE_SIZE) // 지워서 쪽이 줄면 마지막 쪽으로
  const rows: FaqRow[] = sliced.rows.map((faq, i) => ({
    ...faq,
    no: (sliced.page - 1) * PAGE_SIZE + i + 1, // 번호 = 보이는 순서 (쪽 반영)
  }))

  const remove = useMutation({
    mutationFn: async () => {
      const ids = [...selected]
      const results = await Promise.allSettled(ids.map(deleteFaq))
      const failed = ids.filter((_, i) => results[i].status === 'rejected')
      setSelected(new Set(failed)) // 지워진 건 선택에서 빼고 실패한 것만 남김 → 다시 [삭제]하면 그것만
      const first = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
      if (first) throw first.reason
    },
    onSettled: () => qc.invalidateQueries({ queryKey: faqQueries.all() }), // 일부만 실패해도 목록은 다시 받음
    onSuccess: () => setModal(null),
  })

  const message = (e: unknown) =>
    e instanceof ApiError && e.status === 403
      ? 'FAQ 관리 권한이 없습니다.'
      : e instanceof Error
        ? e.message
        : null

  const reset = () => {
    setOpenId(null)
    setSelected(new Set())
  }

  return {
    q,
    setQ: (v: string) => {
      set({ q: v })
      reset()
    },
    category,
    setCategory: (c: CategoryFilter) => {
      set({ category: c })
      reset()
    },
    categories: FAQ_CATEGORIES.map((c) => ({ name: c.name, count: counts[c.name] })),
    totalCount: searched.length, // 왼쪽 '전체' 줄

    rows,
    count: hit.length, // 'FAQ 목록 23개' (검색 · 분류 중엔 결과 수)
    isLoading: list.isPending,
    listError: message(list.error),
    page: sliced.page,
    pages: sliced.pages,
    goPage: (p: number) => {
      set({ page: p })
      setOpenId(null)
    },

    openId,
    toggleOpen: (id: number) => setOpenId((o) => (o === id ? null : id)),

    canDelete,
    selected,
    toggleSelect: (key: string | number) =>
      setSelected((s) => {
        const n = new Set(s)
        const id = Number(key)
        if (n.has(id)) n.delete(id)
        else n.add(id)
        return n
      }),
    // 전체 선택은 없음 (10/27): 줄마다 하나씩만 — 실수로 전부 지우는 일을 막음

    modal,
    openAdd: () => setModal({ kind: 'add' }),
    openEdit: (faq: Faq) => setModal({ kind: 'edit', faq }),
    openDelete: () => {
      remove.reset() // 지난번 실패 문구가 새 창에 먼저 뜨지 않게
      setModal({ kind: 'delete' })
    },
    closeModal: () => setModal(null),
    confirmDelete: () => remove.mutate(),
    isDeleting: remove.isPending,
    deleteError: message(remove.error),
  }
}
