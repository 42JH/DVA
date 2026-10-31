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
