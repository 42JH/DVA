// 10 관리자 권한 관리 — 코드 → 화면 문구
import type { AdminRole } from '@/shared/auth/sessionApi'
import type { AdminStatus } from '@/features/admin/api/adminApi'

// 디자인의 '슈퍼바이저' = SYSTEM_ADMIN = 최고 관리자
export const ROLE_LABEL: Record<AdminRole, string> = {
  OPERATOR: '일반 관리자',
  SYSTEM_ADMIN: '최고 관리자',
}

/** 탭 순서 · 이름 — 계정 상태 이름 그대로 */
export const ADMIN_TABS: { key: AdminStatus; label: string }[] = [
  { key: 'ACTIVE', label: '활성화' },
  { key: 'INACTIVE', label: '비활성화' },
  { key: 'PENDING', label: '승인 대기' },
]

// 비밀번호 초기화 시 서버가 정하는 값 (명세 3장) — 화면은 안내만, 입력칸 없음
export const RESET_PASSWORD = 'dva1234'
