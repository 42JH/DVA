// 주문 상태 코드 → 화면 문구 · 태그 색 (컨벤션 6.3: 코드는 api/, 문구는 labels.ts)
import type { TagKind } from '@/shared/ui'
import type { OrderStatus, StatusGroup } from './api/orderApi'

// 실제 상태 7개 (11/01): '결제 완료' 탭 안에서도 접수 실패가 바로 보이게 줄 태그는 실제 상태로
export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  COLLECTING: '접수 중단',
  notPaid: '결제 대기',
  PAID: '결제 완료',
  SUBMITTING: '디버 접수 중',
  ACCEPTED: '접수 완료',
  SUBMISSION_FAILED: '접수 실패',
  CANCELLED: '주문 취소',
}

// 진행 중 = 남색 선 + 점, 조치 필요(결제 대기 · 접수 실패) = 빨강, 완료 = 파랑, 취소 = 회색
export const ORDER_STATUS_TAG: Record<OrderStatus, TagKind> = {
  COLLECTING: 'live',
  notPaid: 'red',
  PAID: 'blue',
  SUBMITTING: 'live',
  ACCEPTED: 'blue',
  SUBMISSION_FAILED: 'red',
  CANCELLED: 'gray',
}

/** 상태 탭 5개 = 서버 statusGroup (와이어프레임 03 순서) */
export const STATUS_GROUP_LABEL: Record<StatusGroup, string> = {
  ALL: '전체',
  COLLECTING: '접수 중단',
  notPaid: '결제 대기',
  PAID: '결제 완료',
  CANCELLED: '주문 취소',
}
