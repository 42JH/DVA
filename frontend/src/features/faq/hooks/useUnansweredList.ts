import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { pageSlice } from '@/shared/api/paging'
import { todayYmd, ymd } from '@/shared/lib/dateRange'
import { fmtListTime, fmtPhone } from '@/shared/lib/format'
import { matchKo, phoneDigits, suggest } from '@/shared/lib/search'
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
// URL 쿼리 기본값 (모듈 상수 — useListParams 규칙). call = 06 '처리 내용 › AI 미답변 보기'로 오면 그 통화 번호 → 그 통화의 질문만
const DEFAULTS = { q: '', call: '' }

type Modal = { kind: 'add' | 'delete'; item: UnansweredQuestion } | null

/** 09 AI 미답변 목록 훅 (와이어프레임 09_AI미답변, 10/30) — 처리 안 된 질문만 · 오래된 순(먼저 쌓인 것부터 처리)
 * 검색 = 질문 · 이름 · 전화번호. 줄마다 [FAQ 추가](창 → 추가하면 처리됨) · [삭제](확인 창). 줄을 누르면 그 통화의 06
 * 같은 질문 묶기 · 한꺼번에 처리 없음 (콜드 스타트, MVP 후) */
export function useUnansweredList({
  pageSize = PAGE_SIZE,
  todayOnly = false, // 01 홈: 오늘 통화에서 나온 질문만
}: { pageSize?: number; todayOnly?: boolean } = {}) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { params, page, set } = useListParams(DEFAULTS)
  const [modal, setModal] = useState<Modal>(null)
  const list = useQuery(unansweredQueries.list())

  const q = params.q
  const digits = phoneDigits(q) // 숫자만 쳤을 때만 번호로 ('010-1458' · '01014582209' 둘 다). '3시'의 3으로 번호를 찾지 않게
  const call = params.call ? Number(params.call) : null
  const today = todayYmd()
  const ofCall = (list.data ?? []).filter(
    (u) =>
      (call === null || u.callSessionSeq === call) &&
      (!todayOnly || ymd(new Date(u.startedAt)) === today),
  )
  const hit = ofCall
    .filter(
      (u) =>
        matchKo(u.question, q) ||
        matchKo(u.customerName, q) ||
        (digits !== '' && u.callerNumber.includes(digits)),
    )
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
  // 통화 칩 글: '강도윤 · 13:13 통화의 질문만' (질문이 다 처리돼 없으면 '이 통화의 질문만')
  const first = ofCall[0]
  const callChips =
    call === null
      ? []
      : [
          {
            key: 'call',
            label: first
              ? `${first.customerName} · ${fmtListTime(first.startedAt).join(' ')} 통화의 질문만`
              : '이 통화의 질문만',
          },
        ]
  const sliced = pageSlice(hit, page, pageSize)
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
    q,
    setQ: (v: string) => set({ q: v }),
    suggestions: suggest(
      [...ofCall.map((u) => u.question), ...ofCall.map((u) => u.customerName)],
      q,
    ),
    callChips, // 적용된 필터 줄 (06에서 왔을 때만)
    clearCall: () => set({ call: '' }), // ✕ → 전체 미답변으로
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
