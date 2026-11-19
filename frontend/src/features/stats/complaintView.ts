// 통계 §4 [AI 응대 오류 | 고객 불만] 세기 (Jira 148) — React · API를 모르는 계산만 (홈 · 통계가 같이 씀, 테스트가 바로 부름)
import type { ComplaintCalls } from './api/dashboardApi'
import { maxIndex, num, one, pctText } from './format'
import { AI_ERROR, COMPLAINT_TARGET } from './labels'
import { toCallRow, type CallListItemDto } from '@/shared/call/callDto'
import { AI_ERROR_TYPES, splitComplaints, TARGETS } from '@/shared/call/complaints'

/** §4 — [AI 응대 오류 | 고객 불만] 탭 (Jira 148). 분모 = 서버의 판정 완료 통화, 분자 · 도넛 = 불만 있는 통화 목록을 화면에서 셈
 *  탭 값 = 그 갈래가 하나라도 있는 통화 비율, 도넛 = 유형(대상)별 통화 수(한 통화의 여러 유형은 각각). 범례 색칠 = 가장 많은 것 */
export function complaintView(d: ComplaintCalls, calls: CallListItemDto[]) {
  const judged = calls.map((c) => splitComplaints(toCallRow(c).complaints))
  const count = (hit: (j: (typeof judged)[number]) => boolean) => judged.filter(hit).length
  const tab = <K extends string>(
    key: string,
    label: string,
    n: number,
    parts: { key: K; label: string; stroke: string; bg: string; value: number }[],
  ) => {
    const total = parts.reduce((a, p) => a + p.value, 0)
    const hot = maxIndex(parts.map((p) => p.value))
    return {
      key,
      label,
      value: one(d.assessedCallCount ? (n / d.assessedCallCount) * 100 : null),
      ratio: `${num(d.assessedCallCount)}통화 중 ${num(n)}통화`,
      total: num(total),
      slices: parts.map((p, i) => ({
        ...p,
        count: num(p.value),
        share: pctText(total ? (p.value / total) * 100 : null),
        hot: total > 0 && i === hot,
      })),
    }
  }
  return {
    tabs: [
      tab(
        'ai',
        'AI 응대 오류',
        count((j) => j.errors.length > 0),
        AI_ERROR_TYPES.map((t) => ({
          key: t,
          ...AI_ERROR[t],
          value: count((j) => j.errors.some((e) => e.type === t)),
        })),
      ),
      tab(
        'customer',
        '고객 불만',
        count((j) => j.customer.length > 0),
        TARGETS.map((k) => ({
          key: k,
          ...COMPLAINT_TARGET[k],
          value: count((j) => j.customer.some((c) => c.target === k)),
        })),
      ),
    ],
  }
}
