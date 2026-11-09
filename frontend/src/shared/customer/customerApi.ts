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

/** 개인 주소록 한 줄 — 고객이 저장한 받는 곳 */
export interface PinDto {
  personalPinSeq: number
  label: string | null
  addressData: Address & { name: string; phoneNumber: string }
}

export const customerQueries = {
  all: () => ['customers'] as const,
  /** 추천용 — 조건이 없으면(빈 칸 · 번호 일부) 요청하지 않음 */
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

/** 개인 주소록에 추가. 같은 주소가 이미 있으면 서버가 거절(DB 중복 제약) — 부르는 쪽에서 무시 */
export const createPin = (customerSeq: number, addressData: PinDto['addressData']) =>
  api.post(`/customers/${customerSeq}/pins`, { body: { addressData } })
