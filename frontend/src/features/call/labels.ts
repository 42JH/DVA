// 04 · 06 코드 → 화면 문구 (컨벤션 6.3: 코드는 api/, 문구는 labels.ts). 서버 코드는 callDto.ts의 것 그대로
import type { ComplaintType } from '../../shared/call/callDto'

/** 불만 유형 (04 불만 열 · 06 불만 줄 같은 말). 아래 다섯은 대시보드 연동 명세 §4의 새 유형 — 이름은 02 대시보드와 같음 */
export const COMPLAINT_LABEL: Record<ComplaintType, string> = {
  REPEATED_QUESTION: '되묻기 반복',
  SPEAKING_TOO_FAST: '말이 빠름',
  RECOGNITION_FAILURE: '못 알아들음',
  SLOW_RESPONSE: '답답함 · 느림',
  AI_REFUSAL: 'AI라서 거부',
  INFORMATION_RECOGNITION_ERROR: '정보 인식 오류',
  INTENT_RECOGNITION_ERROR: '용건 인식 오류',
  UNSUPPORTED_ANSWER: '근거 없는 답변',
  INTERRUPTION: '말 끊김',
  DISSATISFACTION_EXPRESSION: '불만 표현',
}
