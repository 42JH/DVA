// 관리자 Access Token 보관 (명세서 1.4: 자동 갱신 없음 — 만료되면 다시 로그인)
const KEY = 'dva.accessToken'

/** AUTH-01 응답 data 그대로 */
export interface AccessToken {
  accessToken: string
  expiresAt: string // ISO 8601
}

export function getToken(): string | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const token = JSON.parse(raw) as AccessToken
    if (Date.parse(token.expiresAt) > Date.now()) return token.accessToken
  } catch {
    // 값이 깨졌으면 지우고 다시 로그인
  }
  clearToken()
  return null
}

export const setToken = (token: AccessToken): void =>
  localStorage.setItem(KEY, JSON.stringify(token))

export const clearToken = (): void => localStorage.removeItem(KEY)
