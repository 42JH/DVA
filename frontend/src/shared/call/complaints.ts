// 통화 판정 결과 나누기 (Jira 148, 11/11 백엔드 !476): 고객 불만 · AI 응대 오류만 보임
// 최신 판정본 기준만 (11/11 사용자: 과거 판정은 무시) — 대상(target) 없는 고객 불만 · 옛 유형(되묻기 반복 등) · 근거 없는 답변은 화면에서 뺌(서버 저장은 그대로)
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
export const LEVEL_TEXT: Record<ComplaintLevel, string> = {
  explicit: '강하게 항의함',
  mild: '가볍게 불편을 말함',
}

type Judged = { type: ComplaintType; target: ComplaintTarget | null }
/** 최신 판정본의 고객 불만 = 대상이 있는 것 */
export const isCustomerComplaint = <T extends Judged>(c: T): c is T & { target: ComplaintTarget } =>
  c.type === 'DISSATISFACTION_EXPRESSION' && c.target !== null
const isAiError = (c: Judged) => (AI_ERROR_TYPES as readonly ComplaintType[]).includes(c.type)

/** 고객 불만(대상 있는 것) · AI 응대 오류(새 네 유형)로 나눔 — 나머지는 버림 */
export function splitComplaints<T extends Judged>(list: T[]) {
  return { customer: list.filter(isCustomerComplaint), errors: list.filter(isAiError) }
}

/** 고객 불만을 대상마다 하나로 (TARGETS 순서) — 목록 칩 · 통계 */
export function byTarget<T extends Judged>(list: T[]) {
  return list
    .filter(isCustomerComplaint)
    .filter((c, i, all) => all.findIndex((x) => x.target === c.target) === i)
    .sort((a, b) => TARGETS.indexOf(a.target) - TARGETS.indexOf(b.target))
}
