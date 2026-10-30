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

/** 불만 유형 — 카드 줄 순서 그대로 (04 불만 열 · 06 불만 줄과 같은 말) */
export const COMPLAINT_ORDER: ComplaintKind[] = [
  'REPEAT',
  'TOO_FAST',
  'MISHEARD',
  'SLOW',
  'REFUSED_AI',
]
export const COMPLAINT_LABEL: Record<ComplaintKind, string> = {
  REPEAT: '되묻기 반복',
  TOO_FAST: '말이 빠름',
  MISHEARD: '못 알아들음',
  SLOW: '답답함 · 느림',
  REFUSED_AI: 'AI라서 거부',
}
