// 고객 수정 — PATCH /customers/{id}. 보낸 항목만 바뀌고 응답 본문 없음(204)
import { api } from '@/shared/api/client'
import type { Address } from '@/shared/customer/customerApi'

/** 생략 = 그대로, address: null = 주소 삭제. 탈퇴(WITHDRAWN)는 되돌릴 수 없음 */
export interface CustomerUpdate {
  name?: string
  address?: Address | null
  monthlyBillingEnabled?: boolean
  status?: 'WITHDRAWN'
}

export const updateCustomer = (seq: number, changes: CustomerUpdate) =>
  api.patch(`/customers/${seq}`, { body: changes })
