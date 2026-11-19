// 08 기업 상세의 달 · 청구액 카드 · 청구 내역 탭. 기업은 월결제 고정
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { addMonths, todayYmd } from '@/shared/lib/dateRange'
import { companyQueries } from '../api/companyApi'
import type { COMPANY_PARAMS } from './companyView'

const MONTH = /^[1-9]\d{3}-(0[1-9]|1[0-2])$/ // 서버 BillingMonthQueryDto와 같은 형식
// 그룹결제가 서버에서 없어지기 전까지 두 금액을 더함
const sum = (b?: { monthlyAmount: number; groupBillingAmount: number }) =>
  b ? b.monthlyAmount + b.groupBillingAmount : null

export function useCompanyCharges(
  id: number,
  size: number,
  list: {
    params: typeof COMPANY_PARAMS
    page: number
    set: (patch: Partial<typeof COMPANY_PARAMS> & { page?: number }) => void
  },
) {
  const { params, page, set } = list
  const thisMonth = todayYmd().slice(0, 7)
  const month = MONTH.test(params.m) && params.m <= thisMonth ? params.m : thisMonth
  const goMonth = (m: string) => set({ m: m === thisMonth ? '' : m, o: '', page })
  const billing = useQuery(companyQueries.billing(id, month))
  const prev = useQuery(companyQueries.billing(id, addMonths(month, -1)))
  const charges = useQuery({
    ...companyQueries.charges(id, {
      month,
      q: params.cq.trim() || undefined,
      limit: size,
      offset: (page - 1) * size,
    }),
    placeholderData: keepPreviousData,
  })
  // 탭 이름 · 위 카드의 건수는 검색과 상관없이 그 달 전체
  const chargeCount = useQuery(companyQueries.charges(id, { month, limit: 1, offset: 0 }))

  return {
    loaded: !!charges.data,
    total: charges.data?.total_count ?? 0,
    view: {
      // 청구액 카드
      monthLabel: `${month.slice(0, 4)}년 ${Number(month.slice(5))}월`,
      monthNum: Number(month.slice(5)),
      prevMonth: () => goMonth(addMonths(month, -1)),
      nextMonth: month < thisMonth ? () => goMonth(addMonths(month, 1)) : undefined,
      amount: sum(billing.data),
      prevAmount: sum(prev.data),
      chargeTotal: chargeCount.data?.total_count ?? null,

      // 청구 내역 탭
      cq: params.cq,
      setCq: (v: string) => set({ cq: v, o: '' }),
      charges: charges.data?.data ?? [],
      chargesSum: charges.data?.total_amount ?? null,
      chargesLoading: charges.isPending,
      chargesError: charges.error ? '청구 내역을 불러오지 못했습니다. 새로고침해 주세요.' : null,
      picked: charges.data?.data.find((c) => String(c.orderSeq) === params.o) ?? null,
      pick: (orderSeq: number) =>
        set({ o: params.o === String(orderSeq) ? '' : String(orderSeq), page }),
      unpick: () => set({ o: '', page }),
    },
  }
}
