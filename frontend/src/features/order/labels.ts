// 주문 상태 코드 → 화면 문구 (컨벤션 6.3: 코드는 api/, 문구는 labels.ts). 칩 · 주문번호는 상세 창과 같이 써서 shared/order/labels
import { ORDER_GROUP_LABEL } from '@/shared/order/labels'
import type { StatusGroup } from './api/orderApi'

/** '주문 상태' 고르기 = 전체 + 상태 묶음 (서버 statusGroup) */
export const STATUS_GROUP_LABEL: Record<StatusGroup, string> = { ALL: '전체', ...ORDER_GROUP_LABEL }

/** 주문 추가 · 수정 서버 오류 → 누구나 이해할 수 있는 설명 (서버 문구 · 코드를 그대로 보이지 않음, 11/01 기업관리와 같은 기준) */
export function orderErrorText(e: unknown, action: '접수' | '저장' | '취소'): string {
  const status = (e as { status?: number })?.status
  const code = (e as { code?: string })?.code
  if (code === 'REQUEST_IN_PROGRESS' || status === 409)
    return '같은 요청을 처리하는 중이에요. 잠시 뒤 목록에서 확인해 주세요.'
  switch (status) {
    case 0:
      return '서버에 연결하지 못했어요. 목록에서 들어갔는지 먼저 확인한 뒤 다시 시도해 주세요.'
    case 400:
      return `입력한 내용의 형식이 맞지 않아 ${action}하지 못했습니다. 칸을 다시 확인해 주세요.`
    case 401:
      return '로그인이 끝났어요. 다시 로그인해 주세요.'
    case 403:
      return `결제 자격이나 권한이 없어 ${action}하지 못했습니다. 월결제 · 그룹결제는 기업 · 부서 자격이 필요해요.`
    case 404:
      return '주문이나 고객을 찾을 수 없습니다. 목록을 새로고침해 주세요.'
    case 422:
      return `주소 · 물품 · 금액 조건이 맞지 않아 ${action}하지 못했습니다. 칸을 다시 확인해 주세요.`
    case 503:
      return `디버 접수 설정 문제로 ${action}하지 못했습니다. 백엔드 담당자에게 알려 주세요.`
    default:
      return `서버에 잠시 문제가 있어 ${action}하지 못했습니다. 잠시 뒤 다시 시도해 주세요.`
  }
}
