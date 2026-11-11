// 기업 상세 요약줄 아래 — 결제 수단 요약 한 줄 · 월 선택과 사용액 (11/11). [결제 설정]은 상단바
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
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
        <span className="flex items-center gap-1">
          <Btn aria-label="이전 달" className="px-1.5" onClick={vm.prevMonth}>
            <Icon name="chevron" className="size-4 rotate-90" />
          </Btn>
          <span className="min-w-[88px] text-center text-[14px] font-semibold tabular-nums">
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
        {/* 금액은 크게 · 굵게, 이름은 작게 (11/11 가시성 피드백) */}
        <span className="flex items-baseline gap-x-6" aria-live="polite">
          {vm.usageError ? (
            <span className="text-[13px] text-ops-stop">{vm.usageError}</span>
          ) : vm.usage ? (
            <>
              <span className="flex items-baseline gap-2">
                <span className="text-[13px] text-ops-sub">월결제</span>
                <span className="text-[18px] font-bold tabular-nums">{vm.usage.monthly}</span>
              </span>
              <span className="flex items-baseline gap-2">
                <span className="text-[13px] text-ops-sub">그룹 카드</span>
                <span className="text-[18px] font-bold tabular-nums">{vm.usage.group}</span>
              </span>
            </>
          ) : (
            vm.usageLoading && <span className="text-[13px] text-ops-sub">불러오는 중…</span>
          )}
        </span>
      </div>
    </div>
  )
}
