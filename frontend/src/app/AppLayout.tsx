import { Outlet } from 'react-router'
import { useSession } from '@/shared/auth/useSession'
import { Sidebar } from '@/shared/ui'

// 로그인 뒤 틀: 사이드바 222 + 본문(안쪽 32). 화면 머리는 각 화면이 <PageHeader>로 그림
export function AppLayout() {
  const { me, isSystemAdmin, logout } = useSession()
  return (
    <div className="flex h-full">
      <Sidebar
        userLabel={me?.loginId}
        onLogout={logout}
        canSee={(to) => to !== '/admins' || isSystemAdmin} // 10 관리자 권한 관리는 슈퍼바이저만 (RequireRole과 짝)
      />
      <main className="min-w-0 flex-1 overflow-auto p-content">
        <Outlet />
      </main>
    </div>
  )
}
