// [결제 설정] 창 — 월결제 · 그룹 카드(부서 검색해서 하나씩). 누르는 즉시 저장, 확인 창 없음 (11/11)
import type { ReactNode } from 'react'
import { usePaymentForm } from '@/features/company/hooks/usePaymentForm'
import { BILLING_LABEL } from '@/features/company/labels'
import { Btn } from '@/shared/ui'
import { Choice, Err, SuggestInput } from '@/shared/ui/Field'
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
      {/* fieldset disabled — 저장 중엔 창 안 모든 버튼을 한 번에 잠금 */}
      <fieldset disabled={vm.locked} className="flex flex-col gap-4">
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
          ) : !vm.deptsCount ? (
            <p className="py-4 text-center text-[13px] text-ops-sub">
              부서가 없습니다. CSV로 사원을 등록할 때 부서를 넣으면 부서가 생깁니다.
            </p>
          ) : (
            <>
              <SuggestInput
                label="부서"
                placeholder="부서 이름 검색 · 눌러서 목록에서 선택"
                value={vm.query}
                onChange={vm.setQuery}
                items={vm.matches}
                itemKey={(x) => x.departmentSeq}
                renderItem={(x) => (
                  <span className="flex justify-between gap-2">
                    {x.name}
                    <span className="text-ops-sub">{BILLING_LABEL(x.groupBillingEnabled)}</span>
                  </span>
                )}
                onPick={vm.pickDept}
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
