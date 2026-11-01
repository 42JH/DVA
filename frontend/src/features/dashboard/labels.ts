// 02 코드 → 화면 문구 (컨벤션 6.3: 코드는 api/, 문구는 labels.ts)
import type { ComplaintKind, Outcome } from './api/dashboardApi'

/** 통화 결과 (04 드롭다운과 같은 말) */
export const OUTCOME_LABEL: Record<Outcome, string> = {
  SUCCESS: '접수 성공',
  FAILED: '접수 실패',
  HANDOFF: '상담원 이관',
  CANCELLED: '주문 취소',
  INQUIRY: '문의',
}

/** 불만 유형 — 카드 줄 순서 그대로 (04 불만 열 · 06 불만 줄과 같은 말). 키는 서버 CallComplaint.type */
export const COMPLAINT_ORDER: ComplaintKind[] = [
  'REPEATED_QUESTION',
  'SPEAKING_TOO_FAST',
  'RECOGNITION_FAILURE',
  'SLOW_RESPONSE',
  'AI_REFUSAL',
]
export const COMPLAINT_LABEL: Record<ComplaintKind, string> = {
  REPEATED_QUESTION: '되묻기 반복',
  SPEAKING_TOO_FAST: '말이 빠름',
  RECOGNITION_FAILURE: '못 알아들음',
  SLOW_RESPONSE: '답답함 · 느림',
  AI_REFUSAL: 'AI라서 거부',
}
