// 08 기업관리 — 코드 → 화면 문구
import type { Member } from '@/features/company/api/companyApi'

// ORG_ADMIN = 기업 대표자 표시(권한 없음 · 여러 명). 디자인의 '기업 관리자' → '대표자' (11/01 결정 a: 로그인 '관리자 계정'과 혼동 방지)
export const MEMBER_ROLE: Record<Member['membership']['role'], string> = {
  MEMBER: '일반 구성원',
  ORG_ADMIN: '대표자',
}

/** 기업 월결제 자격 → 목록 '월결제' 열 (11/01 디자인 추가 b) */
export const BILLING_LABEL = (enabled: boolean) => (enabled ? '사용' : '미사용')

/** 기업 · 사원 status INACTIVE 태그 (11/01 디자인 추가 d · e) */
export const INACTIVE_TAG = '비활성'

/** 서버 오류 → 누구나 이해할 수 있는 설명 (11/01 결정: 서버 문구를 그대로 보이지 않음)
 * 상태 코드별로 '무슨 일인지 + 어떻게 하면 되는지'. 행 단위 오류(CSV)는 csvMembers.serverRowErrors가 따로 */
export function errorText(e: unknown, action: '등록' | '저장' | '삭제'): string {
  const status = (e as { status?: number })?.status
  const code = (e as { code?: string })?.code
  if (code === 'REQUEST_IN_PROGRESS')
    return '다른 작업을 처리하는 중이에요. 잠시 뒤 다시 눌러 주세요.'
  switch (status) {
    case 0:
      return '서버에 연결하지 못했어요. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.'
    case 400:
      return `입력한 내용의 형식이 맞지 않아 ${action}하지 못했습니다. 사번 · 이름 · 전화번호를 확인해 주세요.`
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
