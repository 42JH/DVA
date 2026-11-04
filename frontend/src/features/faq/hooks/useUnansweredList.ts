import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { FETCH_ALL_MAX, pageSlice } from '@/shared/api/paging'
import { todayYmd, ymd } from '@/shared/lib/dateRange'
import { fmtListTime, fmtPhone } from '@/shared/lib/format'
import { matchKo, phoneDigits } from '@/shared/lib/search'
import { reasonTag, type UnansweredReason } from '@/shared/lib/unansweredReason'
import { useListParams } from '@/shared/lib/useListParams'
import {
  deleteUnanswered,
  unansweredQueries,
  type UnansweredQuestion,
} from '@/features/faq/api/unansweredApi'

export type { UnansweredQuestion } from '@/features/faq/api/unansweredApi'

/** 목록 한 줄 = 질문 + 화면용 글 (시각 칸 한 줄 또는 두 줄 · 하이픈 전화번호 · 사유 태그) */
export type UnansweredRow = UnansweredQuestion & {
  time: string[]
  phone: string
  reasonTag: ReturnType<typeof reasonTag>
}

/** 사유 거르기 (11/05 새 디자인 — FAQ 분류 자리) — '' = 전체, none = 미분류(사유 null) */
export type ReasonKey = '' | UnansweredReason | 'none'
const REASON_KEYS: ReasonKey[] = ['', 'KB_NO_ANSWER', 'KB_UNAVAILABLE', 'none']
const reasonOf = (u: UnansweredQuestion): ReasonKey => u.reason ?? 'none'

const PAGE_SIZE = 20
// URL 쿼리 기본값 (모듈 상수 — useListParams 규칙). call = 06 '처리 내용 › AI 미답변 보기'로 오면 그 통화 번호 → 그 통화의 질문만
// reason = 사유 거르기 (빈 값 = 전체)
const DEFAULTS = { q: '', call: '', reason: '' }

type Modal = { kind: 'delete'; item: UnansweredQuestion } | null

/** 09 AI 미답변 목록 훅 (와이어프레임 09_AI미답변, 10/30) — 처리 안 된 질문만 · 오래된 순(먼저 쌓인 것부터 처리)
 * 검색 = 질문 · 이름 · 전화번호. 줄마다 [FAQ 추가](창 → 추가하면 처리됨) · [삭제](확인 창). 줄을 누르면 그 통화의 06
 * 같은 질문 묶기 · 한꺼번에 처리 없음 (콜드 스타트, MVP 후) */
export function useUnansweredList({
  pageSize = PAGE_SIZE,
  todayOnly = false, // 01 홈: 오늘 통화에서 나온 질문만
}: { pageSize?: number; todayOnly?: boolean } = {}) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { pathname, search } = useLocation()
  const { params, page, set } = useListParams(DEFAULTS)
  const [modal, setModal] = useState<Modal>(null)
  const list = useQuery(unansweredQueries.list())
  const total = useQuery(unansweredQueries.count()) // 사이드바와 같은 쿼리(캐시 공유) — 목록이 상한(2,000)에 걸렸는지 보는 용도
  const capped =
    (list.data?.length ?? 0) >= FETCH_ALL_MAX && (total.data ?? 0) > (list.data?.length ?? 0)

  const q = params.q
  const digits = phoneDigits(q) // 숫자만 쳤을 때만 번호로 ('010-1458' · '01014582209' 둘 다). '3시'의 3으로 번호를 찾지 않게
  const call = /^\d+$/.test(params.call) ? Number(params.call) : null // 숫자가 아니면(?call=abc) 통화 필터 없음
  const today = todayYmd()
  const ofCall = (list.data ?? []).filter(
    (u) =>
      (call === null || u.callSessionSeq === call) &&
      (!todayOnly || (u.startedAt !== null && ymd(new Date(u.startedAt)) === today)),
  )
  const searched = ofCall.filter(
    (u) =>
      matchKo(u.question, q) ||
      matchKo(u.customerName, q) ||
      (digits !== '' && u.callerNumber.includes(digits)),
  ) // 순서 = 서버가 준 오래된 통화부터 (시각 모르는 질문은 뒤)
  // URL은 누구나 고칠 수 있으니 모르는 사유 값은 전체로 (컨벤션 4.7)
  const reason = REASON_KEYS.find((k) => k === params.reason) ?? ''
  const hit = reason ? searched.filter((u) => reasonOf(u) === reason) : searched
  // 06 '처리 내용 › AI 미답변 보기'로 왔을 때 경로 끝: '강도윤 통화' (시각은 줄에 있어 뺌 — 길면 경로가 잘림). 질문이 다 처리돼 없으면 '이 통화'
  const first = ofCall[0]
  const callLabel = call === null ? null : first ? `${first.customerName} 통화` : '이 통화'
  const sliced = pageSlice(hit, page, pageSize)
  const rows: UnansweredRow[] = sliced.rows.map((u) => ({
    ...u,
    time: u.startedAt ? fmtListTime(u.startedAt) : ['—'], // 시각을 못 받은 통화
    phone: u.callerNumber ? fmtPhone(u.callerNumber) : '—',
    reasonTag: reasonTag(u.reason),
  }))

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
    // 왼쪽 사유 목록 — 검색 · 통화 조건 안에서 사유마다 몇 개 (11/05 새 디자인)
    reason,
    reasons: REASON_KEYS.map((key) => ({
      key,
      label: key === '' ? '전체' : reasonTag(key === 'none' ? null : key).label,
      count: key === '' ? searched.length : searched.filter((u) => reasonOf(u) === key).length,
    })),
    setReason: (r: ReasonKey) => set({ reason: r }),
    callLabel, // 06에서 왔을 때만 — 경로 'FAQ > AI 미답변 > 강도윤 통화' ('AI 미답변'을 누르면 전체로)
    rows,
    count: hit.length, // 'AI 미답변 질문 22개' (검색 중엔 결과 수)
    // 서버가 오래된 것부터 주고 2,000개까지만 받음 → 그 뒤(최신) 질문은 목록에 없음. 넘으면 서버 쪽 넘김으로 바꿔야 함 (11/02)
    listNote: capped
      ? `오래된 ${FETCH_ALL_MAX.toLocaleString('ko-KR')}개만 표시됩니다 (전체 ${(total.data ?? 0).toLocaleString('ko-KR')}개)`
      : null,
    isLoading: list.isPending,
    listError: list.error?.message ?? null,
    page: sliced.page,
    pages: sliced.pages,
    goPage: (p: number) => set({ page: p }),

    openCall: (u: UnansweredQuestion) => navigate(`/calls/${u.callSessionSeq}`),

    modal,
    // FAQ 추가 = FAQ 작성 화면(11/04 새 디자인)으로 — 질문 칸에 고객이 한 말을 채우고, 저장하면 이 질문이 처리됨(API-27) · 여기로 돌아옴
    openAdd: (u: UnansweredQuestion) =>
      navigate('/faqs/new', { state: { from: u, back: pathname + search } }),
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

/** 사이드바 'AI 미답변' 옆 빨간 숫자 — total_count 1건 요청. 처리 · 삭제가 ['unanswered']를 무효화해 같이 줄어듦 (app/AppLayout이 사이드바에 넘김) */
export function useUnansweredCount() {
  return useQuery(unansweredQueries.count()).data ?? 0
}
