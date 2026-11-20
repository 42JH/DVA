// 09 FAQ 관리 Model — API-29 · 30 · 31 · 33 (연동 상세명세 10/31 §6.1~6.3) + 상세 GET /faqs/{id}(고객 질문 사례, 11/05). React를 모르는 데이터 · API 층
// 개발 중엔 MSW 가짜(mocks/handlers/faq.ts)가 같은 모양으로 응답
import { queryOptions } from '@tanstack/react-query'
import { api, type ApiItem } from '@/shared/api/client'
import { fetchAll } from '@/shared/api/paging'

/**
 * 분류 10개 고정 (확정 · 10/28 '기타' 추가, 맨 끝) — 서버 허용값과 같은 글자(가운데점 · 띄어쓰기 그대로). 화면에서 추가 · 수정 · 삭제 없음
 * AI 미답변 질문엔 분류가 없음 — 관리자가 [FAQ 추가] 창에서 고름
 */
export const FAQ_CATEGORIES = [
  { name: '접수' },
  { name: '수거 일정' },
  { name: '물품·박스' },
  { name: '포장·파손' },
  { name: '배송·운송장' },
  { name: '주소' },
  { name: '변경·취소' },
  { name: '요금·결제' },
  { name: '이용 안내' },
  { name: '기타' },
] as const
export type FaqCategory = (typeof FAQ_CATEGORIES)[number]['name']

export interface Faq {
  faqEntrySeq: number
  category: FaqCategory
  question: string
  answer: string
  updatedByAdminUserSeq: number
  createdAt: string // ISO 8601
  updatedAt: string
}

/** 고객 질문 사례 — 이 FAQ로 AI가 답한 실제 고객 발화 원문 (공백 · 줄바꿈 그대로, 일반 글로만 보여 줌) */
interface FaqQuestionExample {
  faqQuestionExampleSeq: number // 렌더링 key (같은 문장도 다른 사례)
  questionText: string
  occurredAt: string // 응대 시각 ISO 8601
  callSessionSeq: number | null // 그 사례의 원본 통화 → 통화 상세. null = 원본이 지워졌거나 보관 만료(링크 없음)
}

/** FAQ 상세 = FAQ + 최근 고객 질문 사례 (최대 10 · 최신순 · 서버 순서 그대로 · 없으면 []) */
interface FaqDetail extends Faq {
  recentQuestions: FaqQuestionExample[]
}

export interface FaqInput {
  category: FaqCategory
  question: string
  answer: string
}

export const faqQueries = {
  all: () => ['faqs'] as const,
  list: () =>
    queryOptions({
      queryKey: [...faqQueries.all(), 'list'],
      queryFn: ({ signal }) => fetchFaqs(signal),
    }),
  // 상세는 고객 질문 사례 때문에 따로 받음 (FAQ 칸은 목록에도 있음). 키가 ['faqs', …] 아래라 수정 · 삭제 뒤 목록과 같이 새로 받음
  detail: (id: number) =>
    queryOptions({
      queryKey: [...faqQueries.all(), 'detail', id],
      queryFn: ({ signal }) => fetchFaqDetail(id, signal),
    }),
}

/** FAQ 상세 — 구버전 서버(배포 과도기)는 recentQuestions · callSessionSeq 칸이 없을 수 있음 → [] · null */
async function fetchFaqDetail(id: number, signal?: AbortSignal): Promise<FaqDetail> {
  const { data } = await api.get<ApiItem<FaqDetail>>(`/faqs/${id}`, { signal })
  return {
    ...data,
    recentQuestions: (data.recentQuestions ?? []).map((e) => ({
      ...e,
      callSessionSeq: e.callSessionSeq ?? null,
    })),
  }
}

/** API-29 — FAQ는 수십 개라 다 받고, 검색(띄어쓰기 · 초성) · 분류 · 쪽 나누기 · 최신순은 화면에서 (서버 q는 단순 부분 일치 · 번호순뿐) */
const fetchFaqs = (signal?: AbortSignal): Promise<Faq[]> => fetchAll<Faq>('/faqs', {}, signal)

/** API-30 — 한 건도 늘 items 배열. 204. 같은 질문(띄어쓰기 · 대소문자 정규화)이 있으면 409 DUPLICATE_RESOURCE */
export function createFaq(input: FaqInput): Promise<void> {
  return api.post('/faqs', { body: { items: [input] } })
}

/** API-33 — 부분 수정 없음: 분류 · 질문 · 답변 세 칸을 다 보냄. 204. 다른 FAQ와 질문이 같아지면 409 */
export function updateFaq(id: number, input: FaqInput): Promise<void> {
  return api.patch(`/faqs/${id}`, { body: input })
}

/** API-31 — 삭제는 번호 배열을 본문으로 (DELETE /faqs/{id} 경로는 없음). 204 */
export function deleteFaq(id: number): Promise<void> {
  return api.delete('/faqs', { body: { faqEntrySeqs: [id] } })
}
