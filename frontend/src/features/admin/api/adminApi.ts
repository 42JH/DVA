// 10 관리자 권한 관리 — API-06~10 /admins (API 연동 상세명세 3장). SYSTEM_ADMIN 전용. React를 모르는 데이터 · API 층
// 성공은 모두 204(본문 없음) → 화면은 목록을 다시 받음. 권한 변경(PATCH /admins/{id}/role)은 안 씀 (11/01 결정: SUPERVISOR를 화면에서 안 다룸)
import { queryOptions } from '@tanstack/react-query'
import { api } from '@/shared/api/client'
import type { AdminRole } from '@/shared/auth/sessionApi'

export type AdminStatus = 'ACTIVE' | 'PENDING' | 'INACTIVE'

/** AdminResponse — 전화번호 · 이메일은 서버에 없음 (디자인과 다름, backend-todo 9) */
export interface Admin {
  adminUserSeq: number
  loginId: string
  name: string
  role: AdminRole
  status: AdminStatus
  createdAt: string // 가입 신청 시각 ISO 8601
  lastLoginAt: string | null // 로그인한 적 없으면 null
}

/** AdminList — 서버 키는 total_count (공용 ApiList의 totalCount와 이름이 달라 여기서 따로 정의) */
interface AdminList {
  data: Admin[]
  hasNext: boolean
  total_count: number // 필터 적용 후 · limit/offset 적용 전 전체 건수 → 탭 건수 · 쪽 수
}

interface AdminListQuery {
  status: AdminStatus
  limit: number // 1~100
  offset: number
  q?: string // 이름 · 로그인 아이디 부분 검색 (11/08)
}

export const adminQueries = {
  all: () => ['admins'] as const,
  list: (q: AdminListQuery) =>
    queryOptions({
      queryKey: [...adminQueries.all(), 'list', q],
      queryFn: ({ signal }) => api.get<AdminList>('/admins', { query: { ...q }, signal }),
    }),
}

/** 상태 바꾸기 — PATCH /admins/{id} { status } (204)
 * 가입 승인 = PENDING → ACTIVE, 비활성화 · 활성화 = OPERATOR · SUPERVISOR의 ACTIVE ↔ INACTIVE (11/01 백엔드 반영)
 * 최고 관리자는 서버가 거절 · 비활성화하면 대상의 모든 세션이 끊김(재활성화해도 이전 세션은 복구 안 됨) */
export const setAdminStatus = (id: number, status: 'ACTIVE' | 'INACTIVE'): Promise<void> =>
  api.patch(`/admins/${id}`, { body: { status } })

/** 비밀번호 초기화 — 본문 없음. 서버가 초기 비밀번호(dva1234)로 바꾸고 대상의 세션을 끊음 */
export const resetAdminPassword = (id: number): Promise<void> => api.patch(`/admins/${id}/password`)

/** 계정 삭제 · 가입 거절 — 같은 API. 실제 삭제라 확인 창 뒤에만. SYSTEM_ADMIN 계정은 서버가 거절 */
export const deleteAdmin = (id: number): Promise<void> =>
  api.delete('/admins', { body: { adminUserSeqs: [id] } })
