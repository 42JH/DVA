import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError } from '@/shared/api/client'
import {
  addMembers,
  companyQueries,
  fetchAllMembers,
  setMemberRole,
  type Member,
} from '@/features/company/api/companyApi'
import { isPhone, phoneDigits } from '@/features/company/csvMembers'
import { errorText } from '@/features/company/labels'

type Role = Member['membership']['role']

/** 08 사원 추가 · 수정 창 훅 — 사번 · 사원명 · 전화번호 · 역할 (주소는 보기만, 11/01 결정 A)
 * 추가 = 등록(+대표자면 PATCH) · 수정 = 같은 사번으로 재등록(이름 · 전화 갱신) + 역할이 바뀌면 PATCH. 사번은 수정 불가 */
export function useMemberForm(companyId: number, target: Member | null, onDone: () => void) {
  const qc = useQueryClient()
  const editing = target !== null
  const [form, setForm] = useState({
    employeeNo: target?.membership.employeeNo ?? '',
    name: target?.customer.name ?? '',
    phone: target?.customer.phoneNumber ?? '',
    role: target?.membership.role ?? ('MEMBER' as Role),
  })
  // 같은 사번 · 전화 검사용 — 상세 화면이 이미 받아 둔 전체 사원(캐시)
  const all = useQuery(companyQueries.allMembers(companyId)).data ?? []

  const no = form.employeeNo.trim()
  const digits = phoneDigits(form.phone)
  // 추가에서 이미 있는 사번 → 서버는 새로 만들지 않고 그 사원을 덮어씀 → 막고 [수정]으로 안내 (11/01 결정)
  const sameNo = editing ? undefined : all.find((m) => m.membership.employeeNo === no)
  // 같은 기업의 다른 사원이 쓰는 번호 → 서버가 전체 거절 → 미리 알림
  const samePhone = all.find(
    (m) =>
      m.customer.phoneNumber === digits &&
      m.membership.membershipSeq !== target?.membership.membershipSeq,
  )

  const save = useMutation({
    mutationFn: async () => {
      const item = { employeeNo: no, name: form.name.trim(), phoneNumber: digits }
      const infoChanged =
        !editing || item.name !== target.customer.name || digits !== target.customer.phoneNumber
      if (infoChanged) await addMembers(companyId, [item])
      if (editing) {
        if (form.role !== target.membership.role)
          await setMemberRole(target.membership.membershipSeq, form.role)
        return
      }
      if (form.role === 'ORG_ADMIN') {
        // 등록 응답엔 번호가 없음 → 전체를 다시 받아 사번으로 찾음 (backend-todo 10)
        const m = (await fetchAllMembers(companyId)).find((x) => x.membership.employeeNo === no)
        if (!m)
          throw new Error(
            '사원은 추가했지만 대표자로 지정하지 못했습니다. [수정]에서 다시 지정해 주세요.',
          )
        await setMemberRole(m.membership.membershipSeq, 'ORG_ADMIN')
      }
    },
    onSettled: () => qc.invalidateQueries({ queryKey: companyQueries.all() }), // 실패해도 등록은 됐을 수 있음
    onSuccess: onDone,
  })

  const set = (key: keyof typeof form) => (value: string) => {
    setForm((f) => ({ ...f, [key]: value }))
    if (save.error) save.reset()
  }

  const err = save.error
  const changed =
    !editing ||
    form.name.trim() !== target.customer.name ||
    digits !== target.customer.phoneNumber ||
    form.role !== target.membership.role
  return {
    editing,
    form,
    setEmployeeNo: set('employeeNo'),
    setName: set('name'),
    setPhone: set('phone'),
    setRole: (r: Role) => set('role')(r),
    errors: {
      employeeNo: sameNo
        ? `이미 있는 사번입니다 (${sameNo.customer.name}). 정보를 바꾸려면 [수정]을 눌러 주세요.`
        : undefined,
      phone:
        form.phone && !isPhone(digits)
          ? '전화번호 형식이 맞지 않습니다.'
          : samePhone
            ? `${samePhone.customer.name}(사번 ${samePhone.membership.employeeNo}) 님이 쓰는 번호입니다.`
            : undefined,
    },
    // 대표자 지정 실패는 우리가 만든 문장(Error), 서버 오류는 설명으로 바꿈
    errorMessage: !err
      ? null
      : err instanceof ApiError
        ? errorText(err, editing ? '저장' : '등록')
        : err.message,
    canSubmit:
      no !== '' &&
      form.name.trim() !== '' &&
      isPhone(digits) &&
      !sameNo &&
      !samePhone &&
      changed && // 수정에서 아무것도 안 바꿨으면 [저장] 꺼짐 (11/01 결정)
      !save.isPending,
    isSubmitting: save.isPending,
    submit: () => save.mutate(),
  }
}
