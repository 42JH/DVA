// 09 FAQ 관리 Model — FAQ-01 · 02 · 03 (명세서 16장 p57–59). React를 모르는 데이터 · API 층
import { queryOptions } from '@tanstack/react-query'
import { api, type ApiList } from '@/shared/api/client'

/**
 * 분류 9개 (10/27 확정) — 축 = 고객 의도(택배 단계), 05 AI 답변 실패 태그와 같은 목록. '기타' 없음
 * 명세에 없음 → BE 요청안: faq_entries.category · FAQ-01 category 필터 · FAQ-02/03 본문 category
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

export interface FaqInput {
  category: FaqCategory
  question: string
  answer: string
}

export const FAQ_FETCH_LIMIT = 100 // FAQ-01 limit 최대

export const faqQueries = {
  all: () => ['faqs'] as const,
  list: () =>
    queryOptions({
      queryKey: [...faqQueries.all(), 'list'],
      queryFn: ({ signal }) => fetchFaqs(signal),
    }),
}

/**
 * FAQ-01 — FAQ는 수십 개라 한 번에 다 받고(최대 100) 검색 · 쪽 나누기는 화면에서 한다.
 * 그래야 총 건수 없이도 쪽 번호 · '23개'가 나옴 (대조표 D2는 04 · 05 큰 목록용)
 * ponytail: 100개를 넘기면(hasNext) 서버 q/offset 쪽 넘김 + totalCount로 바꿀 것
 */
export function fetchFaqs(signal?: AbortSignal): Promise<ApiList<Faq>> {
  return api.get<ApiList<Faq>>('/faqs', { query: { limit: FAQ_FETCH_LIMIT, offset: 0 }, signal })
}

/** FAQ-02 — 204. 멱등키 필수: 같은 본문을 다시 보낼 땐 같은 키, 본문이 바뀌면 새 키 */
export function createFaq(input: FaqInput, idempotencyKey: string): Promise<void> {
  return api.post('/faqs', { body: input, idempotencyKey })
}

/** FAQ-03 — 바뀐 칸만 보냄 (둘 다 선택) */
export function updateFaq(id: number, patch: Partial<FaqInput>): Promise<void> {
  return api.patch(`/faqs/${id}`, { body: patch })
}

/** 명세서에 없음 (대조표: FAQ 삭제 요청). 경로는 REST 관례 — BE 확정 전까지 MSW 가짜만 응답 */
export function deleteFaq(id: number): Promise<void> {
  return api.delete(`/faqs/${id}`)
}
