// 08 기업관리 — API-36~40 기업 · API-45~48 구성원 (API 연동 상세명세 7장). React를 모르는 데이터 · API 층
// 11/11 재설계: 기업은 월결제로 고정(기업 간 배송) · 그룹 카드는 개인 카드와 같은 결제가 되어 화면에서 뺌 · 담당자(ORG_ADMIN) 1명 이상
import { queryOptions } from '@tanstack/react-query'
import { api, type ApiItem } from '@/shared/api/client'
import { fetchAll } from '@/shared/api/paging'

type ActiveStatus = 'ACTIVE' | 'INACTIVE'

/** OrganizationSummary — 사원 수 · 등록일은 11/01 백엔드 반영 */
interface Company {
  organizationSeq: number
  name: string
  status: ActiveStatus
  memberCount: number // 현재 ACTIVE 구성원 수 (부서 없는 사원 · 담당자 포함)
  createdAt: string | null // 등록 시각 — 예전 기업은 이력이 없어 null
  // 아래 셋은 목록 화면용으로 백엔드에 요청한 칸. 오기 전엔 undefined → 빈칸
  departmentCount?: number
  managerNames?: string[] // 담당자(ORG_ADMIN) 이름 — 사번 순
  monthlyAmount?: number // 이번 달(한국 시각) 청구액, 원
}

/** CustomerAddress — 사원 주소는 고객 정보에 있음 (서버 CustomerAddressDto — 좌표 칸은 043에서 빠짐) */
export interface CustomerAddress {
  roadAddress: string
  jibunAddress: string
  detailAddress?: string
  dongName: string
  postalCode: string
}

/** MemberView = 소속(membership) + 고객(customer) */
export interface Member {
  membership: {
    membershipSeq: number // 수정 · 삭제 키
    customerSeq: number
    organizationSeq: number
    departmentSeq: number | null
    employeeNo: string // 사번 — 앞자리 0 보존(문자열)
    role: 'MEMBER' | 'ORG_ADMIN' // ORG_ADMIN = 담당자 표시(연락 창구), 권한 없음 · 여러 명 · 기업마다 1명 이상
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
interface Page<T> {
  data: T[]
  hasNext: boolean
  total_count: number
}

/** 이름 · 전화 등록 항목 */
export interface MemberInput {
  employeeNo: string
  name: string
  phoneNumber: string // 숫자만
}
/** 사원 등록(POST /companies/{id}/members) 한 줄 — role 생략: 신규 MEMBER · 기존은 유지
 * departmentSeq 생략 · null = 부서 없음 (기존 사원도 빠짐 — role과 다름) */
export interface MemberItem extends MemberInput {
  role?: Member['membership']['role']
  departmentSeq?: number | null
}

/** 부서 — 이름은 기업 안에서 고유. 사원을 거르는 데만 씀 */
export interface Department {
  departmentSeq: number
  name: string
  memberCount: number // 이 부서의 ACTIVE 사원 수 (담당자 포함)
}

/** BillingMonth — 금액 단위 원. 기업 삭제 뒤에도 그 달 기업명은 남아 있음 */
interface BillingMonth {
  organizationSeq: number
  organizationName: string | null
  month: string
  monthlyAmount: number // 월결제 사용액
  groupBillingAmount: number // 부서 그룹결제 사용액 — 그룹결제가 없어지기 전까지 청구액에 더함
}

/** 청구 건의 사람 — 주문에 저장된 값이라 비어 있을 수 있음 */
export interface ChargeParty {
  name: string | null
  phoneNumber: string | null
  address: string | null // 도로명 + 상세주소
}

/** 청구 내역 한 건 — GET /companies/{id}/billing/charges. 월결제 원장 한 줄 = 주문 하나
 *  금액 · 기업 · 부서는 결제 확정 때 값(뒤에 주문이 바뀌거나 사원이 옮겨도 그대로). 결제 뒤 취소돼도 원장에 남음 */
export interface Charge {
  orderSeq: number
  paidAt: string // 결제 확정 시각 ISO
  amount: number
  orderCancelled: boolean
  sender: ChargeParty & { departmentName: string | null } // 첫 배송의 보내는 분 · 결제 당시 부서
  parcels: {
    cancelled: boolean
    recipient: ChargeParty
    items: { document: number; small: number; medium: number; big: number; other: string | null }
  }[] // 배송 순서대로
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
  // 검색용 전체 — 서버 검색은 글자 그대로라 초성이 안 돼서 다 받아 화면에서 거름 (04와 같은 방식). 5분 재사용
  // shortcut: fetchAll 2,000곳 상한 — 넘으면 앞 2,000곳 안에서만 찾음. 그때는 서버 초성 검색으로
  pool: () =>
    queryOptions({
      queryKey: [...companyQueries.all(), 'pool'],
      queryFn: ({ signal }) => fetchAll<Company>('/companies', {}, signal),
      staleTime: 5 * 60_000,
    }),
  detail: (id: number) =>
    queryOptions({
      queryKey: [...companyQueries.all(), id],
      queryFn: async ({ signal }) =>
        (await api.get<ApiItem<Company>>(`/companies/${id}`, { signal })).data,
    }),
  members: (id: number, q: { limit: number; offset: number; q?: string }) =>
    queryOptions({
      queryKey: [...companyQueries.all(), id, 'members', q],
      queryFn: ({ signal }) =>
        api.get<Page<Member>>(`/companies/${id}/members`, { query: q, signal }),
    }),
  // 담당자 수(상세 제목 줄) · CSV 담당자 지정(사번 → membershipSeq)에 전체가 필요 → 100건씩 끝까지
  departments: (id: number) =>
    queryOptions({
      queryKey: [...companyQueries.all(), id, 'departments'],
      queryFn: ({ signal }) => fetchAll<Department>(`/companies/${id}/departments`, {}, signal),
    }),
  // 월 사용액 (API-34) — 한 번에 한 달. month 'YYYY-MM'(한국 시각 기준 월)
  billing: (id: number, month: string) =>
    queryOptions({
      queryKey: [...companyQueries.all(), id, 'billing', month],
      queryFn: async ({ signal }) =>
        (
          await api.get<ApiItem<BillingMonth>>(`/companies/${id}/billing`, {
            query: { month },
            signal,
          })
        ).data,
    }),
  // 청구 내역 — 그 달 · 검색(보낸 사람 · 받는 분 이름, 주문번호) · 쪽
  charges: (id: number, q: { month: string; q?: string; limit: number; offset: number }) =>
    queryOptions({
      queryKey: [...companyQueries.all(), id, 'charges', q],
      queryFn: ({ signal }) =>
        api.get<Page<Charge> & { total_amount: number }>(`/companies/${id}/billing/charges`, {
          query: q,
          signal,
        }),
    }),
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
/** 기업 + 부서 + 사원을 한 번에 — POST /companies (백엔드 확장). 하나의 트랜잭션: 전부 되거나 전부 안 됨
 * departmentName은 같은 요청의 departments[].name, role 생략 = MEMBER. 201 data.organizationSeq. 같은 이름 기업도 등록됨 */
interface NewCompanyMember extends MemberInput {
  role?: Member['membership']['role']
  departmentName?: string
}
export const createCompany = async (
  name: string,
  departments: string[] = [],
  members: NewCompanyMember[] = [],
): Promise<number> =>
  (
    await api.post<ApiItem<{ organizationSeq: number }>>('/companies', {
      body: { name, departments: departments.map((d) => ({ name: d })), members },
    })
  ).data.organizationSeq

/** 기업명 바꾸기 — 서버가 앞뒤 공백을 지움, 빈 이름은 400 */
export const renameCompany = (id: number, name: string): Promise<void> =>
  api.patch(`/companies/${id}`, { body: { name } })

/** 기업 삭제 — 1~100곳 · 중복 불가 · 하나라도 없으면 404 + 전체 롤백 · 204. 소속 · 부서 · 기업 PIN 삭제, 고객 · 주문 · 통화 이력은 보존 */
export const deleteCompanies = (ids: number[]): Promise<void> =>
  api.delete('/companies', { body: { organizationSeqs: ids } })

/** 사원 등록 — 1~1000건 · 전체 트랜잭션 · 204. 같은 사번이면 고객 정보 갱신(= 수정) */
export const addMembers = (id: number, items: MemberItem[]): Promise<void> =>
  api.post(`/companies/${id}/members`, { body: { items } })

/** 부서 만들기 — 201 data.departmentSeq. 같은 이름이 이미 있으면 409 */
export const createDepartment = async (id: number, name: string): Promise<number> =>
  (
    await api.post<ApiItem<{ departmentSeq: number }>>(`/companies/${id}/departments`, {
      body: { name },
    })
  ).data.departmentSeq

/** 부서 이름 바꾸기 — 204. 같은 이름이 이미 있으면 409 */
export const renameDepartment = (departmentSeq: number, name: string): Promise<void> =>
  api.patch(`/departments/${departmentSeq}`, { body: { name } })

/** 부서 삭제 — 204. 그 부서 사원의 기업 소속도 해제됨(고객 · 주문 기록은 남음, company-deletion.md) */
export const deleteDepartment = (departmentSeq: number): Promise<void> =>
  api.delete('/departments', { body: { departmentSeqs: [departmentSeq] } })

/** 담당자 표시 바꾸기 */
export const setMemberRole = (
  membershipSeq: number,
  role: Member['membership']['role'],
): Promise<void> => api.patch(`/members/${membershipSeq}`, { body: { role } })

/** 기업 소속 해제 — 고객 · 개인 PIN · 과거 주문은 남음 */
export const removeMember = (membershipSeq: number): Promise<void> =>
  api.delete('/members', { body: { membershipSeqs: [membershipSeq] } })

/** 사번들을 담당자로 지정 — 등록 응답에 번호가 없어 전체를 다시 받아 사번으로 찾음 (backend-todo 10: role을 등록에 실어 주면 없어짐)
 * 이미 담당자면 건너뜀. 못 찾았거나 실패한 수를 돌려줌 (CSV 기업 등록 · CSV 사원 추가 · 사원 추가 창 공용) */
export async function assignLeaders(id: number, employeeNos: string[]): Promise<number> {
  if (employeeNos.length === 0) return 0
  const byNo = new Map((await fetchAllMembers(id)).map((m) => [m.membership.employeeNo, m]))
  let failed = 0
  for (const no of employeeNos) {
    const m = byNo.get(no)
    if (!m) failed++
    else if (m.membership.role !== 'ORG_ADMIN')
      await setMemberRole(m.membership.membershipSeq, 'ORG_ADMIN').catch(() => failed++)
  }
  return failed
}

/** 사원 주소 저장 — 주소는 사원 소속이 아니라 고객 정보에 있음: PATCH /customers/{customerSeq} { address } (204)
 * address는 전체 교체 객체(필수: 도로명 · 지번 · 동 · 우편번호). 03 주문 '고객정보에도 저장'과 같은 API */
export const saveCustomerAddress = (customerSeq: number, address: CustomerAddress): Promise<void> =>
  api.patch(`/customers/${customerSeq}`, { body: { address } })

/** CSV 주소를 사원마다 고객 주소로 저장 — 등록 API에 주소 칸이 아직 없어서(백엔드 추가 예정) 등록 뒤 따로
 * shortcut: 사원마다 PATCH 1번 · 등록과 묶이지 않음 — 등록 API가 주소를 받으면 그 본문으로 옮기고 이 함수는 지울 것
 * 사번 → 고객 번호는 전체 사원을 다시 받아 찾음. 저장하지 못한 사번 목록을 돌려줌 */
export async function saveMemberAddresses(
  id: number,
  rows: { employeeNo: string; address: CustomerAddress }[],
): Promise<string[]> {
  if (rows.length === 0) return []
  const byNo = new Map((await fetchAllMembers(id)).map((m) => [m.membership.employeeNo, m]))
  const failed: string[] = []
  for (const r of rows) {
    const seq = byNo.get(r.employeeNo)?.customer.customerSeq
    if (seq === undefined) failed.push(r.employeeNo)
    else await saveCustomerAddress(seq, r.address).catch(() => failed.push(r.employeeNo))
  }
  return failed
}
