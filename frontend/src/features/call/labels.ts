// 04 · 06 코드 → 화면 문구 (컨벤션 6.3: 코드는 api/, 문구는 labels.ts). 서버 코드는 callDto.ts의 것 그대로
import type { ComplaintType } from '../../shared/call/callDto'

/** 판정 유형 이름 (06 AI 응대 오류 · 대화 구간). 위 넷은 옛 유형(지난 통화에만), 아래는 새 유형 — 이름은 02 통계와 같음
 *  고객 불만(DISSATISFACTION_EXPRESSION)은 대상 이름으로 보여서(shared/call/complaints) 여기 이름은 거의 안 씀 */
export const COMPLAINT_LABEL: Record<ComplaintType, string> = {
  REPEATED_QUESTION: '되묻기 반복',
  SPEAKING_TOO_FAST: '말이 빠름',
  RECOGNITION_FAILURE: '못 알아들음',
  SLOW_RESPONSE: '응답 지연',
  AI_REFUSAL: 'AI라서 거부',
  INFORMATION_RECOGNITION_ERROR: '정보 인식 오류',
  INTENT_RECOGNITION_ERROR: '용건 인식 오류',
  UNSUPPORTED_ANSWER: '근거 없는 답변',
  INTERRUPTION: '말 끊김',
  DISSATISFACTION_EXPRESSION: '고객 불만',
}
