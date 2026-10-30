// 06 코드 → 화면 문구 (컨벤션 6.3: 코드는 api/, 문구는 labels.ts)
import type { TagKind } from '@/shared/ui'
import type { AiAction, OrderField, Outcome, ResultBlock } from './api/callApi'

/** 통화 결과 (04와 같은 5개) + 태그 색 (04 태그와 같음: 문의 = 흰 바탕 회색 선) */
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

/** 처리 내용 블록 머리 */
export const RESULT_LABEL: Record<ResultBlock['kind'], string> = {
  ACCEPTED: '접수',
  CANCELLED: '주문 취소',
  UNANSWERED: 'AI 미답변',
}

/** AI 동작 태그 */
export const ACTION_LABEL: Record<AiAction['kind'], string> = {
  SAVE: '저장',
  SEARCH: '검색',
  CANCEL: '취소',
  SEND: '전송',
}

/** 저장한 칸 이름 — 'origin.name = 강도윤' → '보내는 분 이름 = 강도윤' (10/30 읽기 쉬운 기록) */
export const FIELD_LABEL: Record<OrderField, string> = {
  'origin.name': '보내는 분 이름',
  'origin.phoneNumber': '보내는 분 전화번호',
  'origin.roadAddress': '보내는 분 주소',
  'origin.detailAddress': '보내는 분 상세주소',
  'destination.name': '받는 분 이름',
  'destination.phoneNumber': '받는 분 전화번호',
  'destination.roadAddress': '받는 분 주소',
  'destination.detailAddress': '받는 분 상세주소',
  pickupRequestedAt: '수거 희망 일시',
  parcels: '품목',
  itemPrice: '물품 가액',
  clientComment: '고객 요청 사항',
  paymentMethodType: '결제 방식',
}
