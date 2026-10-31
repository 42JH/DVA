// 세션 — AUTH-02 로그아웃 · AUTH-03 내 정보 (명세서 p10–11). 여러 기능이 쓰므로 shared/auth (컨벤션 4.4)
// api 역할: React를 모른다. 쿼리 정의(queryOptions)만 여기, useQuery는 useSession.ts에서만
import { queryOptions } from '@tanstack/react-query'
import { api, type ApiItem } from '@/shared/api/client'
import { clearSession } from '@/shared/auth/session'

export type AdminRole = 'OPERATOR' | 'SUPERVISOR' | 'SYSTEM_ADMIN'

export interface AdminMe {
  adminUserSeq: number
  loginId: string
  role: AdminRole
  status: 'ACTIVE' | 'PENDING' | 'INACTIVE' // INACTIVE = 최고 관리자가 비활성화 (10/30 00 디자인)
}

export const sessionQueries = {
  all: () => ['session'] as const,
  me: () =>
    queryOptions({
      queryKey: [...sessionQueries.all(), 'me'],
      queryFn: ({ signal }) => fetchMe(signal),
    }),
}

/** AUTH-03 */
export async function fetchMe(signal?: AbortSignal): Promise<AdminMe> {
  return (await api.get<ApiItem<AdminMe>>('/auth/me', { signal })).data
}

/** AUTH-02 — 응답 성공 · 실패와 관계없이 로그인 표시는 지움. 최근 검색어도 clearSession이 같이 지움 */
export async function logout(): Promise<void> {
  try {
    await api.post('/auth/logout')
  } finally {
    clearSession()
  }
}
