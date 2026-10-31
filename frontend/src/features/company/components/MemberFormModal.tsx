import { Button, ChipGroup, FormModal, TextField } from '@/shared/ui'
import type { Member } from '@/features/company/api/companyApi'
import { MEMBER_ROLE } from '@/features/company/labels'
import { useMemberForm } from '@/features/company/hooks/useMemberForm'

const ROLES = (['MEMBER', 'ORG_ADMIN'] as const).map((r) => ({ value: r, label: MEMBER_ROLE[r] }))

// 08 사원 추가 · 수정 창 (Figma 08_기업관리_사원추가 · 사원수정, 11/01) — 기업명 한 줄 → 사번 · 사원명 · 전화번호 · 역할 → [취소] [추가/저장]
// 디자인과 다른 점 (11/01 결정): 주소 · 상세주소 칸 뺌(좌표 필수라 못 넣음, 목록에서 보기만) · '기업 관리자' → '대표자'
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
    <FormModal
      title={vm.editing ? '사원 수정' : '사원 추가'}
      description={companyName}
      onClose={onClose}
      footer={
        <>
          {vm.errorMessage && (
            <p role="alert" className="mr-auto text-label text-danger">
              {vm.errorMessage}
            </p>
          )}
          <Button onClick={onClose}>취소</Button>
          <Button kind="primary" disabled={!vm.canSubmit} onClick={vm.submit}>
            {vm.editing ? '저장' : '추가'}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (vm.canSubmit) vm.submit()
        }}
      >
        {/* 사번은 사원을 찾는 키 — 수정에선 잠금 */}
        <TextField
          label="사번"
          inline
          locked={vm.editing}
          placeholder="사번"
          value={vm.form.employeeNo}
          onChange={(e) => vm.setEmployeeNo(e.target.value)}
          error={vm.errors.employeeNo}
        />
        <TextField
          label="사원명"
          inline
          placeholder="이름"
          value={vm.form.name}
          onChange={(e) => vm.setName(e.target.value)}
        />
        <TextField
          label="전화번호"
          inline
          inputMode="tel"
          placeholder="숫자만 입력"
          value={vm.form.phone}
          onChange={(e) => vm.setPhone(e.target.value)}
          error={vm.errors.phone}
        />
        <div className="flex items-center gap-4">
          <span className="w-[120px] shrink-0 text-label text-sub">역할</span>
          <ChipGroup
            name="역할"
            compact
            options={ROLES}
            value={vm.form.role}
            onChange={vm.setRole}
          />
        </div>
        {/* 칸이 여럿인 form은 제출 버튼이 있어야 Enter로 제출됨 — [추가/저장]은 창 아래(form 밖)라 숨은 버튼 */}
        <button type="submit" hidden />
      </form>
    </FormModal>
  )
}
