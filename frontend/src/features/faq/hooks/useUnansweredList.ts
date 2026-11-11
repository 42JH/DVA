import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { FETCH_ALL_MAX } from '@/shared/api/paging'
import { ymd } from '@/shared/lib/dateRange'
import { fmtListTime, fmtMonthDay, fmtPhone, fmtTime } from '@/shared/lib/format'
import { matchKo, phoneDigits } from '@/shared/lib/search'
import { originOf } from '@/shared/lib/unansweredReason'
import { useListParams } from '@/shared/lib/useListParams'
import {
  deleteUnanswered,
  unansweredQueries,
  type UnansweredQuestion,
} from '@/features/faq/api/unansweredApi'

export type { UnansweredQuestion } from '@/features/faq/api/unansweredApi'

/** 목록 한 줄 = 질문 + 화면용 글 (시각 '오후 3:02' · 하이픈 전화번호) */
export type UnansweredRow = UnansweredQuestion & { time: string; phone: string }

// URL 쿼리 기본값 (모듈 상수 — useListParams 규칙). call = 06 '처리 내용 › AI 미답변 보기'로 오면 그 통화 번호 → 그 통화의 질문만
// from = 이동 전 화면 주소 (경로 첫 칸, 11/05 — 검색 · 쪽을 바꿔도 남음)
const DEFAULTS = { q: '', call: '', from: '' }

type Group = { day: string; label: string; rows: UnansweredRow[] }

type Modal = { kind: 'delete' | 'faq'; item: UnansweredQuestion } | null

/** 09 AI 미답변 문의 훅 (Figma 'FAQ 미답변' 11/06) — 처리 안 된 질문만 · 오래된 순(먼저 쌓인 것부터 처리) · 통화 날짜별로 묶음, 쪽 없이 스크롤
 * 검색 = 질문 · 이름 · 전화번호. 줄마다 [+](FAQ 화면 맨 위 추가 칸 → 저장하면 처리됨) · [휴지통](확인 창). 줄을 누르면 그 통화의 06
 * 같은 질문 묶기 · 한꺼번에 처리 없음 (콜드 스타트, MVP 후) */
export function useUnansweredList() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { params, set } = useListParams(DEFAULTS)
  const [modal, setModal] = useState<Modal>(null)
  const list = useQuery(unansweredQueries.list())
  const total = useQuery(unansweredQueries.count()) // 사이드바와 같은 쿼리(캐시 공유) — 목록이 상한(2,000)에 걸렸는지 보는 용도
  const capped =
    (list.data?.length ?? 0) >= FETCH_ALL_MAX && (total.data ?? 0) > (list.data?.length ?? 0)

  const q = params.q
  const call = /^\d+$/.test(params.call) ? Number(params.call) : null // 숫자가 아니면(?call=abc) 통화 필터 없음
  const ofCall = (list.data ?? []).filter((u) => call === null || u.callSessionSeq === call)
  const find = (q: string) => {
    const digits = phoneDigits(q) // 숫자만 쳤을 때만 번호로 ('010-1458' · '01014582209' 둘 다). '3시'의 3으로 번호를 찾지 않게
    return ofCall.filter(
      (u) =>
        matchKo(u.question, q) ||
        matchKo(u.customerName, q) ||
        (digits !== '' && u.callerNumber.includes(digits)),
    )
  }
  const hit = find(q) // 순서 = 서버가 준 오래된 통화부터 (시각 모르는 질문은 뒤)
  // 06 '처리 내용 › AI 미답변 보기'로 왔을 때 적용된 필터 칩: '강도윤 · 11-05 13:13 통화의 질문만' (질문이 다 처리돼 없으면 '이 통화의 질문만')
  const first = ofCall[0]
  const callChip =
    call === null
      ? null
      : first
        ? `${first.customerName}${first.startedAt ? ` · ${fmtListTime(first.startedAt).join(' ')}` : ''} 통화의 질문만`
        : '이 통화의 질문만'
  const groups: Group[] = []
  for (const u of hit) {
    const day = u.startedAt ? ymd(new Date(u.startedAt)) : ''
    let g = groups.find((x) => x.day === day)
    if (!g) groups.push((g = { day, label: day ? fmtMonthDay(day) : '날짜 모름', rows: [] }))
    g.rows.push({
      ...u,
      time: u.startedAt ? fmtTime(u.startedAt) : '—', // 시각을 못 받은 통화
      phone: u.callerNumber ? fmtPhone(u.callerNumber) : '—',
    })
  }
  groups.sort((a, b) => (a.day || '~').localeCompare(b.day || '~')) // 오래된 날부터, 날짜 모름은 맨 뒤

  const remove = useMutation({
    mutationFn: (id: number) => deleteUnanswered(id),
    onSuccess: () => setModal(null),
    onSettled: () => qc.invalidateQueries({ queryKey: unansweredQueries.all() }), // 사이드바 숫자도 같이 줄어듦
  })

  return {
    q,
    setQ: (v: string) => {
      if (v !== q) set({ q: v })
    },
    origin: originOf(params.from), // 경로 첫 칸 = 이동 전 화면 (모르면 FAQ)
    callChip, // 적용된 필터 칩 (06에서 왔을 때만)
    clearCall: () => set({ call: '' }), // ✕ → 전체 미답변으로 (이동 전 화면은 그대로)
    groups,
    count: hit.length, // 검색 중엔 결과 수
    // 서버가 오래된 것부터 주고 2,000개까지만 받음 → 그 뒤(최신) 질문은 목록에 없음. 넘으면 서버 쪽 넘김으로 바꿔야 함 (11/02)
    listNote: capped
      ? `오래된 ${FETCH_ALL_MAX.toLocaleString('ko-KR')}개만 표시됩니다 (전체 ${(total.data ?? 0).toLocaleString('ko-KR')}개)`
      : null,
    isLoading: list.isPending,
    listError: list.error?.message ?? null,

    openCall: (u: UnansweredQuestion) => navigate(`/calls/${u.callSessionSeq}`),

    modal,
    // [FAQ 등록] = 이 화면에서 바로 창으로 (11/11 — FAQ 화면으로 넘어갔다 오던 것). 질문 칸은 고객이 한 말, 저장하면 이 질문이 처리됨(API-27)
    openAdd: (u: UnansweredQuestion) => setModal({ kind: 'faq', item: u }),
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
