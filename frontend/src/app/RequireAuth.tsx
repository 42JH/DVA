import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router'
import { getToken } from '../shared/auth/token'

/** 로그인 안 했으면 로그인 화면으로 (로그인 후 돌아올 경로를 state.from에) */
export function RequireAuth({ children }: { children: ReactNode }) {
  const location = useLocation()
  if (!getToken()) return <Navigate to="/login" replace state={{ from: location.pathname }} />
  return children
}
