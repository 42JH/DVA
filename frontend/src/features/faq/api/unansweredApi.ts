// 09 AI 미답변 Model — API-26 · 27 · 28 (연동 상세명세 10/31 §6.4). React를 모르는 데이터 층
// 개발 중엔 MSW 가짜(mocks/handlers/faq.ts)가 같은 모양으로 응답
import { queryOptions } from '@tanstack/react-query'
import { api, type ApiList } from '@/shared/api/client'
import { fetchAll } from '@/shared/api/paging'
import type { UnansweredReason } from '@/shared/lib/unansweredReason'
import type { FaqInput } from './faqApi'

/** 화면에서 쓰는 모양 (서버 UnansweredQuestion에서 바꿈 — 화면 이름은 그대로 두려고) */
export interface UnansweredQuestion {
  unansweredQuestionSeq: number
  callSessionSeq: number // 줄을 누르면 그 통화의 06 통화 상세
  startedAt: string | null // 통화 시작 시각 (PBX 우선, 없으면 AI 시작). 둘 다 못 받았으면 null
  customerName: string // 연결 고객의 지금 이름. 모르면 '—'
  callerNumber: string // 발신번호, 숫자만. 모르면 ''
  question: string // 고객이 한 말 그대로 (어… 음… 포함) — 다듬는 건 관리자가 [FAQ 추가] 창 질문 칸에서
  reason: UnansweredReason | null // 미답변 사유 (11/04). null = 미분류
}

/** 서버 UnansweredQuestion (§13) — 화면에서 안 쓰는 칸(occurredAt · offsetSeconds · status 등)은 뺌 */
export interface UnansweredDto {
  unansweredQuestionSeq: number
  callSessionSeq: number
  callStartedAt: string | null
  customerName: string | null
  callerPhoneNumber: string | null
  questionText: string
  reason?: UnansweredReason | null // 사유 연동(DB 049) 전 서버는 칸이 없음 → 미분류
}

export const toScreen = (d: UnansweredDto): UnansweredQuestion => ({
  unansweredQuestionSeq: d.unansweredQuestionSeq,
  callSessionSeq: d.callSessionSeq,
  startedAt: d.callStartedAt,
  customerName: d.customerName ?? '—',
  callerNumber: (d.callerPhoneNumber ?? '').replace(/\D/g, ''),
  question: d.questionText,
  reason: d.reason ?? null,
})

export const unansweredQueries = {
  all: () => ['unanswered'] as const,
  list: () =>
    queryOptions({
      queryKey: [...unansweredQueries.all(), 'list'],
      queryFn: ({ signal }) => fetchUnanswered(signal),
    }),
  /** 사이드바 숫자 — 1건만 받아 total_count (목록 전체를 받지 않게) */
  count: () =>
    queryOptions({
      queryKey: [...unansweredQueries.all(), 'count'],
      queryFn: async ({ signal }) =>
        (
          await api.get<ApiList<UnansweredDto>>('/unanswered-questions', {
            query: { limit: 1, offset: 0 },
            signal,
          })
        ).total_count,
    }),
}

/** 처리 안 된(OPEN) 질문 전부 — 서버가 오래된 통화부터 줌. 초성 검색 · ?call · 오늘만 · 쪽 나누기는 훅이 화면에서 */
async function fetchUnanswered(signal?: AbortSignal): Promise<UnansweredQuestion[]> {
  return (await fetchAll<UnansweredDto>('/unanswered-questions', {}, signal)).map(toScreen)
}

/** API-28 — FAQ로 풀 필요 없는 질문(조회 · 요청 · 잡음 · 중복) 삭제. 204 (이미 지웠어도 204, FAQ로 바꾼 질문은 409) */
export const deleteUnanswered = (id: number): Promise<void> =>
  api.delete('/unanswered-questions', { body: { unansweredQuestionSeqs: [id] } })

/** API-27 — [FAQ 추가]: FAQ 만들기 + 처리됨(REGISTERED)을 서버가 한 번에. POST /faqs를 따로 부르지 않음. 204 */
export const convertToFaq = (id: number, input: FaqInput): Promise<void> =>
  api.post(`/unanswered-questions/${id}/faqs`, { body: input })
