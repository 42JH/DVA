import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router'
import { useSession } from '@/shared/auth/useSession'
import { getToken } from '@/shared/auth/token'

/**
 * 로그인 가드 — 토큰 없으면 로그인 화면으로(로그인 후 돌아올 경로를 state.from에),
 * 승인 전(PENDING) · 비활성화(INACTIVE) 계정이면 안내 화면으로. 역할별 제한은 RequireRole
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const location = useLocation()
  if (!getToken()) return <Navigate to="/login" replace state={{ from: location.pathname }} />
  return <StatusGate>{children}</StatusGate>
}

// 훅은 조건문 뒤에 못 부르므로 토큰 검사 다음 단계로 분리
function StatusGate({ children }: { children: ReactNode }) {
  const { isLoading, status } = useSession()
  if (isLoading) return null
  if (status === 'PENDING') return <Navigate to="/pending" replace />
  if (status === 'INACTIVE') return <Navigate to="/inactive" replace />
  return children
}
