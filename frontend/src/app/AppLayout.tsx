import { Outlet } from 'react-router'
import { useSessionViewModel } from '../features/auth/viewmodel/useSessionViewModel'
import { Sidebar } from '../shared/ui'

// 로그인 뒤 틀: 사이드바 222 + 본문(안쪽 32). 화면 머리는 각 화면이 <PageHeader>로 그림
export function AppLayout() {
  const { me, logout } = useSessionViewModel()
  return (
    <div className="flex h-full">
      <Sidebar userLabel={me?.loginId} onLogout={logout} />
      <main className="min-w-0 flex-1 overflow-auto p-content">
        <Outlet />
      </main>
    </div>
  )
}
