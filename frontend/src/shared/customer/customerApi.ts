// 고객 — 고객 화면과 주문 폼(보내는 분 · 받는 분 추천)이 같이 씀. GET /customers (API-49)
import { queryOptions } from '@tanstack/react-query'
import { api, type ApiList } from '@/shared/api/client'
import { customerSearch } from './customerSearch'

export type PayMethod = 'billing' | 'credit' | 'groupBilling'

export interface Address {
  roadAddress: string
  jibunAddress: string
  detailAddress?: string
  dongName: string
  postalCode: string
}

export interface CustomerDto {
  customerSeq: number
  name: string
  phoneNumber: string
  address: Address | null
  monthlyBillingEnabled: boolean
  status: 'ACTIVE' | 'WITHDRAWN'
  availablePaymentMethods: PayMethod[] // 조회 시점 결제 자격 (목록 전용, 11/08). 실제 결제 때 서버가 다시 확인
}

/** 사원 검색 한 줄 (GET /companies/members/search) — 쓰는 칸만 */
interface MemberDto {
  organizationName: string
  name: string
  phoneNumber: string
}

/** 개인 주소록 한 줄 — 고객이 저장한 받는 곳 */
export interface PinDto {
  personalPinSeq: number
  label: string | null
  addressData: Address & { name: string; phoneNumber: string }
}

export const customerQueries = {
  all: () => ['customers'] as const,
  /** 추천용 — 조건이 없으면(빈 칸 · 번호 3자리 이하) 요청하지 않음 */
  search: (text: string, limit = 5) => {
    const where = customerSearch(text)
    return queryOptions({
      queryKey: [...customerQueries.all(), 'search', where, limit],
      queryFn: ({ signal }) =>
        api.get<ApiList<CustomerDto>>('/customers', {
          query: { ...where, status: 'ACTIVE', limit, offset: 0 },
          signal,
        }),
      enabled: where !== null,
      staleTime: 30_000,
    })
  },
  /** 소속 기업 찾기 — 사원 검색(이름 · 번호 일부, 관리자 세션). 추천 줄에 기업 이름을 붙이는 데만 씀 (11/11 사용자) */
  members: (text: string, limit = 20) => {
    const where = customerSearch(text)
    const q = where && ('q' in where ? where.q : where.phoneNumber)
    return queryOptions({
      queryKey: [...customerQueries.all(), 'members', q, limit],
      queryFn: ({ signal }) =>
        api.get<ApiList<MemberDto>>('/companies/members/search', {
          query: { q: q ?? undefined, limit, offset: 0 },
          signal,
        }),
      enabled: q !== null,
      staleTime: 30_000,
    })
  },
  /** 이 고객이 실제로 보낸 받는 곳 — 최신순 (접수 완료 주문). 주소록을 '최근에 보낸 순'으로 정렬하는 데만 씀 (11/11 사용자) */
  sentTo: (customerSeq: number) =>
    queryOptions({
      queryKey: [...customerQueries.all(), customerSeq, 'sentTo'],
      queryFn: ({ signal }) =>
        api.get<ApiList<{ createdAt: string; address: { phoneNumber: string } }>>(
          `/customers/${customerSeq}/addresses`,
          { query: { direction: 'DESTINATION', limit: 100, offset: 0 }, signal },
        ),
      staleTime: 30_000,
      retry: false, // 못 받으면 정렬만 안 함(저장 순서 그대로)
    }),
  /** 개인 주소록 추천 — 빈 검색어면 앞에서부터. q는 별칭 · 수령인 · 전화번호 · 주소 부분 검색(번호 일부도 됨) */
  pins: (customerSeq: number, text: string, limit = 5) =>
    queryOptions({
      queryKey: [...customerQueries.all(), customerSeq, 'pins', text.trim(), limit],
      queryFn: ({ signal }) =>
        api.get<ApiList<PinDto>>(`/customers/${customerSeq}/pins`, {
          query: { q: text.trim(), limit, offset: 0 },
          signal,
        }),
      staleTime: 30_000,
    }),
}
