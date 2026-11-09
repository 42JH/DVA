// 02 코드 → 화면 문구 · 색 (컨벤션 6.3: 코드는 api/, 문구는 labels.ts). 표시 이름 = 대시보드 연동 명세 (줄 순서는 서버가 정해서 줌)
import type { ComplaintType, CustomerType, ProcessType, Stage } from './api/dashboardApi'

/** 고객 탭 (명세 §1 — 순서 = 탭 순서) */
export const CUSTOMER_LABEL: Record<CustomerType, string> = {
  ALL: '전체',
  NEW: '신규 고객',
  EXISTING: '기존 고객',
}

/** 이탈 단계 (명세 §2) */
export const STAGE_LABEL: Record<Stage, string> = {
  SENDER_INFO: '발신자 정보',
  RECIPIENT_INFO: '수신자 정보',
  ITEM_INFO: '물품 정보',
  CONFIRMATION: '최종 확인',
  PAYMENT_GUIDANCE: '결제 안내',
  FAQ_ANSWER: 'FAQ 답변',
  ORDER_LOOKUP: '접수 내역 조회',
  ORDER_CANCEL: '주문 취소',
}

/** 불편 유형 (명세 §4) → 이름 · 도넛 조각(stroke) · 범례 네모(bg). 클래스 이름은 글자 그대로 있어야 Tailwind가 만듦 (조립 금지) */
export const COMPLAINT: Record<ComplaintType, { label: string; stroke: string; bg: string }> = {
  // 11/09 v2 색으로: 파랑 계열 짙은 → 옅은, 마지막은 회색
  INFORMATION_RECOGNITION_ERROR: {
    label: '정보 인식 오류',
    stroke: 'stroke-[#1f6feb]',
    bg: 'bg-[#1f6feb]',
  },
  INTENT_RECOGNITION_ERROR: {
    label: '용건 인식 오류',
    stroke: 'stroke-[#4b8cf0]',
    bg: 'bg-[#4b8cf0]',
  },
  UNSUPPORTED_ANSWER: { label: '근거 없는 답변', stroke: 'stroke-[#78a9f4]', bg: 'bg-[#78a9f4]' },
  SLOW_RESPONSE: { label: '응답 지연', stroke: 'stroke-[#a5c6f8]', bg: 'bg-[#a5c6f8]' },
  INTERRUPTION: { label: '말 끊김', stroke: 'stroke-[#cfe0fb]', bg: 'bg-[#cfe0fb]' },
  DISSATISFACTION_EXPRESSION: {
    label: '불만 표현',
    stroke: 'stroke-ops-faint',
    bg: 'bg-ops-faint',
  },
}

/** 응답 대기 처리 유형 (명세 §5) */
export const PROCESS_LABEL: Record<ProcessType, string> = {
  CUSTOMER_LOOKUP: '고객 조회',
  INFORMATION_INPUT: '정보 입력',
  FAQ_LOOKUP: 'FAQ 조회',
  ORDER_LOOKUP: '접수 내역 조회',
  ORDER_CANCEL: '주문 취소',
  ADDRESS_LOOKUP: '주소 조회',
  ORDER_SAVE: '접수 저장',
}
