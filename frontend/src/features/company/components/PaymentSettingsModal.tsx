// [결제 설정] 창 — 개인 카드(고정) · 월결제 · 그룹 카드(부서 골라서 하나씩). 누르는 즉시 저장, 확인 창 없음 (11/11)
import type { ReactNode } from 'react'
import { usePaymentForm } from '@/features/company/hooks/usePaymentForm'
import { BILLING_LABEL } from '@/features/company/labels'
import { Badge, Btn, SelectField } from '@/shared/ui'
import { Choice, Err } from '@/shared/ui/Field'
import { Modal } from '@/shared/ui/Modal'
import { SkeletonRows } from '@/shared/ui/ListFrame'

// Choice는 문자열 값만 받아서 Y/N으로
const OPTIONS = [
  { value: 'Y', label: BILLING_LABEL(true) },
  { value: 'N', label: BILLING_LABEL(false) },
] as const

const Saving = () => <span className="pb-1.5 text-[12px] text-ops-sub">저장 중…</span>

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-t border-ops-line pt-4 first:border-t-0 first:pt-0">
      <h3 className="text-[14px] font-semibold">{title}</h3>
      {children}
    </section>
  )
}

export function PaymentSettingsModal({ id, onClose }: { id: number; onClose: () => void }) {
  const vm = usePaymentForm(id)

  return (
    <Modal
      title="결제 설정"
      width={480}
      onClose={onClose}
      footer={
        // 이미 저장됐으니 '취소'가 아니라 '닫기'
        <Btn className="ml-auto" onClick={onClose}>
          닫기
        </Btn>
      }
    >
      <p className="mb-4 text-[13px] text-ops-sub">누르면 바로 저장됩니다.</p>
      {/* fieldset disabled — 저장 중엔 창 안 모든 버튼을 한 번에 잠금 */}
      <fieldset disabled={vm.locked} className="flex flex-col gap-4">
        <Section title="개인 카드">
          <span className="flex items-center gap-2 text-[13px] text-ops-sub">
            <Badge tone="done">항상 사용</Badge>
            모든 사원이 쓸 수 있어 끌 수 없습니다.
          </span>
        </Section>

        <Section title="월결제">
          {vm.monthlyEnabled !== undefined && (
            <div className="flex items-end gap-2">
              <Choice
                label="이 기업 사원 전체"
                value={vm.monthlyEnabled ? 'Y' : 'N'}
                options={[...OPTIONS]}
                onChange={(v) => vm.setMonthly(v === 'Y')}
              />
              {vm.monthlySaving && <Saving />}
            </div>
          )}
          {vm.monthlyError && <Err>{vm.monthlyError}</Err>}
        </Section>

        <Section title="그룹 카드">
          <p className="text-[12px] text-ops-sub">
            사용하는 부서의 사원만 쓸 수 있습니다. 부서가 없는 사원은 쓸 수 없습니다.
          </p>
          {vm.deptsError ? (
            <Err>{vm.deptsError}</Err>
          ) : vm.deptsLoading ? (
            <SkeletonRows rows={3} />
          ) : vm.deptOptions.length === 0 ? (
            <p className="py-4 text-center text-[13px] text-ops-sub">
              부서가 없습니다. CSV로 사원을 등록할 때 부서를 넣으면 부서가 생깁니다.
            </p>
          ) : (
            <>
              <SelectField
                compact
                label="부서"
                placeholder="부서 선택"
                value={vm.deptValue}
                options={vm.deptOptions}
                onChange={vm.selectDept}
              />
              {vm.dept && (
                <div className="flex flex-col gap-1">
                  <div className="flex items-end gap-2">
                    <Choice
                      label={vm.dept.name}
                      value={vm.dept.enabled ? 'Y' : 'N'}
                      options={[...OPTIONS]}
                      onChange={(v) => vm.setGroup(v === 'Y')}
                    />
                    {vm.dept.saving && <Saving />}
                  </div>
                  {vm.dept.error && <Err>{vm.dept.error}</Err>}
                </div>
              )}
            </>
          )}
        </Section>
      </fieldset>
    </Modal>
  )
}
