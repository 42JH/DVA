// 통화 판정 결과 나누기 (Jira 148, 11/11 백엔드 !476): 고객 불만 · AI 응대 오류 · 화면에 안 보이는 것
// 통화 목록 · 상세, 통계, 홈이 같은 기준으로 씀
import type { ComplaintLevel, ComplaintTarget, ComplaintType } from './callDto'

/** AI 응대 오류 네 유형 — 순서 = 통계 도넛 순서 */
export const AI_ERROR_TYPES = [
  'INFORMATION_RECOGNITION_ERROR',
  'INTENT_RECOGNITION_ERROR',
  'SLOW_RESPONSE',
  'INTERRUPTION',
] as const satisfies ComplaintType[]

/** 고객 불만 대상 — 순서 = 목록 칩 · 통계 범례 순서 */
export const TARGETS = ['ai_service', 'price_policy', 'delivery_other'] as const
export const TARGET_LABEL: Record<ComplaintTarget, string> = {
  ai_service: 'AI 응대',
  price_policy: '요금 정책',
  delivery_other: '배송',
}
/** 대상이 없는 불만 = !476 전 판정이라 새 기준으로 다시 분석하기 전 → '분석 전' (목록 칩 · 상세 · 통계 같은 말, 11/11 사용자) */
export const targetLabel = (t: ComplaintTarget | null) => (t ? TARGET_LABEL[t] : '분석 전')
export const LEVEL_TEXT: Record<ComplaintLevel, string> = {
  explicit: '강하게 항의함',
  mild: '가볍게 불편을 말함',
}

type Judged = { type: ComplaintType; target: ComplaintTarget | null }
export const isCustomerComplaint = (c: Judged) => c.type === 'DISSATISFACTION_EXPRESSION'

/** 고객 불만 · AI 응대 오류(새 네 유형 + 옛 유형)로 나눔. 근거 없는 답변은 정확도 확인 전이라 화면에서 뺌 (11/11 사용자 — 서버 저장은 그대로) */
export function splitComplaints<T extends Judged>(list: T[]) {
  const shown = list.filter((c) => c.type !== 'UNSUPPORTED_ANSWER')
  return {
    customer: shown.filter(isCustomerComplaint),
    errors: shown.filter((c) => !isCustomerComplaint(c)),
  }
}

/** 고객 불만을 대상마다 하나로 (TARGETS 순서, 대상 없는 건 맨 뒤) — 목록 칩 · 통계 */
export function byTarget<T extends Judged>(list: T[]): T[] {
  const rank = (c: T) => (c.target ? TARGETS.indexOf(c.target) : TARGETS.length)
  return list
    .filter(isCustomerComplaint)
    .filter((c, i, all) => all.findIndex((x) => x.target === c.target) === i)
    .sort((a, b) => rank(a) - rank(b))
}
