export const CALL_EVENT_KINDS = [
  'UTTERANCE',
  'AI_ACTION',
  'BUSINESS_RESULT',
] as const;
export const AI_ACTIONS = [
  'PIN_SEARCH',
  'PREVIOUS_ORDER_SEARCH',
  'CUSTOMER_LOOKUP',
  'FAQ_SEARCH',
  'FIELD_SAVED',
  'ORDER_SUBMITTED',
  'ORDER_CANCELLED',
  // 기존 생산자의 재전송과 과거 기록을 보존한다. 신규 검색은 위 두 코드를 사용한다.
  'ADDRESS_SEARCH',
  'ORDER_LOOKUP',
] as const;
export const BUSINESS_ACTIONS = [
  'ORDER_CREATED',
  'ORDER_CANCELLED',
  'QUESTION_UNANSWERED',
  'HANDOFF_REQUESTED',
  'INQUIRY',
  'FAQ_ANSWERED',
] as const;
export type CallEventKind = (typeof CALL_EVENT_KINDS)[number];
