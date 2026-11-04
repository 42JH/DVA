// 주문 코드 → 화면 문구 (컨벤션 6.3: 코드는 orderApi, 문구는 labels)
import type { OrderDetail, PaymentMethod, PaymentState } from './orderApi'
import type { OrderStatusDto } from './orderDto'

/** 주문번호 'DV-00001' (Figma '주문' 11/04) — 서버 주문 번호(orderSeq)를 5자리로 */
export const orderNo = (orderSeq: number) => `DV-${String(orderSeq).padStart(5, '0')}`

/** 상태 묶음 = 서버 statusGroup (11/01) — 03 목록 칩 · '주문 상태' 고르기 · 주문 상세 머리 칩 (Figma '주문' 11/04 문구) */
export type OrderGroup = 'COLLECTING' | 'notPaid' | 'PAID' | 'SUBMISSION_FAILED' | 'CANCELLED'
export const ORDER_GROUP_LABEL: Record<OrderGroup, string> = {
  COLLECTING: '미완료 주문',
  notPaid: '결제 대기',
  PAID: '결제 완료',
  SUBMISSION_FAILED: '접수 실패', // 디자인에 없는 묶음 (서버 11/01)
  CANCELLED: '주문 취소',
}
/** 실제 상태 8개 → 묶음 (서버 규칙: 결제 완료 = PAID · SUBMITTING · ACCEPTED, 접수 실패 = 재시도 중 실패 · 최종 실패) */
export const ORDER_GROUP: Record<OrderStatusDto, OrderGroup> = {
  COLLECTING: 'COLLECTING',
  notPaid: 'notPaid',
  PAID: 'PAID',
  SUBMITTING: 'PAID',
  ACCEPTED: 'PAID',
  SUBMITTING_FAILED: 'SUBMISSION_FAILED',
  SUBMISSION_FAILED: 'SUBMISSION_FAILED',
  CANCELLED: 'CANCELLED',
}

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  MONTHLY: '월정산',
  GROUP_CARD: '그룹카드',
  PERSONAL_CARD: '개인카드',
  BRANCH_VISIT: '지점 방문',
}
export const PAYMENT_STATE_LABEL: Record<PaymentState, string> = {
  PAID: '결제 완료',
  UNPAID: '결제 대기',
  CANCELLED_BEFORE_PAYMENT: '결제 전 취소',
}

/** 주문 상세 '관련 통화' 줄: 구분 태그 · 내용 */
export const RELATED_CALL_LABEL: Record<
  OrderDetail['relatedCalls'][number]['kind'],
  { tag: string; text: string }
> = {
  ACCEPT: { tag: '접수', text: '새 주문 접수' },
  CANCEL: { tag: '취소', text: '주문 취소' },
}
