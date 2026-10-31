// 로그인 표시 — 세션 자체는 HttpOnly 쿠키 dva_session (API 연동 상세명세 1장, JS는 못 읽음)
// 여기엔 로그인 응답의 만료 시각만 둠: 화면을 열 때 바로 '로그인 중인지' 판단용. 진짜 확인은 서버(/auth/me 401)
// 세션은 9시간 고정이고 조회로 연장되지 않아서 이 시각 = 서버 만료 시각
import { clearRecentSearches } from '@/shared/lib/recentSearches'

const KEY = 'dva.sessionExpiresAt'

export function hasSession(): boolean {
  try {
    const expiresAt = localStorage.getItem(KEY)
    if (expiresAt && Date.parse(expiresAt) > Date.now()) return true
  } catch {
    // 저장소를 못 쓰면 로그인 안 된 것으로
  }
  clearSession()
  return false
}

/** 로그인 응답 data.expiresAt (ISO 8601) */
export const saveSession = (expiresAt: string): void => localStorage.setItem(KEY, expiresAt)

/** 세션이 끝나는 모든 길(로그아웃 · 401 · 만료)이 여기를 지남 → 최근 검색어도 같이 지움 (다음 사람에게 안 보이게) */
export const clearSession = (): void => {
  try {
    localStorage.removeItem(KEY)
    localStorage.removeItem('dva.accessToken') // 예전(Bearer) 방식으로 남은 값 정리
  } catch {
    // 저장소를 못 쓰면 지울 것도 없음
  }
  clearRecentSearches()
}
