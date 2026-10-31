// 08 기업관리 — API-36~40 기업 · API-45~48 구성원 (API 연동 상세명세 7장). React를 모르는 데이터 · API 층
// 부서 · 기업 공유 주소록 · 월 사용액 API는 디자인에 화면이 없어 안 씀 (11/01 결정)
import { queryOptions } from '@tanstack/react-query'
import { api, type ApiItem } from '@/shared/api/client'

export type ActiveStatus = 'ACTIVE' | 'INACTIVE'

/** OrganizationResponse — 사원 수 · 등록일은 서버에 없음 (backend-todo 10) */
export interface Company {
  organizationSeq: number
  name: string
  status: ActiveStatus
  monthlyBillingEnabled: boolean // 기업 월결제 자격 → 목록 '월결제' 열 (11/01 디자인 추가 b)
}

/** CustomerAddress — 사원 주소는 고객 정보에 있음. 보기만 (11/01 결정 A: 좌표가 필수라 화면에서 못 넣음) */
export interface CustomerAddress {
  roadAddress: string
  jibunAddress: string
  detailAddress?: string
  dongName: string
  postalCode: string
  latitude: number
  longitude: number
}

/** MemberView = 소속(membership) + 고객(customer) */
export interface Member {
  membership: {
    membershipSeq: number // 수정 · 삭제 키
    customerSeq: number
    organizationSeq: number
    departmentSeq: number | null
    employeeNo: string // 사번 — 앞자리 0 보존(문자열)
    role: 'MEMBER' | 'ORG_ADMIN' // ORG_ADMIN = 대표자 표시, 권한 없음 · 여러 명 가능
    status: ActiveStatus
  }
  customer: {
    customerSeq: number
    name: string
    phoneNumber: string // 숫자만 '01012345678'
    address: CustomerAddress | null
    status: 'ACTIVE' | 'WITHDRAWN'
  }
}

/** 목록 응답 — 서버 키 total_count (공용 ApiList는 totalCount라 여기서 따로, 관리자 목록과 같은 이유) */
export interface Page<T> {
  data: T[]
  hasNext: boolean
  total_count: number
}

/** 이름 · 전화 등록 항목 — role을 못 실음 → 대표자는 등록 후 PATCH (backend-todo 10) */
export interface MemberInput {
  employeeNo: string
  name: string
  phoneNumber: string // 숫자만
}

const MAX_LIMIT = 100 // 목록 limit 최대

export const companyQueries = {
  all: () => ['companies'] as const,
  list: (q: { q: string; limit: number; offset: number }) =>
    queryOptions({
      queryKey: [...companyQueries.all(), 'list', q],
      queryFn: ({ signal }) =>
        api.get<Page<Company>>('/companies', {
          query: { ...q, q: q.q.trim() || undefined },
          signal,
        }),
    }),
  detail: (id: number) =>
    queryOptions({
      queryKey: [...companyQueries.all(), id],
      queryFn: async ({ signal }) =>
        (await api.get<ApiItem<Company>>(`/companies/${id}`, { signal })).data,
    }),
  members: (id: number, q: { limit: number; offset: number }) =>
    queryOptions({
      queryKey: [...companyQueries.all(), id, 'members', q],
      queryFn: ({ signal }) =>
        api.get<Page<Member>>(`/companies/${id}/members`, { query: q, signal }),
    }),
  // 사원 수 = 재직(ACTIVE) 구성원 total_count. 1건만 받음 — shortcut: 기업마다 요청 1개, 서버가 사원 수를 주면 지울 것
  memberCount: (id: number) =>
    queryOptions({
      queryKey: [...companyQueries.all(), id, 'memberCount'],
      queryFn: async ({ signal }) =>
        (
          await api.get<Page<Member>>(`/companies/${id}/members`, {
            query: { status: 'ACTIVE', limit: 1, offset: 0 },
            signal,
          })
        ).total_count,
    }),
  // 대표자 이름(상세 제목 줄) · CSV 대표자 지정(사번 → membershipSeq)에 전체가 필요 → 100건씩 끝까지
  allMembers: (id: number) =>
    queryOptions({
      queryKey: [...companyQueries.all(), id, 'members', 'all'],
      queryFn: ({ signal }) => fetchAllMembers(id, signal),
    }),
}

export async function fetchAllMembers(id: number, signal?: AbortSignal): Promise<Member[]> {
  const out: Member[] = []
  for (let offset = 0; ; offset += MAX_LIMIT) {
    const page = await api.get<Page<Member>>(`/companies/${id}/members`, {
      query: { limit: MAX_LIMIT, offset },
      signal,
    })
    out.push(...page.data)
    if (!page.hasNext) return out
  }
}

/** 기업 등록 — 201 data.organizationSeq. 같은 이름도 등록됨 */
export const createCompany = async (name: string): Promise<number> =>
  (await api.post<ApiItem<{ organizationSeq: number }>>('/companies', { body: { name } })).data
    .organizationSeq

/** 기업 삭제 — 소속 · 부서 · 기업 PIN 삭제, 고객 · 주문 · 통화 이력은 보존 */
export const deleteCompany = (id: number): Promise<void> => api.delete(`/companies/${id}`)

/** 사원 등록 — 1~1000건 · 전체 트랜잭션 · 204. 같은 사번이면 고객 정보 갱신(= 수정) */
export const addMembers = (id: number, items: MemberInput[]): Promise<void> =>
  api.post(`/companies/${id}/members`, { body: { items } })

/** 대표자 표시 바꾸기 */
export const setMemberRole = (
  membershipSeq: number,
  role: Member['membership']['role'],
): Promise<void> => api.patch(`/members/${membershipSeq}`, { body: { role } })

/** 기업 소속 해제 — 고객 · 개인 PIN · 과거 주문은 남음 */
export const removeMember = (membershipSeq: number): Promise<void> =>
  api.delete(`/members/${membershipSeq}`)
