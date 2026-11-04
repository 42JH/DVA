// 04 · 06 코드 → 화면 문구 (컨벤션 6.3: 코드는 api/, 문구는 labels.ts). 서버 코드는 callDto.ts의 것 그대로
import type { CallActionKind, ComplaintType, ProcessingKind } from './api/callDto'

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

export { KIND_LABEL } from '@/shared/lib/callKind' // 04 상담 유형 칩 (주문 상세도 써서 shared)

/** 처리 내용 블록 머리 — 없는 종류(문의 · 답한 FAQ)는 블록으로 안 그림 (10/29 '미답변만 남기기') */
export const RESULT_LABEL: Partial<Record<ProcessingKind, string>> = {
  ORDER_CREATED: '접수',
  ORDER_CANCELLED: '주문 취소',
  QUESTION_UNANSWERED: 'AI 미답변',
  HANDOFF_REQUESTED: '상담원 이관 요청', // 요청일 뿐 연결 성공이 아님 (명세 §5.3)
}

/** AI 동작 태그 (서버 action 9종 → 저장 · 검색 · 조회 · 전송 · 취소) */
export const ACTION_LABEL: Record<CallActionKind, string> = {
  FIELD_SAVED: '저장',
  PIN_SEARCH: '검색',
  PREVIOUS_ORDER_SEARCH: '검색',
  FAQ_SEARCH: '검색',
  ADDRESS_SEARCH: '검색',
  CUSTOMER_LOOKUP: '조회',
  ORDER_LOOKUP: '조회',
  ORDER_SUBMITTED: '전송',
  ORDER_CANCELLED: '취소',
}
