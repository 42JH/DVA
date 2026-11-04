// 통화 상담 유형 칩 (접수 · 조회 · 취소 · FAQ) — 04 통화 목록 줄 · 06 머리 · 주문 상세 '관련 통화'가 같은 칩 (11/05 사용자: 모양 · 내용 통일)
// 주문 상세(shared/order)도 써서 shared (기능 폴더끼리 import 금지)

/** 04 통화 목록 줄의 상담 유형 */
export type CallKind = 'accept' | 'lookup' | 'cancel' | 'faq'
export const KINDS: CallKind[] = ['accept', 'lookup', 'cancel', 'faq']

/** 04 상담 유형 칩 (11/04 디자인) — 서버 요약 registeredParcelCount · orderLookupCount · cancelledParcelCount · faqAnswerCount */
export const KIND_LABEL: Record<CallKind, string> = {
  accept: '접수',
  lookup: '조회',
  cancel: '취소',
  faq: 'FAQ',
}

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

/** 상담 유형 칩 — 한 것만, 두 번 이상이면 '접수 3' */
export const kindChips = (counts: KindCounts) =>
  KINDS.flatMap((kind) => {
    const n = counts?.[kind] ?? 0
    return n > 0 ? [{ kind, label: n > 1 ? `${KIND_LABEL[kind]} ${n}` : KIND_LABEL[kind] }] : []
  })

/** 칩 모양 (Figma '통화' 11/04 · 11/05 사용자 이미지) — 둥근 알약 · 높이 28 · 폭 76 이상(숫자가 붙어도 같은 폭) · 글자 16. 06 AI 동작 태그도 이 모양 */
export const CHIP_CLASS =
  'grid h-7 min-w-19 shrink-0 place-items-center rounded-full px-3 text-body'
export const KIND_BG: Record<CallKind, string> = {
  accept: 'bg-kind-accept',
  lookup: 'bg-kind-lookup',
  cancel: 'bg-kind-cancel',
  faq: 'bg-kind-faq',
}
