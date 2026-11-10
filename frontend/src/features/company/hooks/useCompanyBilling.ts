import { useQuery } from '@tanstack/react-query'
import { addMonths, todayYmd } from '@/shared/lib/dateRange'
import { useListParams } from '@/shared/lib/useListParams'
import { companyQueries } from '@/features/company/api/companyApi'
import { BILLING_LABEL } from '@/features/company/labels'

const DEFAULTS = { month: '' } // '' = 이번 달 (주소에 안 남김)
const MONTH = /^[1-9]\d{3}-(0[1-9]|1[0-2])$/ // 서버 BillingMonthQueryDto와 같은 형식

const won = (n: number) => `${n.toLocaleString('ko-KR')}원`

/** 08 기업 상세 — 결제 수단 요약 한 줄 · 월별 사용액(달은 URL ?month=) */
export function useCompanyBilling(id: number) {
  const { params, page, set } = useListParams(DEFAULTS)

  const thisMonth = todayYmd().slice(0, 7)
  // 주소는 누구나 고칠 수 있음 → 형식이 틀리거나 미래 달이면 이번 달로
  const month = MONTH.test(params.month) && params.month <= thisMonth ? params.month : thisMonth
  // page를 같이 넘김 — 안 넘기면 달만 바꿔도 사원 표가 1쪽으로 감
  const goMonth = (m: string) => set({ month: m === thisMonth ? '' : m, page })

  const company = useQuery(companyQueries.detail(id))
  const usage = useQuery(companyQueries.billing(id, month))
  const depts = useQuery(companyQueries.departments(id)) // 상세 훅과 같은 키 → 요청 한 번

  // 그룹 카드는 부서 단위라 기업 한 줄로는 요약만
  const deptCount = depts.data?.length ?? 0
  const groupOn = (depts.data ?? []).filter((d) => d.groupBillingEnabled).length
  const group =
    deptCount === 0
      ? '그룹 카드 미사용 (부서 없음)'
      : `그룹 카드 부서 ${deptCount}곳 중 ${groupOn}곳`

  return {
    // '개인 카드 사용 · 그룹 카드 부서 3곳 중 1곳 · 월결제 미사용' — 둘 다 받기 전엔 null
    summary:
      company.data && depts.data
        ? [
            '개인 카드 사용',
            group,
            `월결제 ${BILLING_LABEL(company.data.monthlyBillingEnabled)}`,
          ].join(' · ')
        : null,

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
