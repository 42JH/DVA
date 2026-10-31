// 주문 상태 코드 → 화면 문구 · 태그 색 (컨벤션 6.3: 코드는 api/, 문구는 labels.ts)
import type { TagKind } from '@/shared/ui'
import type { OrderStatus, PaymentMethod } from './api/orderApi'

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  IN_PROGRESS: '접수 중',
  PAYMENT_PENDING: '결제 대기',
  PAID: '결제 완료',
  CANCELLED: '주문 취소',
}

// 와이어프레임 03: 결제 완료 = 파랑, 결제 대기 = 빨강(조치 필요), 주문 취소 = 회색, 접수 중 = 남색 선 + 점(진행 중)
export const ORDER_STATUS_TAG: Record<OrderStatus, TagKind> = {
  IN_PROGRESS: 'live',
  PAYMENT_PENDING: 'red',
  PAID: 'blue',
  CANCELLED: 'gray',
}

// 와이어프레임 03 주문 추가 순서 그대로
export const PAYMENT_LABEL: Record<PaymentMethod, string> = {
  credit: '월정산',
  groupBilling: '그룹카드',
  billing: '개인카드',
}
