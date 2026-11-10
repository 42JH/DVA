// 고객 패널 수정 모드 — 이름 · 기본 주소(검색) · 상세주소 · 월결제. 전화번호는 서버가 못 바꿔서 잠금
import type { CustomerDto } from '@/shared/customer/customerApi'
import { Btn, ConfirmDialog } from '@/shared/ui'
import { AddressPicker } from '@/shared/ui/AddressPicker'
import { AddressButton, Choice, Err, TextInput } from '@/shared/ui/Field'
import { fmtPhone } from '@/shared/lib/format'
import { useCustomerEdit } from '../hooks/useCustomerEdit'

const MONTHLY = [
  { value: 'on', label: '사용' },
  { value: 'off', label: '미사용' },
] as const // 기업 화면 월결제 문구와 같은 말

export function CustomerEditForm({ before, onDone }: { before: CustomerDto; onDone: () => void }) {
  const vm = useCustomerEdit(before, onDone)
  if (vm.searching)
    return (
      <AddressPicker
        title="기본 주소 검색"
        query={vm.road}
        onPick={vm.pick}
        onClose={vm.closeSearch}
      />
    )
  return (
    <form
      aria-label="고객 정보 수정"
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (vm.canSave) vm.save()
      }}
    >
      <TextInput
        label="이름"
        value={vm.name}
        onChange={vm.setName}
        error={vm.nameError ?? undefined}
      />
      <TextInput
        label="전화번호"
        value={fmtPhone(before.phoneNumber)}
        onChange={() => {}}
        readOnly
      />
      <AddressButton label="기본 주소" value={vm.road} onClick={vm.openSearch} />
      <TextInput
        label="상세주소 (선택)"
        placeholder="동, 호수, 층"
        value={vm.detail}
        onChange={vm.setDetail}
        error={vm.detailError ?? undefined}
      />
      <Choice
        label="개인 월결제"
        value={vm.monthly ? 'on' : 'off'}
        options={[...MONTHLY]}
        onChange={(v) => vm.setMonthly(v === 'on')}
      />
      {vm.error && <Err>{vm.error}</Err>}
      <div className="mt-1 flex items-center gap-2">
        {/* 되돌릴 수 없는 일 — 수정 모드 맨 아래에만 두어 잘못 누를 일을 줄임 */}
        <Btn kind="danger" className="mr-auto" disabled={vm.busy} onClick={vm.askWithdraw}>
          고객 탈퇴
        </Btn>
        <Btn onClick={onDone}>취소</Btn>
        <Btn kind="primary" type="submit" disabled={!vm.canSave}>
          {vm.saving ? '저장 중…' : '저장'}
        </Btn>
      </div>
      {vm.confirming && (
        <ConfirmDialog
          title="이 고객을 탈퇴 처리할까요?"
          target={`${before.name} · ${fmtPhone(before.phoneNumber)}`}
          warn="다시 이용 중으로 되돌릴 수 없습니다. 주문 · 통화 기록은 그대로 남습니다."
          okLabel="탈퇴"
          onOk={vm.withdraw}
          onClose={vm.cancelWithdraw}
          pending={vm.withdrawing}
        />
      )}
    </form>
  )
}
