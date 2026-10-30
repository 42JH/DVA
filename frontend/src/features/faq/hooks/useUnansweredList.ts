import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { pageSlice } from '@/shared/api/paging'
import { fmtListTime, fmtPhone } from '@/shared/lib/format'
import { useListParams } from '@/shared/lib/useListParams'
import {
  deleteUnanswered,
  unansweredQueries,
  type UnansweredQuestion,
} from '@/features/faq/api/unansweredApi'

export type { UnansweredQuestion } from '@/features/faq/api/unansweredApi'

/** 목록 한 줄 = 질문 + 화면용 글 (시각 칸 한 줄 또는 두 줄 · 하이픈 전화번호) */
export type UnansweredRow = UnansweredQuestion & { time: string[]; phone: string }

const PAGE_SIZE = 20
const DEFAULTS = { q: '' } // URL 쿼리 기본값 (모듈 상수 — useListParams 규칙)

type Modal = { kind: 'add' | 'delete'; item: UnansweredQuestion } | null

/** 09 AI 미답변 목록 훅 (와이어프레임 09_AI미답변, 10/30) — 처리 안 된 질문만 · 오래된 순(먼저 쌓인 것부터 처리)
 * 검색 = 질문 · 이름 · 전화번호. 줄마다 [FAQ 추가](창 → 추가하면 처리됨) · [삭제](확인 창). 줄을 누르면 그 통화의 06
 * 같은 질문 묶기 · 한꺼번에 처리 없음 (콜드 스타트, MVP 후) */
export function useUnansweredList() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { params, page, set } = useListParams(DEFAULTS)
  const [modal, setModal] = useState<Modal>(null)
  const list = useQuery(unansweredQueries.list())

  const needle = params.q.trim().toLowerCase()
  const digits = params.q.replace(/\D/g, '') // '010-1458' · '01014582209' 둘 다 찾게
  const hit = (list.data ?? [])
    .filter(
      (u) =>
        !needle ||
        u.question.toLowerCase().includes(needle) ||
        u.customerName.toLowerCase().includes(needle) ||
        (digits !== '' && u.callerNumber.includes(digits)),
    )
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
  const sliced = pageSlice(hit, page, PAGE_SIZE)
  const rows: UnansweredRow[] = sliced.rows.map((u) => ({
    ...u,
    time: fmtListTime(u.startedAt),
    phone: fmtPhone(u.callerNumber),
  }))

  const remove = useMutation({
    mutationFn: (id: number) => deleteUnanswered(id),
    onSuccess: () => setModal(null),
    onSettled: () => qc.invalidateQueries({ queryKey: unansweredQueries.all() }), // 사이드바 숫자도 같이 줄어듦
  })

  return {
    q: params.q,
    setQ: (v: string) => set({ q: v }),
    rows,
    count: hit.length, // 'AI 미답변 질문 22개' (검색 중엔 결과 수)
    isLoading: list.isPending,
    listError: list.error?.message ?? null,
    page: sliced.page,
    pages: sliced.pages,
    goPage: (p: number) => set({ page: p }),

    openCall: (u: UnansweredQuestion) => navigate(`/calls/${u.callSessionSeq}`),

    modal,
    openAdd: (u: UnansweredQuestion) => setModal({ kind: 'add', item: u }),
    openDelete: (u: UnansweredQuestion) => {
      remove.reset()
      setModal({ kind: 'delete', item: u })
    },
    closeModal: () => setModal(null),
    confirmDelete: () => modal && remove.mutate(modal.item.unansweredQuestionSeq),
    isDeleting: remove.isPending,
    deleteError: remove.error?.message ?? null,
  }
}

/** 사이드바 'AI 미답변' 옆 빨간 숫자 — 목록과 같은 데이터라 처리하면 같이 줄어듦 (app/AppLayout이 사이드바에 넘김) */
export function useUnansweredCount() {
  return useQuery(unansweredQueries.list()).data?.length ?? 0
}
