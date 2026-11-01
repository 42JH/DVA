import type { ReactNode } from 'react'
import { Navigate } from 'react-router'
import { hasSession } from '@/shared/auth/session'

/** 로그인 · 회원가입 가드 — 이미 로그인돼 있으면 폼 대신 홈으로 (다른 계정으로 들어가려면 로그아웃 먼저). RequireAuth의 반대 */
export function RequireGuest({ children }: { children: ReactNode }) {
  return hasSession() ? <Navigate to="/" replace /> : children
}
