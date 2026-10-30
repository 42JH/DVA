// 관리자 Access Token 보관 (명세서 1.4: 자동 갱신 없음 — 만료되면 다시 로그인)
import { clearRecentSearches } from '@/shared/lib/recentSearches'

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

/** 세션이 끝나는 모든 길(로그아웃 · 401 · 만료)이 여기를 지남 → 최근 검색어도 같이 지움 (다음 사람에게 안 보이게) */
export const clearToken = (): void => {
  localStorage.removeItem(KEY)
  clearRecentSearches()
}
