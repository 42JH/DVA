// 통화 상태 (React 모름 — 테스트에서 바로 부름)
import type { Tone } from '@/v2/ui'

/** 통화 상태 = 통화 진행 + AI 분석 진행 (통화 결과는 고객 용건 · 접수 주문 칸에)
 *  통화 중 → 분석 중 → 분석 완료 · 분석 실패. 분석 상태는 백엔드 판정 그대로 (11/08 — 녹취 · 시간으로 짐작하지 않음)
 *  PENDING은 분석 중 · 재전송 · 알림 누락을 구별 못 함 — AI가 실패를 알려야 FAILED */
export function callState(d: {
  startedAt: string | null
  endedAt: string | null
  analysis: unknown
  analysisStatus: 'PENDING' | 'COMPLETED' | 'FAILED'
}): {
  label: string
  tone: Tone
} {
  if (d.startedAt && !d.endedAt) return { label: '통화 중', tone: 'route' }
  if (d.analysis || d.analysisStatus === 'COMPLETED') return { label: '분석 완료', tone: 'done' }
  if (d.analysisStatus === 'FAILED') return { label: '분석 실패', tone: 'wait' }
  return { label: '분석 중', tone: 'idle' }
}

/** 고객 소속 — 기업명 · 개인 · 고객 미확인('') (백엔드 11/08 표) */
export const memberOf = (d: { organizationName: string | null; customerSeq: number | null }) =>
  d.organizationName ?? (d.customerSeq ? '개인' : '')
