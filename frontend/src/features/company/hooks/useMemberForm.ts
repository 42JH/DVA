import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError } from '@/shared/api/client'
import type { SearchedAddress } from '@/shared/ui'
import {
  addMembers,
  assignLeaders,
  companyQueries,
  fetchAllMembers,
  saveCustomerAddress,
  setMemberRole,
  type CustomerAddress,
  type Member,
} from '../api/companyApi'
import { phoneInput } from '../csvMembers'
import { errorText } from '../labels'
import {
  memberChecks,
  memberErrors,
  memberReady,
  type MemberChecks,
  type MemberFormValues,
  type Role,
} from './memberForm'

/** 추가 = 등록(+담당자면 지정) · 수정 = 같은 사번으로 재등록(이름 · 전화 · 부서 갱신) + 역할이 바뀌면 PATCH */
async function registerMember(
  companyId: number,
  target: Member | null,
  role: Role,
  c: MemberChecks,
) {
  // 부서는 창에서 고른 값 (수정은 다시 등록하는 방식이라 늘 보냄 — 안 보내면 서버가 '부서 없음'으로 바꿈)
  if (c.infoChanged)
    await addMembers(companyId, [
      { employeeNo: c.no, name: c.name, phoneNumber: c.digits, departmentSeq: c.deptSeq },
    ])
  if (target) {
    if (role !== target.membership.role) await setMemberRole(target.membership.membershipSeq, role)
  } else if (role === 'ORG_ADMIN' && (await assignLeaders(companyId, [c.no])) > 0)
    throw new Error(
      '사원은 추가했지만 담당자로 지정하지 못했습니다. [수정]에서 다시 지정해 주세요.',
    )
}

/** 주소를 저장할 고객 번호 — 추가: 등록 응답에 번호가 없어 전체를 다시 받아 사번으로 찾음 (backend-todo 10) */
async function customerSeqOf(companyId: number, target: Member | null, no: string) {
  if (target) return target.customer.customerSeq
  const made = (await fetchAllMembers(companyId)).find((m) => m.membership.employeeNo === no)
  if (!made)
    throw new Error('사원은 추가했지만 주소를 저장하지 못했습니다. [수정]에서 다시 넣어 주세요.')
  return made.customer.customerSeq
}

// 담당자 지정 · 주소 번호 찾기 실패는 우리가 만든 문장(Error), 서버 오류는 설명으로 바꿈
const messageOf = (err: Error | null, action: '저장' | '등록') => {
  if (!err) return null
  return err instanceof ApiError ? errorText(err, action) : err.message
}

/** 08 사원 추가 · 수정 창 훅 — 사번 · 사원명 · 전화번호 · 역할 · 주소(검색) · 상세주소 (주소는 11/01 추가)
 * 추가 = 등록(+담당자면 PATCH) · 수정 = 같은 사번으로 재등록(이름 · 전화 갱신) + 역할이 바뀌면 PATCH. 사번은 수정 불가
 * 주소는 고객 정보라 사원 저장 뒤 따로 PATCH /customers/{customerSeq} → 주소만 실패하면 주소만 다시 보냄 */
export function useMemberForm(
  companyId: number,
  target: Member | null,
  onDone: () => void,
  initialDept: number | null = null, // 추가 창: 부서 목록에서 고른 부서를 미리 골라 둠
) {
  const qc = useQueryClient()
  const editing = target !== null
  const [form, setForm] = useState<MemberFormValues>({
    employeeNo: target?.membership.employeeNo ?? '',
    name: target?.customer.name ?? '',
    phone: phoneInput(target?.customer.phoneNumber ?? ''), // 전화번호 형식 010-1234-5678 (CSV와 같은 모양, 11/06)
    role: target?.membership.role ?? 'MEMBER',
    dept: String((target ? target.membership.departmentSeq : initialDept) ?? ''), // '' = 부서 없음
    detail: target?.customer.address?.detailAddress ?? '',
  })
  const [picked, setPicked] = useState<SearchedAddress | null>(null) // 주소를 새로 고르면
  const [searching, setSearching] = useState(false) // 주소 검색 창 (폼 대신 띄움)
  // 사원은 저장됐는데 주소만 실패 — 주소만 다시 보냄 (사원 등록을 다시 하지 않음)
  const [addressFail, setAddressFail] = useState<{
    customerSeq: number
    address: CustomerAddress
    error: unknown
  } | null>(null)
  // 같은 사번 · 전화 검사용 — 상세 화면이 이미 받아 둔 전체 사원(캐시)
  const all = useQuery(companyQueries.allMembers(companyId)).data ?? []
  const depts = useQuery(companyQueries.departments(companyId)).data ?? []
  const c = memberChecks(form, picked, target, all)

  const save = useMutation({
    mutationFn: async (): Promise<'ok' | 'addressFailed'> => {
      await registerMember(companyId, target, form.role, c)
      if (!c.address) return 'ok'
      const customerSeq = await customerSeqOf(companyId, target, c.no)
      try {
        await saveCustomerAddress(customerSeq, c.address)
      } catch (error) {
        setAddressFail({ customerSeq, address: c.address, error })
        return 'addressFailed'
      }
      return 'ok'
    },
    onSettled: () => qc.invalidateQueries({ queryKey: companyQueries.all() }), // 실패해도 등록은 됐을 수 있음
    onSuccess: (result) => {
      if (result === 'ok') onDone()
    },
  })
  const retry = useMutation({
    mutationFn: () => saveCustomerAddress(addressFail!.customerSeq, addressFail!.address),
    onSettled: () => qc.invalidateQueries({ queryKey: companyQueries.all() }),
    onSuccess: onDone,
  })

  const set = (key: keyof MemberFormValues) => (value: string) => {
    setForm((f) => ({ ...f, [key]: value }))
    if (save.error) save.reset()
  }

  return {
    editing,
    form,
    setEmployeeNo: set('employeeNo'),
    setName: set('name'),
    setPhone: (v: string) => set('phone')(phoneInput(v)), // 치는 대로 하이픈
    setRole: (r: Role) => set('role')(r),
    setDept: set('dept'),
    deptOptions: [
      { value: '', label: '부서 없음' },
      ...depts.map((d) => ({ value: String(d.departmentSeq), label: d.name })),
    ],
    setDetail: set('detail'),

    road: c.road,
    searching,
    openSearch: () => setSearching(true),
    closeSearch: () => setSearching(false),
    pickAddress: (a: SearchedAddress) => {
      setPicked(a)
      setSearching(false)
    },

    errors: memberErrors(c, form.phone),
    errorMessage: messageOf(save.error, editing ? '저장' : '등록'),
    addressFailMessage: addressFail
      ? `사원은 저장됐지만 주소 저장에 실패했습니다. ${errorText(retry.error ?? addressFail.error, '저장')}`
      : null,
    addressHint: c.noAddress ? '주소를 검색해서 골라 주세요.' : null, // [추가/저장]이 꺼진 이유
    retryAddress: () => retry.mutate(),
    retrying: retry.isPending,
    canSubmit:
      memberReady(c) &&
      !addressFail && // 사원은 이미 저장됨 → 주소 재시도 · 닫기만
      !save.isPending,
    isSubmitting: save.isPending,
    submit: () => save.mutate(),
  }
}
