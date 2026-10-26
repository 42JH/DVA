import { NavLink, Outlet } from 'react-router'
import { useSessionViewModel } from '../features/auth/viewmodel/useSessionViewModel'

// 임시 틀 — 사이드바 · 헤더는 디자인이 나오면 shared/ui 컴포넌트로 교체 (메뉴 = 와이어프레임 사이드바 확정안)
const MENU = [
  ['/', '홈'],
  ['/dashboard', '대시보드'],
  ['/orders', '주문 내역'],
  ['/calls', '통화 내역'],
  ['/inquiries', '통화 문의'],
  ['/companies', '기업관리'],
  ['/personas', '페르소나 관리'],
  ['/faqs', 'FAQ 관리'],
  ['/admins', '관리자 권한 관리'],
  ['/me', '내 정보'],
] as const

export function AppLayout() {
  const { me, logout } = useSessionViewModel()

  return (
    <div className="flex min-h-full">
      <nav className="flex w-sidebar flex-col gap-2 border-r border-line p-4">
        {MENU.map(([to, label]) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              `rounded-lg px-3 py-2 ${isActive ? 'bg-action-soft font-bold text-action' : 'text-sub'}`
            }
          >
            {label}
          </NavLink>
        ))}
        <span className="mt-auto text-caption text-muted">{me?.loginId}</span>
        <button type="button" onClick={logout} className="text-left text-label text-sub">
          로그아웃
        </button>
      </nav>
      <main className="flex-1 p-content">
        <Outlet />
      </main>
    </div>
  )
}
