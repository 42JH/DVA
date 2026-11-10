// 기업 상세 요약줄 아래 — 월결제 사용 여부(확인 창 → 변경) · 월별 사용액 (11/11)
import { useCompanyBilling } from '@/features/company/hooks/useCompanyBilling'
import { BILLING_LABEL } from '@/features/company/labels'
import { Btn, Icon } from '@/shared/ui'
import { Choice } from '@/shared/ui/Field'
import { Confirm } from '@/shared/ui/Modal'

// Choice는 문자열 값만 받아서 Y/N으로
const OPTIONS = [
  { value: 'Y', label: BILLING_LABEL(true) },
  { value: 'N', label: BILLING_LABEL(false) },
] as const

export function CompanyBilling({ id }: { id: number }) {
  const vm = useCompanyBilling(id)

  return (
    <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
      {vm.enabled !== undefined && (
        <Choice
          label="월결제"
          value={vm.enabled ? 'Y' : 'N'}
          options={[...OPTIONS]}
          onChange={(v) => vm.ask(v === 'Y')}
        />
      )}
      <div className="flex items-center gap-1 text-[13px]">
        <Btn aria-label="이전 달" className="px-1.5" onClick={vm.prevMonth}>
          <Icon name="chevron" className="size-4 rotate-90" />
        </Btn>
        <span className="min-w-[88px] text-center font-semibold tabular-nums">{vm.monthLabel}</span>
        <Btn
          aria-label="다음 달"
          className="px-1.5"
          disabled={!vm.nextMonth}
          onClick={vm.nextMonth}
        >
          <Icon name="chevron" className="size-4 -rotate-90" />
        </Btn>
        <span className="ml-2 text-ops-sub tabular-nums" aria-live="polite">
          {vm.usageError ??
            (vm.usage
              ? `월결제 ${vm.usage.monthly} · 그룹결제 ${vm.usage.group}`
              : vm.usageLoading && '불러오는 중…')}
        </span>
      </div>
      {vm.pending !== null && (
        <Confirm
          title={`월결제를 '${BILLING_LABEL(vm.pending)}'으로 바꿀까요?`}
          ok="변경"
          busy={vm.saving}
          error={vm.saveError}
          onOk={vm.confirm}
          onClose={vm.cancel}
        >
          {vm.pending
            ? '이 기업 사원이 주문할 때 월결제를 고를 수 있습니다.'
            : '이 기업 사원은 앞으로 월결제로 주문할 수 없습니다. 이미 쓴 사용액은 그대로 남습니다.'}
        </Confirm>
      )}
    </div>
  )
}
