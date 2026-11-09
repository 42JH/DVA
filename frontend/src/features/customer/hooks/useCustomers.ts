// 고객 — 기업 · 개인 상관없이 모든 고객 (기업 피드백: 고객 관리 화면 · 개인 주소록 확인)
// GET /customers (이름 부분 검색 · 휴대전화 11자리 정확히) · GET /customers/{id}/pins (개인 주소록). 고객 번호 내림차순, 한 쪽 개수는 고른 대로
import { useEffect } from 'react'
import {
  keepPreviousData,
  queryOptions,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { api, type ApiItem, type ApiList } from '@/shared/api/client'
import { fmtPhone } from '@/shared/lib/format'
import { useListParams } from '@/shared/lib/useListParams'
import { usePageSize } from '@/shared/lib/paging'
import { useDebounced } from '@/shared/lib/useDebounced'

// 고객 확인 POST /customers/context — 서버가 계산한 '쓸 수 있는 결제'와 소속 기업 · 부서 (develop-backend customers.repository)
// billing 개인카드(항상) · credit 월정산(일반 고객은 고객 허용, 기업 고객은 기업 허용) · groupBilling 그룹카드(소속 부서 허용)
// 전화번호만 보내면 통화 · 감사 기록을 남기지 않음 (백엔드 설명)
type PayMethod = 'billing' | 'credit' | 'groupBilling'
interface CallerContext {
  organization: { name: string } | null
  department: { name: string } | null
  availablePaymentMethods: PayMethod[]
}
const PAY_LABEL: Record<PayMethod, string> = {
  billing: '개인카드',
  credit: '월정산',
  groupBilling: '그룹카드',
} // 주문 화면 결제 방식과 같은 말

/** 소속 · 결제 — 목록 '구분' 칸(보이는 줄마다)과 고객 정보 패널이 같은 캐시를 씀 */
const contextOpts = (phone: string) =>
  queryOptions({
    queryKey: ['screen', 'customer-context', phone],
    queryFn: async ({ signal }) => {
      const { data } = await api.post<ApiItem<CallerContext>>('/customers/context', {
        body: { phoneNumber: phone },
        signal,
      })
      return {
        company: data.organization
          ? [data.organization.name, data.department?.name].filter(Boolean).join(' ')
          : null,
        payments: data.availablePaymentMethods.map((m) => PAY_LABEL[m]),
      }
    },
    staleTime: 5 * 60_000,
  })

const DEFAULTS = { q: '', c: '' } // c = 열어 둔 고객 번호

interface Address {
  roadAddress: string
  jibunAddress: string
  detailAddress?: string
  dongName: string
  postalCode: string
}
interface CustomerDto {
  customerSeq: number
  name: string
  phoneNumber: string
  address: Address | null
  monthlyBillingEnabled: boolean
  status: 'ACTIVE' | 'WITHDRAWN'
  availablePaymentMethods: PayMethod[] // 조회 시점 결제 자격 (목록 전용, 11/08). 실제 결제 때 서버가 다시 확인
}
interface PinDto {
  personalPinSeq: number
  label: string | null
  addressData: Address & { name: string; phoneNumber: string }
}

const addr = (a: Address | null) =>
  a ? [a.roadAddress, a.detailAddress].filter(Boolean).join(' ') : ''

export function useCustomers() {
  const { params, page, set } = useListParams(DEFAULTS)
  const [size, setSize] = usePageSize()
  const qc = useQueryClient()
  const t = useDebounced(params.q.trim()) // 입력이 멈추면 한 번만 서버에
  const digits = t.replace(/\D/g, '')
  // 숫자 11자리면 전화번호로(서버는 정확히 일치만), 아니면 이름 부분 검색
  const query = /^01\d{9}$/.test(digits)
    ? { phoneNumber: digits }
    : t && !/^\d+$/.test(t)
      ? { q: t }
      : {}
  const list = useQuery({
    queryKey: ['screen', 'customers', query, size, page],
    queryFn: ({ signal }) =>
      api.get<ApiList<CustomerDto>>('/customers', {
        query: { ...query, limit: size, offset: (page - 1) * size },
        signal,
      }),
    placeholderData: keepPreviousData,
  })
  const total = list.data?.total_count ?? 0
  const pages = Math.max(1, Math.ceil(total / size))
  // 없는 쪽이면 마지막 쪽으로 (주소를 직접 고친 경우)
  useEffect(() => {
    if (list.data && total > 0 && page > pages) set({ page: pages })
  }, [list.data, total, page, pages, set])
  const open = Number(params.c) || null
  const shown = list.data?.data ?? []
  // 구분(일반 · 기업 고객): 목록 응답엔 소속이 없어 보이는 줄마다 고객 확인으로 (패널과 같은 말)
  // ponytail: 한 쪽 줄 수만큼 요청(5분 캐시). 목록 응답에 소속이 오면 그걸로 바꾸고 지움
  const contexts = useQueries({ queries: shown.map((c) => contextOpts(c.phoneNumber)) })

  return {
    q: params.q,
    setQ: (q: string) => set({ q, c: '' }),
    hint:
      /^\d+$/.test(t) && !query.phoneNumber && t
        ? '전화번호는 11자리를 모두 입력해 주세요.' // 서버가 정확히 일치만 찾음
        : null,
    rows: shown.map((c, i) => ({
      seq: c.customerSeq,
      name: c.name,
      phone: fmtPhone(c.phoneNumber),
      digits: c.phoneNumber,
      address: c.address?.roadAddress ?? '',
      detail: c.address?.detailAddress ?? '',
      payments: c.availablePaymentMethods.map((m) => PAY_LABEL[m]),
      withdrawn: c.status === 'WITHDRAWN',
      kind: contexts[i]?.data ? (contexts[i].data.company ? '기업 고객' : '일반 고객') : '',
      company: contexts[i]?.data?.company ?? '', // '디버물류 영업팀' — 마우스를 올리면
    })),
    isLoading: list.isPending,
    isStale: list.isPlaceholderData,
    error: list.error ? '고객을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.' : null,
    total,
    page,
    size,
    setSize,
    setPage: (p: number) => set({ page: p }),
    open,
    pick: (seq: number) => set({ c: String(seq), page }),
    close: () => set({ c: '', page }),
    // 줄에 마우스를 올리면 고객 · 주소록을 미리 받음
    warm: (seq: number) => {
      void qc.prefetchQuery(customerOpts(seq))
      void qc.prefetchQuery(pinsOpts(seq))
    },
  }
}

const customerOpts = (seq: number) => ({
  queryKey: ['screen', 'customer', seq],
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    api.get<{ data: CustomerDto }>(`/customers/${seq}`, { signal }).then((r) => r.data),
})
const pinsOpts = (seq: number) => ({
  queryKey: ['screen', 'customer', seq, 'pins'],
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    api.get<ApiList<PinDto>>(`/customers/${seq}/pins`, {
      query: { limit: 100, offset: 0 },
      signal,
    }),
})

/** 고객 한 명 + 개인 주소록 */
export function useCustomer(seq: number) {
  const c = useQuery(customerOpts(seq))
  const pins = useQuery(pinsOpts(seq))
  const ctx = useQuery({ ...contextOpts(c.data?.phoneNumber ?? ''), enabled: !!c.data })
  return {
    c: c.data && {
      name: c.data.name,
      phone: fmtPhone(c.data.phoneNumber),
      digits: c.data.phoneNumber,
      address: c.data.address?.roadAddress ?? '',
      detail: c.data.address?.detailAddress ?? '',
      postal: c.data.address?.postalCode ?? '',
      company: ctx.data?.company ?? null, // '디버물류 영업팀'
      payments: ctx.data?.payments ?? null,
      withdrawn: c.data.status === 'WITHDRAWN',
    },
    error: c.error ? '고객 정보를 불러오지 못했습니다.' : null,
    pins: (pins.data?.data ?? []).map((p) => ({
      key: p.personalPinSeq,
      name: p.addressData.name,
      phone: fmtPhone(p.addressData.phoneNumber),
      address: addr(p.addressData),
    })),
    pinTotal: pins.data?.total_count ?? 0,
    pinsLoading: pins.isPending,
    pinsError: pins.error ? '주소록을 불러오지 못했습니다.' : null,
  }
}
