// 통화 상태 코드 → 화면 문구 (컨벤션 6.3: 코드는 api/, 문구는 labels.ts)
import type { Call } from './api/callApi'

export type Outcome = '접수 성공' | '접수 실패' | '상담원 이관'

export const OUTCOME_LABEL: Record<NonNullable<Call['outcome']>, Outcome> = {
  SUCCESS: '접수 성공',
  FAILED: '접수 실패',
  HANDOFF: '상담원 이관',
}
