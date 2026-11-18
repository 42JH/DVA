import type { ReactNode } from 'react'
import type { AdminRole } from '@/shared/auth/sessionApi'
import { useSession } from '@/shared/auth/useSession'
import { ForbiddenPage } from '@/app/routes/ForbiddenPage'

/**
 * 역할 가드 — 라우트를 감싸면 허용된 역할만 화면을 본다. 나머지는 '권한 없음' 화면(주소는 그대로)
 * 사용법: { path: 'admins', element: <RequireRole roles={['SYSTEM_ADMIN']}><AdminsPage /></RequireRole> }
 * 버튼 하나만 숨길 때는 이걸 쓰지 말고 훅에서 useSession().isSystemAdmin 으로 (02 대시보드 페르소나 탭처럼)
 */
export function RequireRole({ roles, children }: { roles: AdminRole[]; children: ReactNode }) {
  const { role, isLoading } = useSession()
  if (isLoading) return null // 내 정보를 받는 짧은 동안은 비워 둠 (잘못된 화면이 먼저 번쩍이지 않게)
  if (!role || !roles.includes(role)) return <ForbiddenPage />
  return children
}
