// 로그인 — API-01. 성공하면 서버가 쿠키를 심고 본문엔 만료 시각만 → 그것만 저장. 사용자 정보는 /auth/me (shared/auth)
import { api, type ApiItem } from '@/shared/api/client'
import { saveSession } from '@/shared/auth/session'

export async function login(loginId: string, password: string): Promise<void> {
  const res = await api.post<ApiItem<{ expiresAt: string }>>('/auth/login', {
    body: { loginId, password },
  })
  saveSession(res.data.expiresAt)
}
