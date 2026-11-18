// 통화 상담 유형 칩 (접수 · 조회 · 취소 · FAQ) — 04 통화 목록 줄 · 06 머리 · 주문 상세 '관련 통화'가 같은 칩 (11/05 사용자: 모양 · 내용 통일)
// 주문 상세(shared/order)도 써서 shared (기능 폴더끼리 import 금지)

/** 04 통화 목록 줄의 상담 유형 */
export type CallKind = 'accept' | 'lookup' | 'cancel' | 'faq'
export const KINDS: CallKind[] = ['accept', 'lookup', 'cancel', 'faq']

/** 통화 요약(analysis) 중 상담 유형 횟수 칸 — 통화 목록 · 상세 응답 같은 이름 */
export interface KindCountsDto {
  registeredParcelCount?: number | null
  orderLookupCount?: number | null
  cancelledParcelCount?: number | null
  faqAnswerCount?: number | null
}
export type KindCounts = Record<CallKind, number | null> | null // null = 분석 전

/** 통화 요약 → 상담 유형 횟수. 분석 전이면 null, 못 모은 칸은 null(0으로 보지 않음) */
export const countsOf = (a: KindCountsDto | null): KindCounts =>
  a && {
    accept: a.registeredParcelCount ?? null,
    lookup: a.orderLookupCount ?? null,
    cancel: a.cancelledParcelCount ?? null,
    faq: a.faqAnswerCount ?? null,
  }
