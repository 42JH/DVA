// 기업 상세 요약줄 아래 — 결제 수단 요약 한 줄 · 가운데 월 선택과 사용액 (11/11). [결제 설정]은 상단바
import { useCompanyBilling } from '@/features/company/hooks/useCompanyBilling'
import { Btn, Icon } from '@/shared/ui'

export function CompanyBilling({ id }: { id: number }) {
  const vm = useCompanyBilling(id)

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
        <span className="font-semibold">결제 수단</span>
        <span className="text-ops-sub">{vm.summary}</span>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[13px]">
        <span className="flex items-center gap-1">
          <Btn aria-label="이전 달" className="px-1.5" onClick={vm.prevMonth}>
            <Icon name="chevron" className="size-4 rotate-90" />
          </Btn>
          <span className="min-w-[88px] text-center font-semibold tabular-nums">
            {vm.monthLabel}
          </span>
          <Btn
            aria-label="다음 달"
            className="px-1.5"
            disabled={!vm.nextMonth}
            onClick={vm.nextMonth}
          >
            <Icon name="chevron" className="size-4 -rotate-90" />
          </Btn>
        </span>
        <span className="text-ops-sub tabular-nums" aria-live="polite">
          {vm.usageError ??
            (vm.usage
              ? `월결제 ${vm.usage.monthly} · 그룹 카드 ${vm.usage.group}`
              : vm.usageLoading && '불러오는 중…')}
        </span>
      </div>
    </div>
  )
}
