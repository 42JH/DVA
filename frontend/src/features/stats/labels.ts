// 02 코드 → 화면 문구 · 색 (컨벤션 6.3: 코드는 api/, 문구는 labels.ts). 표시 이름 = 대시보드 연동 명세 (줄 순서는 서버가 정해서 줌)
import type { CustomerType, ProcessType, Stage } from './api/dashboardApi'
import type { ComplaintTarget } from '@/shared/call/callDto'
import { TARGET_LABEL, type AI_ERROR_TYPES } from '@/shared/call/complaints'

type AiErrorType = (typeof AI_ERROR_TYPES)[number]

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

/** 도넛 조각(stroke) · 범례 네모(bg) 색 — 파랑 계열 짙은 → 옅은, 마지막은 회색 (11/09). 클래스 이름은 글자 그대로 있어야 Tailwind가 만듦 (조립 금지) */
const SHADES = [
  { stroke: 'stroke-[#1f6feb]', bg: 'bg-[#1f6feb]' },
  { stroke: 'stroke-[#4b8cf0]', bg: 'bg-[#4b8cf0]' },
  { stroke: 'stroke-[#78a9f4]', bg: 'bg-[#78a9f4]' },
  { stroke: 'stroke-[#a5c6f8]', bg: 'bg-[#a5c6f8]' },
  { stroke: 'stroke-ops-faint', bg: 'bg-ops-faint' },
]

/** AI 응대 오류 탭 — 네 유형 (11/11 Jira 148) */
export const AI_ERROR: Record<AiErrorType, { label: string; stroke: string; bg: string }> = {
  INFORMATION_RECOGNITION_ERROR: { label: '정보 인식 오류', ...SHADES[0] },
  INTENT_RECOGNITION_ERROR: { label: '용건 인식 오류', ...SHADES[1] },
  SLOW_RESPONSE: { label: '응답 지연', ...SHADES[2] },
  INTERRUPTION: { label: '말 끊김', ...SHADES[3] },
}
/** 고객 불만 탭 — 무엇에 대한 불만인지. none = 대상이 없는 옛 판정 */
export const COMPLAINT_TARGET: Record<
  ComplaintTarget | 'none',
  { label: string; stroke: string; bg: string }
> = {
  ai_service: { label: TARGET_LABEL.ai_service, ...SHADES[0] },
  price_policy: { label: TARGET_LABEL.price_policy, ...SHADES[1] },
  delivery_other: { label: TARGET_LABEL.delivery_other, ...SHADES[2] },
  none: { label: '구분 전', ...SHADES[4] },
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
