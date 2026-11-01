import {
  AddressField,
  AddressSearchModal,
  Button,
  ChipGroup,
  FormModal,
  TextField,
} from '@/shared/ui'
import type { Member } from '@/features/company/api/companyApi'
import { MEMBER_ROLE } from '@/features/company/labels'
import { useMemberForm } from '@/features/company/hooks/useMemberForm'

const ROLES = (['MEMBER', 'ORG_ADMIN'] as const).map((r) => ({ value: r, label: MEMBER_ROLE[r] }))

// 08 사원 추가 · 수정 창 (Figma 08_기업관리_사원추가 · 사원수정, 11/01) — 기업명 한 줄 → 사번 · 사원명 · 전화번호 · 역할 · 주소(검색) · 상세주소 → [취소] [추가/저장]
// 주소는 처음엔 뺐다가(좌표 필수) 위도 · 경도 1 고정 결정 뒤 디자인대로 넣음 (11/01). '기업 관리자' → '대표자'
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

  // 주소 검색은 폼 대신 띄움 (두 창이 겹치면 Esc가 둘 다 닫아서) — 고르면 돌아오고 적던 내용은 그대로
  if (vm.searching)
    return (
      <AddressSearchModal title="사원 주소 검색" onPick={vm.pickAddress} onClose={vm.closeSearch} />
    )

  return (
    <FormModal
      title={vm.editing ? '사원 수정' : '사원 추가'}
      description={companyName}
      onClose={onClose}
      footer={
        vm.addressFailMessage ? (
          // 사원은 저장됨 — 주소만 다시 보내거나 닫기
          <>
            <p role="alert" className="mr-auto text-label text-danger">
              {vm.addressFailMessage}
            </p>
            <Button onClick={onClose}>닫기</Button>
            <Button kind="primary" disabled={vm.retrying} onClick={vm.retryAddress}>
              {vm.retrying ? '저장 중…' : '주소 다시 저장'}
            </Button>
          </>
        ) : (
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
        )
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
        <AddressField
          label="발송/수신 주소"
          value={vm.road}
          onSearch={vm.openSearch}
          searchLabel="사원 주소 검색"
        />
        <TextField
          label="상세주소"
          inline
          placeholder="선택 (동 · 호수 · 층)"
          value={vm.form.detail}
          onChange={(e) => vm.setDetail(e.target.value)}
          error={vm.errors.detail}
        />
        {/* 칸이 여럿인 form은 제출 버튼이 있어야 Enter로 제출됨 — [추가/저장]은 창 아래(form 밖)라 숨은 버튼 */}
        <button type="submit" hidden />
      </form>
    </FormModal>
  )
}
