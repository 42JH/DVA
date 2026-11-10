import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { addMonths, todayYmd } from '@/shared/lib/dateRange'
import { useListParams } from '@/shared/lib/useListParams'
import { companyQueries, setMonthlyBilling } from '@/features/company/api/companyApi'
import { errorText } from '@/features/company/labels'

const DEFAULTS = { month: '' } // '' = 이번 달 (주소에 안 남김)
const MONTH = /^[1-9]\d{3}-(0[1-9]|1[0-2])$/ // 서버 BillingMonthQueryDto와 같은 형식

const won = (n: number) => `${n.toLocaleString('ko-KR')}원`

/** 08 기업 상세 — 월결제 사용 여부(확인 창 → 변경) · 월별 사용액(달은 URL ?month=) */
export function useCompanyBilling(id: number) {
  const { params, page, set } = useListParams(DEFAULTS)
  const qc = useQueryClient()
  // 확인 창에 띄울 바꿀 값 — null이면 창 닫힘
  const [pending, setPending] = useState<boolean | null>(null)

  const thisMonth = todayYmd().slice(0, 7)
  // 주소는 누구나 고칠 수 있음 → 형식이 틀리거나 미래 달이면 이번 달로
  const month = MONTH.test(params.month) && params.month <= thisMonth ? params.month : thisMonth
  // page를 같이 넘김 — 안 넘기면 달만 바꿔도 사원 표가 1쪽으로 감
  const goMonth = (m: string) => set({ month: m === thisMonth ? '' : m, page })

  const company = useQuery(companyQueries.detail(id))
  const usage = useQuery(companyQueries.billing(id, month))

  const change = useMutation({
    mutationFn: (enabled: boolean) => setMonthlyBilling(id, enabled),
    onSuccess: async () => {
      // 상세 · 목록의 '월결제' 열까지 한 번에
      await qc.invalidateQueries({ queryKey: companyQueries.all() })
      setPending(null)
    },
  })

  return {
    enabled: company.data?.monthlyBillingEnabled, // 불러오기 전 undefined → 선택 칸 안 그림
    ask: (next: boolean) => {
      if (next === company.data?.monthlyBillingEnabled) return // 같은 값 다시 누름
      change.reset() // 지난 실패 문구가 남지 않게
      setPending(next)
    },
    pending,
    cancel: () => setPending(null),
    confirm: () => pending !== null && change.mutate(pending),
    saving: change.isPending,
    saveError: change.error ? errorText(change.error, '저장') : null,

    monthLabel: `${month.slice(0, 4)}년 ${Number(month.slice(5))}월`,
    prevMonth: () => goMonth(addMonths(month, -1)),
    nextMonth: month < thisMonth ? () => goMonth(addMonths(month, 1)) : undefined, // 이번 달이면 ▶ 끔
    usage: usage.data
      ? { monthly: won(usage.data.monthlyAmount), group: won(usage.data.groupBillingAmount) }
      : null,
    usageLoading: usage.isPending,
    usageError: usage.error ? '사용액을 불러오지 못했습니다. 새로고침해 주세요.' : null,
  }
}
