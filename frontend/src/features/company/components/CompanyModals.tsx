// 기업 창 — 사원 추가 · 수정, CSV로 사원 추가, CSV로 기업 등록, 이름 하나 입력(기업명 · 부서명). 규칙 · 요청은 기존 훅 그대로
// 파일 칸 규칙은 긴 설명 대신 [샘플 파일 받기]로 (샘플 파일에 칸 이름 · 형식이 다 들어 있음)
import type { Member } from '../api/companyApi'
import { downloadExample, type CsvKind, type CsvMember } from '../csvMembers'
import { fmtPhone } from '@/shared/lib/format'
import { MEMBER_ROLE } from '../labels'
import { useCompanyCsv } from '../hooks/useCompanyCsv'
import { useMemberCsv } from '../hooks/useMemberCsv'
import { useMemberForm } from '../hooks/useMemberForm'
import { Btn, Icon, SelectField } from '@/shared/ui'
import { AddressPicker } from '@/shared/ui/AddressPicker'
import { AddressButton, Choice, FileDrop, TextInput } from '@/shared/ui/Field'
import { Modal } from '@/shared/ui/Modal'
import { useState } from 'react'

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

const Example = ({ kind = 'members' }: { kind?: CsvKind }) => (
  <Btn kind="plain" onClick={() => downloadExample(kind)} className="self-start">
    <Icon name="download" />
    샘플 파일 받기
  </Btn>
)

export function MemberFormModal({
  companyId,
  companyName,
  member,
  onClose,
  onCsv,
  initialDept = null,
}: {
  companyId: number
  companyName: string
  member: Member | null // null = 추가
  onClose: () => void
  initialDept?: number | null
  onCsv?: () => void // 추가 창에서 CSV 일괄 등록 창으로 바꿈 (화면의 CSV 버튼을 이 창 안으로)
}) {
  const vm = useMemberForm(companyId, member, onClose, initialDept)
  return (
    <Modal
      title={vm.editing ? '사원 수정' : '사원 추가'}
      sub={companyName}
      width={560}
      onClose={onClose}
      footer={vm.searching ? null : <MemberFooter vm={vm} onClose={onClose} />}
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
          {!vm.editing && onCsv && (
            <Btn onClick={onCsv} className="self-start">
              <Icon name="sheet" />
              CSV 파일로 일괄 등록
            </Btn>
          )}
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
            <div className="flex flex-col gap-1">
              <Choice label="구분" value={vm.form.role} options={ROLES} onChange={vm.setRole} />
              {vm.errors.role && (
                <p role="alert" className="text-[12px] text-ops-stop">
                  {vm.errors.role}
                </p>
              )}
            </div>
            <SelectField
              label="부서"
              value={vm.form.dept}
              onChange={vm.setDept}
              options={vm.deptOptions}
            />
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
        <CsvTable rows={vm.rows} />
      </div>
    </Modal>
  )
}

/** 올린 파일에서 읽은 사원 — 등록 전에 그대로 확인 (엑셀에서 앞 0이 사라져 보여도 여기선 010-1234-5678)
 *  mark = 사원 추가에서 신규 · 바뀜 · 그대로 */
function CsvTable({ rows }: { rows: (CsvMember & { mark?: string })[] }) {
  if (!rows.length) return null
  const marked = rows.some((r) => r.mark)
  const withCompany = rows.some((r) => r.company)
  return (
    <section aria-label="읽은 사원" className="flex flex-col gap-1.5">
      <p className="text-[12px] text-ops-sub">읽은 사원 {rows.length}명</p>
      <div className="max-h-[232px] [scrollbar-width:thin] overflow-y-auto rounded-md ring-1 ring-ops-line">
        <table className="w-full text-[13px] tabular-nums">
          <thead className="sticky top-0 bg-[#e8eff8] text-[12px] font-semibold">
            <tr className="[&>th]:h-8 [&>th]:px-3 [&>th]:text-left">
              {marked && <th className="w-16">구분</th>}
              {withCompany && <th className="w-24">기업</th>}
              <th className="w-20">사번</th>
              <th>이름</th>
              <th className="w-32">전화번호</th>
              <th className="w-16">담당자</th>
              <th>부서</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.line}
                className="border-t border-ops-line [&>td]:h-8 [&>td]:truncate [&>td]:px-3"
              >
                {marked && (
                  <td className={r.mark === '그대로' ? 'text-ops-faint' : 'text-ops-route'}>
                    {r.mark}
                  </td>
                )}
                {withCompany && <td className="font-semibold">{r.company}</td>}
                <td>{r.employeeNo}</td>
                <td>{r.name}</td>
                <td>{fmtPhone(r.phoneNumber)}</td>
                <td>{r.leader ? '담당자' : ''}</td>
                <td className="text-ops-sub">{r.department ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
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
          <FootNote error={vm.errorMessage} hint={vm.summary} />
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
        <Example kind="companies" />
        <CsvTable rows={vm.members} />
      </div>
    </Modal>
  )
}

/** 이름 하나 입력 창 — 기업명 수정 · 부서 추가 · 부서 이름 변경 공용. 비었거나 그대로면 저장 꺼짐 */
export function NameModal({
  title,
  label,
  initial = '',
  ok = '저장',
  busy,
  error,
  onSave,
  onClose,
}: {
  title: string
  label: string
  initial?: string
  ok?: string
  busy: boolean
  error: string | null
  onSave: (name: string) => void
  onClose: () => void
}) {
  const [value, setValue] = useState(initial)
  const next = value.trim()
  const canSave = !busy && next !== '' && next !== initial
  return (
    <Modal
      title={title}
      width={440}
      onClose={onClose}
      footer={
        <>
          <FootNote error={error} />
          <Btn onClick={onClose}>취소</Btn>
          <Btn kind="primary" type="submit" form="name-modal" disabled={!canSave}>
            {busy ? `${ok} 중…` : ok}
          </Btn>
        </>
      }
    >
      <form
        id="name-modal"
        onSubmit={(e) => {
          e.preventDefault()
          if (canSave) onSave(next)
        }}
      >
        <TextInput label={label} value={value} onChange={setValue} />
      </form>
    </Modal>
  )
}

/** 사원 창 아래 버튼 — 사원은 저장됐는데 주소만 실패했으면 주소만 다시 보내거나 닫기 */
function MemberFooter({
  vm,
  onClose,
}: {
  vm: ReturnType<typeof useMemberForm>
  onClose: () => void
}) {
  if (vm.addressFailMessage)
    return (
      <>
        <FootNote error={vm.addressFailMessage} />
        <Btn onClick={onClose}>닫기</Btn>
        <Btn kind="primary" disabled={vm.retrying} onClick={vm.retryAddress}>
          {vm.retrying ? '저장 중…' : '주소 다시 저장'}
        </Btn>
      </>
    )
  return (
    <>
      <FootNote error={vm.errorMessage} hint={vm.addressHint} />
      <Btn onClick={onClose}>취소</Btn>
      <Btn kind="primary" type="submit" form="member-form" disabled={!vm.canSubmit}>
        {vm.isSubmitting ? '저장 중…' : vm.editing ? '저장' : '추가'}
      </Btn>
    </>
  )
}
