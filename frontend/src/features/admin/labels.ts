// 10 관리자 권한 관리 — 코드 → 화면 문구
import type { AdminRole } from '@/shared/auth/sessionApi'
import type { AdminStatus } from '@/features/admin/api/adminApi'

// 디자인의 '슈퍼바이저' = SYSTEM_ADMIN = 최고 관리자 (11/01 결정)
export const ROLE_LABEL: Record<AdminRole, string> = {
  OPERATOR: '일반 관리자',
  SYSTEM_ADMIN: '최고 관리자',
}

/** 탭 순서 (11/02 사용자: 관리자 먼저 — 디자인은 승인 대기 · 관리자 · 비활성화) */
export const ADMIN_TABS: { key: AdminStatus; label: string }[] = [
  { key: 'ACTIVE', label: '관리자' },
  { key: 'PENDING', label: '승인 대기' },
  { key: 'INACTIVE', label: '비활성화' },
]

// 비밀번호 초기화 시 서버가 정하는 값 (명세 3장) — 화면은 안내만, 입력칸 없음
export const RESET_PASSWORD = 'dva1234'
