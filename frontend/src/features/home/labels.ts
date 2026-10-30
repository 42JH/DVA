// 오늘 숫자 카드 → 화면 문구 (컨벤션 6.3)
export type TodayCardKind = 'SUCCESS' | 'FAILED' | 'HANDOFF' | 'COMPLAINT'

export const TODAY_CARD_LABEL: Record<TodayCardKind, string> = {
  SUCCESS: '접수 성공',
  FAILED: '접수 실패',
  HANDOFF: '상담원 이관',
  COMPLAINT: '불만 통화',
}
