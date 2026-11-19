// 08 기업관리 — 코드 → 화면 문구
import type { Member } from '@/features/company/api/companyApi'

// ORG_ADMIN = 기업의 연락 창구 '담당자'(권한 없음 · 여러 명 · 1명 이상). '관리자'는 콘솔 로그인 계정과 섞여서 안 씀
export const MEMBER_ROLE: Record<Member['membership']['role'], string> = {
  MEMBER: '사원',
  ORG_ADMIN: '담당자',
}

/** 사원 등록 오류 reason → 문장 (백엔드 답 11/01). CSV 줄 안내 · 창 한 줄 공용 */
export const MEMBER_REASON: Record<string, string> = {
  CUSTOMER_WITHDRAWN: '탈퇴한 고객의 전화번호라 등록할 수 없습니다.',
  OTHER_COMPANY_MEMBERSHIP: '다른 기업에 소속된 고객의 전화번호입니다.',
  EMPLOYEE_NO_CONFLICT: '이 고객은 이 기업에 다른 사번으로 이미 등록돼 있습니다.',
  PHONE_NUMBER_CONFLICT: '이 사번의 사원과 전화번호 주인이 다릅니다.',
  DUPLICATE_ITEM: '같은 사번이나 전화번호가 두 번 들어 있습니다.',
}

/** 서버 오류 → 누구나 이해할 수 있는 설명 (서버 문구를 그대로 보이지 않음)
 * 상태 코드별로 '무슨 일인지 + 어떻게 하면 되는지'. 행 단위 오류(CSV)는 csvMembers.serverRowErrors가 따로 */
export function errorText(e: unknown, action: '등록' | '저장' | '삭제'): string {
  const status = (e as { status?: number })?.status
  const code = (e as { code?: string })?.code
  // 서버가 이유 코드를 줬으면 그 문장이 가장 정확 (사원 등록 422 · 400)
  const reason = (e as { details?: { reason: string }[] })?.details?.find(
    (d) => MEMBER_REASON[d.reason],
  )
  if (reason) return MEMBER_REASON[reason.reason]!
  if (code === 'REQUEST_IN_PROGRESS')
    return '다른 작업을 처리하는 중이에요. 잠시 뒤 다시 눌러 주세요.'
  switch (status) {
    case 0:
      return '서버에 연결하지 못했어요. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.'
    case 400:
      return `입력한 내용의 형식이 맞지 않아 ${action}하지 못했습니다. 사번, 이름, 전화번호를 확인해 주세요.`
    case 401:
      return '로그인이 끝났어요. 다시 로그인해 주세요.'
    case 403:
      return `이 작업을 할 권한이 없어 ${action}하지 못했습니다.`
    case 404:
      return '기업이나 사원을 찾을 수 없습니다. 이미 삭제됐을 수 있으니 목록을 새로고침해 주세요.'
    case 409:
      return action === '삭제'
        ? '지금은 삭제할 수 없는 상태입니다. 목록을 새로고침한 뒤 다시 시도해 주세요.'
        : `${action}할 수 없는 상태입니다. 다른 기업에 소속된 전화번호이거나, 탈퇴한 고객이거나, 비활성 기업일 수 있어요.`
    case 413:
      return '한 번에 보내는 내용이 너무 많습니다. 사원 수를 나눠서 다시 시도해 주세요.'
    case 422:
      return `등록 조건에 맞지 않아 ${action}하지 못했습니다. 입력한 내용을 다시 확인해 주세요.`
    default:
      return `서버에 잠시 문제가 있어 ${action}하지 못했습니다. 잠시 뒤 다시 시도해 주세요.`
  }
}
