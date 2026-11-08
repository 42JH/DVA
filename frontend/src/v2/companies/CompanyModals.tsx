// v2 기업 창 셋 — 사원 추가 · 수정, CSV로 사원 추가, CSV로 기업 등록. 규칙 · 요청은 기존 훅 그대로 (화면만 v2)
// 파일 칸 규칙은 긴 설명 대신 [예시 파일 받기]로 (예시 파일에 칸 이름 · 형식이 다 들어 있음)
import type { Member } from '@/features/company/api/companyApi'
import { downloadExample } from '@/features/company/csvMembers'
import { MEMBER_ROLE } from '@/features/company/labels'
import { useCompanyCsv } from '@/features/company/hooks/useCompanyCsv'
import { useMemberCsv } from '@/features/company/hooks/useMemberCsv'
import { useMemberForm } from '@/features/company/hooks/useMemberForm'
import { Btn, Icon } from '@/v2/ui'
import { AddressPicker } from '@/v2/ui/AddressPicker'
import { AddressButton, Choice, FileDrop, TextInput } from '@/v2/ui/Field'
import { Modal } from '@/v2/ui/Modal'

const ROLES = (['MEMBER', 'ORG_ADMIN'] as const).map((r) => ({ value: r, label: MEMBER_ROLE[r] }))
const note = 'min-w-0 flex-1 text-[12px]'

/** 아래 줄 왼쪽 — 오류(빨강)나 안내(회색) 한 줄 */
const FootNote = ({ error, hint }: { error?: string | null; hint?: string | null }) =>
  error ? (
    <p role="alert" className={`${note} text-ops-stop`}>
      {error}
    </p>
  ) : (
    <p className={`${note} text-ops-sub`}>{hint}</p>
  )

const Example = () => (
  <Btn kind="ghost" onClick={downloadExample} className="self-start">
    <Icon name="download" />
    예시 파일 받기
  </Btn>
)

export function MemberFormModal({
  companyId,
  companyName,
  member,
  onClose,
}: {
  companyId: number
  companyName: string
  member: Member | null // null = 추가
  onClose: () => void
}) {
  const vm = useMemberForm(companyId, member, onClose)
  return (
    <Modal
      title={vm.editing ? '사원 수정' : '사원 추가'}
      sub={companyName}
      width={560}
      onClose={onClose}
      footer={
        vm.searching ? null : vm.addressFailMessage ? (
          // 사원은 저장됨 — 주소만 다시 보내거나 닫기
          <>
            <FootNote error={vm.addressFailMessage} />
            <Btn onClick={onClose}>닫기</Btn>
            <Btn kind="primary" disabled={vm.retrying} onClick={vm.retryAddress}>
              {vm.retrying ? '저장 중…' : '주소 다시 저장'}
            </Btn>
          </>
        ) : (
          <>
            <FootNote error={vm.errorMessage} hint={vm.addressHint} />
            <Btn onClick={onClose}>취소</Btn>
            <Btn kind="primary" type="submit" form="member-form" disabled={!vm.canSubmit}>
              {vm.isSubmitting ? '저장 중…' : vm.editing ? '저장' : '추가'}
            </Btn>
          </>
        )
      }
    >
      {vm.searching ? (
        <AddressPicker title="사원 주소 검색" onPick={vm.pickAddress} onClose={vm.closeSearch} />
      ) : (
        <form
          id="member-form"
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (vm.canSubmit) vm.submit()
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            {/* 사번은 사원을 찾는 키 — 수정에선 잠금 */}
            <TextInput
              label="사번"
              value={vm.form.employeeNo}
              onChange={vm.setEmployeeNo}
              readOnly={vm.editing}
              error={vm.errors.employeeNo}
            />
            <TextInput label="이름" value={vm.form.name} onChange={vm.setName} />
            <TextInput
              label="전화번호"
              inputMode="tel"
              placeholder="010-1234-5678"
              value={vm.form.phone}
              onChange={vm.setPhone}
              error={vm.errors.phone}
            />
            <Choice label="역할" value={vm.form.role} options={ROLES} onChange={vm.setRole} />
          </div>
          <AddressButton value={vm.road} onClick={vm.openSearch} />
          <TextInput
            label="상세주소 (선택)"
            placeholder="동, 호수, 층"
            value={vm.form.detail}
            onChange={vm.setDetail}
            error={vm.errors.detail}
          />
        </form>
      )}
    </Modal>
  )
}

export function MemberCsvModal({
  companyId,
  companyName,
  onClose,
}: {
  companyId: number
  companyName: string
  onClose: () => void
}) {
  const vm = useMemberCsv(companyId, onClose)
  return (
    <Modal
      title="CSV로 사원 추가"
      sub={companyName}
      width={560}
      onClose={onClose}
      footer={
        <>
          <FootNote error={vm.errorMessage} />
          <Btn onClick={onClose}>취소</Btn>
          <Btn kind="primary" disabled={!vm.canSubmit} onClick={vm.submit}>
            {vm.isSubmitting ? '등록 중…' : '등록'}
          </Btn>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FileDrop
          file={vm.file}
          accept=".xlsx,.csv"
          error={vm.fileError}
          onPick={(f) => void vm.pick(f)}
          onRemove={vm.removeFile}
        />
        <Example />
        {vm.comparing && <p className="text-[12px] text-ops-sub">지금 사원과 비교하는 중…</p>}
        {vm.loadError && (
          <p role="alert" className="text-[12px] text-ops-stop">
            {vm.loadError}
          </p>
        )}
        {/* 같은 사번은 파일 내용으로 바뀌어서 먼저 보여 줌 */}
        {vm.preview && (
          <section
            aria-label="미리 보기"
            className="flex flex-col gap-2 rounded-md bg-ops-paper px-4 py-3"
          >
            <p className="text-[13px] font-semibold">{vm.preview.summary}</p>
            {vm.preview.changes.length > 0 && (
              <ul className="flex flex-col gap-1 text-[13px]">
                {vm.preview.changes.map((c) => (
                  <li key={c.key} className="tabular-nums">
                    {c.text}
                  </li>
                ))}
                {vm.preview.moreChanges > 0 && (
                  <li className="text-ops-sub">외 {vm.preview.moreChanges}명</li>
                )}
              </ul>
            )}
          </section>
        )}
      </div>
    </Modal>
  )
}

export function CompanyCsvModal({ onClose }: { onClose: () => void }) {
  const vm = useCompanyCsv(onClose)
  return (
    <Modal
      title="CSV로 기업 등록"
      width={560}
      onClose={onClose}
      footer={
        <>
          <FootNote
            error={vm.errorMessage}
            hint={vm.count > 0 ? `사원 ${vm.count}명을 함께 등록합니다.` : null}
          />
          <Btn onClick={onClose}>취소</Btn>
          <Btn kind="primary" disabled={!vm.canSubmit} onClick={vm.submit}>
            {vm.isSubmitting ? '등록 중…' : '등록'}
          </Btn>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <TextInput label="기업명" value={vm.name} onChange={vm.setName} />
        <FileDrop
          file={vm.file}
          accept=".xlsx,.csv"
          error={vm.fileError}
          onPick={(f) => void vm.pick(f)}
          onRemove={vm.removeFile}
        />
        <Example />
      </div>
    </Modal>
  )
}
