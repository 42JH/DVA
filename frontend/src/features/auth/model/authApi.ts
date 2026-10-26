// 로그인 · 세션 Model — AUTH-01 · 02 · 03 (명세서 p9–11). React를 모르는 데이터 · API 층
import { api, type ApiItem } from '../../../shared/api/client'
import { clearToken, setToken, type AccessToken } from '../../../shared/auth/token'

export type AdminRole = 'OPERATOR' | 'SUPERVISOR' | 'SYSTEM_ADMIN'

export interface AdminMe {
  adminUserSeq: number
  loginId: string
  role: AdminRole
  status: 'ACTIVE' | 'PENDING'
}

export const authKeys = {
  me: ['auth', 'me'] as const,
}

/** AUTH-01 — 성공하면 토큰을 저장 */
export async function login(loginId: string, password: string): Promise<void> {
  const res = await api.post<ApiItem<AccessToken>>('/auth/login', { body: { loginId, password } })
  setToken(res.data)
}

/** AUTH-03 */
export async function fetchMe(signal?: AbortSignal): Promise<AdminMe> {
  return (await api.get<ApiItem<AdminMe>>('/auth/me', { signal })).data
}

/** AUTH-02 — 응답 성공 · 실패와 관계없이 로컬 토큰은 지움 (명세서 p10) */
export async function logout(): Promise<void> {
  try {
    await api.post('/auth/logout')
  } finally {
    clearToken()
  }
}
