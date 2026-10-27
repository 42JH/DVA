// 로그인 — AUTH-01 (명세서 p9). 성공하면 토큰 저장. 세션(내 정보 · 로그아웃)은 shared/auth
import { api, type ApiItem } from '@/shared/api/client'
import { setToken, type AccessToken } from '@/shared/auth/token'

export async function login(loginId: string, password: string): Promise<void> {
  const res = await api.post<ApiItem<AccessToken>>('/auth/login', { body: { loginId, password } })
  setToken(res.data)
}
