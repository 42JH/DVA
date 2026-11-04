// 04 · 06 코드 → 화면 문구 (컨벤션 6.3: 코드는 api/, 문구는 labels.ts). 서버 코드는 callDto.ts의 것 그대로
import type { TagKind } from '@/shared/ui'
import type {
  CallActionKind,
  CallKind,
  ComplaintType,
  Outcome,
  ProcessingKind,
} from './api/callDto'

/** 통화 결과 (04 · 02와 같은 5개) + 태그 색 (문의 = 흰 바탕 회색 선) */
export const OUTCOME_LABEL: Record<Outcome, string> = {
  HANDOFF: '상담원 이관',
  SUCCESS: '접수 성공',
  FAILED: '접수 실패',
  CANCELLED: '주문 취소',
  INQUIRY: '문의',
}
export const OUTCOME_TAG: Record<Outcome, TagKind> = {
  HANDOFF: 'gray',
  SUCCESS: 'blue',
  FAILED: 'red',
  CANCELLED: 'gray',
  INQUIRY: 'outline',
}
/** 분석이 아직 안 온 통화(analysis = null) — 성공 · 불만 없음으로 보지 않음 (명세 §5.1) */
export const NO_ANALYSIS = { label: '분석 전', tag: 'outline' as TagKind }

/** 불만 유형 (02 대시보드 · 04 불만 열 · 06 불만 줄 같은 말) */
export const COMPLAINT_LABEL: Record<ComplaintType, string> = {
  REPEATED_QUESTION: '되묻기 반복',
  SPEAKING_TOO_FAST: '말이 빠름',
  RECOGNITION_FAILURE: '못 알아들음',
  SLOW_RESPONSE: '답답함 · 느림',
  AI_REFUSAL: 'AI라서 거부',
}

/** 04 통화 목록 상담 유형 칩 (11/04 디자인) — 서버 요약 registeredParcelCount · orderLookupCount · cancelledParcelCount · faqAnswerCount */
export const KIND_LABEL: Record<CallKind, string> = {
  accept: '접수',
  lookup: '조회',
  cancel: '취소',
  faq: 'FAQ',
}

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
