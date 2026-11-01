import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router'
import { useSession } from '@/shared/auth/useSession'
import { hasSession } from '@/shared/auth/session'

/**
 * 로그인 가드 — 로그인 표시(만료 시각)가 없거나 지났으면 로그인 화면으로(로그인 후 돌아올 경로를 state.from에),
 * 승인 전(PENDING) 계정이면 안내 화면으로 (명세상 ACTIVE만 로그인되므로 실서버에선 거의 안 옴 — BE 요청 B1). 역할별 제한은 RequireRole
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const location = useLocation()
  if (!hasSession()) return <Navigate to="/login" replace state={{ from: location.pathname }} />
  return <StatusGate>{children}</StatusGate>
}

// 훅은 조건문 뒤에 못 부르므로 로그인 표시 검사 다음 단계로 분리
function StatusGate({ children }: { children: ReactNode }) {
  const { isLoading, status } = useSession()
  if (isLoading) return null
  if (status === 'PENDING') return <Navigate to="/pending" replace />
  return children
}
