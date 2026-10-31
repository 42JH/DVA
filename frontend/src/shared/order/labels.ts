// 주문 코드 → 화면 문구 (컨벤션 6.3: 코드는 orderApi, 문구는 labels)
import type { OrderDetail, PaymentMethod, PaymentState } from './orderApi'

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
