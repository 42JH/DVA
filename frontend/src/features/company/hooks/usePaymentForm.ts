import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  companyQueries,
  setGroupBilling,
  setMonthlyBilling,
} from '@/features/company/api/companyApi'
import { errorText } from '@/features/company/labels'

/** [결제 설정] 창 — 월결제 · 그룹 카드(부서별). 누르는 즉시 그것만 저장, 확인 창 없음 (11/11 결정) */
export function usePaymentForm(id: number) {
  const qc = useQueryClient()
  const company = useQuery(companyQueries.detail(id))
  const depts = useQuery(companyQueries.departments(id))
  // 다시 불러올 때까지 기다림 → 저장 중 표시가 끝날 때 새 값이 바로 보임. 목록 '월결제' 열까지 같이
  const refresh = () => qc.invalidateQueries({ queryKey: companyQueries.all() })

  const monthly = useMutation({
    mutationFn: (enabled: boolean) => setMonthlyBilling(id, enabled),
    onSuccess: refresh,
  })
  const group = useMutation({
    mutationFn: (v: { departmentSeq: number; enabled: boolean }) =>
      setGroupBilling(v.departmentSeq, v.enabled),
    onSuccess: refresh,
  })
  const target = group.variables?.departmentSeq // 마지막으로 누른 부서 — 저장 중 · 실패 줄 표시용

  return {
    // 저장 중엔 창 안 모든 버튼을 잠금 — 연달아 누르면 응답 순서가 엉켜 화면과 서버 값이 어긋날 수 있음
    locked: monthly.isPending || group.isPending,

    monthlyEnabled: company.data?.monthlyBillingEnabled, // 불러오기 전 undefined → 칸 안 그림
    monthlySaving: monthly.isPending,
    monthlyError: monthly.error ? errorText(monthly.error, '저장') : null,
    setMonthly: (enabled: boolean) => {
      if (enabled !== company.data?.monthlyBillingEnabled) monthly.mutate(enabled) // 같은 값 다시 누름은 무시
    },

    rows: (depts.data ?? []).map((d) => ({
      id: d.departmentSeq,
      name: d.name,
      enabled: d.groupBillingEnabled,
      saving: group.isPending && target === d.departmentSeq,
      error: group.isError && target === d.departmentSeq ? errorText(group.error, '저장') : null,
    })),
    deptsLoading: depts.isPending,
    deptsError: depts.error ? '부서 목록을 불러오지 못했습니다. 새로고침해 주세요.' : null,
    setGroup: (departmentSeq: number, enabled: boolean) => {
      const d = depts.data?.find((x) => x.departmentSeq === departmentSeq)
      if (d && d.groupBillingEnabled !== enabled) group.mutate({ departmentSeq, enabled })
    },
  }
}
