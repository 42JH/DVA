// 세션 — AUTH-02 로그아웃 · AUTH-03 내 정보 (명세서 p10–11). 여러 기능이 쓰므로 shared/auth (컨벤션 4.4)
// api 역할: React를 모른다. 쿼리 정의(queryOptions)만 여기, useQuery는 useSession.ts에서만
import { queryOptions } from '@tanstack/react-query'
import { ApiError, api, type ApiItem } from '@/shared/api/client'
import { clearSession } from '@/shared/auth/session'

export type AdminRole = 'OPERATOR' | 'SUPERVISOR' | 'SYSTEM_ADMIN'

interface AdminMe {
  adminUserSeq: number
  loginId: string
  name: string // 관리자 이름 '홍길동' (API-04) — 작성자 · 내정보 표시용
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
async function fetchMe(signal?: AbortSignal): Promise<AdminMe> {
  return (await api.get<ApiItem<AdminMe>>('/auth/me', { signal })).data
}

/** API-03 — 204 뒤 로그인 표시를 지움(최근 검색어도 clearSession이 같이). 401은 이미 끝난 세션이라 성공으로.
 * 그 밖의 실패(503 세션 삭제 실패 등)는 서버 세션이 남으므로 지우지 않고 던짐 (성공하는 척 금지, 명세 §10) */
export async function logout(): Promise<void> {
  try {
    await api.post('/auth/logout')
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 401)) throw e
  }
  clearSession()
}
