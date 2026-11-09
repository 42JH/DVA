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
} from '@/features/company/api/companyApi'
import { phoneDigits, phoneError, phoneInput } from '@/features/company/csvMembers'
import { errorText } from '@/features/company/labels'

type Role = Member['membership']['role']

/** 08 사원 추가 · 수정 창 훅 — 사번 · 사원명 · 전화번호 · 역할 · 주소(검색) · 상세주소 (주소는 11/01 추가)
 * 추가 = 등록(+대표자면 PATCH) · 수정 = 같은 사번으로 재등록(이름 · 전화 갱신) + 역할이 바뀌면 PATCH. 사번은 수정 불가
 * 주소는 고객 정보라 사원 저장 뒤 따로 PATCH /customers/{customerSeq} → 주소만 실패하면 주소만 다시 보냄 */
export function useMemberForm(companyId: number, target: Member | null, onDone: () => void) {
  const qc = useQueryClient()
  const editing = target !== null
  const before = target?.customer.address ?? null // 지금 고객 주소 (없으면 null)
  const [form, setForm] = useState({
    employeeNo: target?.membership.employeeNo ?? '',
    name: target?.customer.name ?? '',
    phone: phoneInput(target?.customer.phoneNumber ?? ''), // 전화번호 형식 010-1234-5678 (CSV와 같은 모양, 11/06)
    role: target?.membership.role ?? ('MEMBER' as Role),
    detail: before?.detailAddress ?? '',
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

  const no = form.employeeNo.trim()
  const digits = phoneDigits(form.phone)
  const road = picked?.roadAddress ?? before?.roadAddress ?? ''
  // 보낼 주소(전체 교체 객체): 새로 골랐으면 검색 결과, 상세주소만 바꿨으면 원래 주소
  const address: CustomerAddress | null = picked
    ? { ...picked, detailAddress: form.detail.trim() }
    : before && form.detail.trim() !== (before.detailAddress ?? '')
      ? { ...before, detailAddress: form.detail.trim() }
      : null
  // 추가에서 이미 있는 사번 → 서버는 새로 만들지 않고 그 사원을 덮어씀 → 막고 [수정]으로 안내 (11/01 결정)
  const sameNo = editing ? undefined : all.find((m) => m.membership.employeeNo === no)
  // 같은 기업의 다른 사원이 쓰는 번호 → 서버가 전체 거절 → 미리 알림
  const samePhone = all.find(
    (m) =>
      m.customer.phoneNumber === digits &&
      m.membership.membershipSeq !== target?.membership.membershipSeq,
  )
  const detailWithoutRoad = form.detail.trim() !== '' && road === '' // 상세주소만 있으면 저장할 주소가 없음
  // 주소 필수 — CSV 추가와 같은 규칙 · 상단바 사원 검색(DIR-01)이 주소 있는 사원만 찾음 (11/06).
  // 수정에서 원래 주소가 있으면 road가 그 주소라 통과, 없으면 새로 골라야 함
  const noAddress = road === ''

  const save = useMutation({
    mutationFn: async (): Promise<'ok' | 'addressFailed'> => {
      const item = {
        employeeNo: no,
        name: form.name.trim(),
        phoneNumber: digits,
        // 수정은 다시 등록하는 방식 — 부서를 안 보내면 서버가 '부서 없음'으로 바꿈 → 지금 부서 그대로 (11/09 검수)
        ...(editing ? { departmentSeq: target.membership.departmentSeq } : {}),
      }
      const infoChanged =
        !editing || item.name !== target.customer.name || digits !== target.customer.phoneNumber
      if (infoChanged) await addMembers(companyId, [item])
      if (editing) {
        if (form.role !== target.membership.role)
          await setMemberRole(target.membership.membershipSeq, form.role)
      } else if (form.role === 'ORG_ADMIN' && (await assignLeaders(companyId, [no])) > 0)
        throw new Error(
          '사원은 추가했지만 대표자로 지정하지 못했습니다. [수정]에서 다시 지정해 주세요.',
        )
      if (!address) return 'ok'
      // 추가: 등록 응답에 번호가 없어 전체를 다시 받아 사번으로 고객 번호를 찾음 (backend-todo 10)
      const customerSeq = editing
        ? target.customer.customerSeq
        : (await fetchAllMembers(companyId)).find((m) => m.membership.employeeNo === no)?.customer
            .customerSeq
      if (customerSeq === undefined)
        throw new Error(
          '사원은 추가했지만 주소를 저장하지 못했습니다. [수정]에서 다시 넣어 주세요.',
        )
      try {
        await saveCustomerAddress(customerSeq, address)
      } catch (error) {
        setAddressFail({ customerSeq, address, error })
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

  const set = (key: keyof typeof form) => (value: string) => {
    setForm((f) => ({ ...f, [key]: value }))
    if (save.error) save.reset()
  }

  const err = save.error
  const changed =
    !editing ||
    form.name.trim() !== target.customer.name ||
    digits !== target.customer.phoneNumber ||
    form.role !== target.membership.role ||
    address !== null // 주소 · 상세주소만 바꿔도 저장
  return {
    editing,
    form,
    setEmployeeNo: set('employeeNo'),
    setName: set('name'),
    setPhone: (v: string) => set('phone')(phoneInput(v)), // 치는 대로 하이픈
    setRole: (r: Role) => set('role')(r),
    setDetail: set('detail'),

    road,
    searching,
    openSearch: () => setSearching(true),
    closeSearch: () => setSearching(false),
    pickAddress: (a: SearchedAddress) => {
      setPicked(a)
      setSearching(false)
    },

    errors: {
      employeeNo: sameNo
        ? `이미 있는 사번입니다 (${sameNo.customer.name}). 정보를 바꾸려면 [수정]을 눌러 주세요.`
        : undefined,
      phone:
        (form.phone && phoneError(digits)) ||
        (samePhone
          ? `${samePhone.customer.name}(사번 ${samePhone.membership.employeeNo}) 님이 쓰는 번호입니다.`
          : undefined),
      detail: detailWithoutRoad ? '주소를 먼저 검색해 골라 주세요.' : undefined,
    },
    // 대표자 지정 · 주소 번호 찾기 실패는 우리가 만든 문장(Error), 서버 오류는 설명으로 바꿈
    errorMessage: !err
      ? null
      : err instanceof ApiError
        ? errorText(err, editing ? '저장' : '등록')
        : err.message,
    addressFailMessage: addressFail
      ? `사원은 저장됐지만 주소 저장에 실패했습니다. ${errorText(retry.error ?? addressFail.error, '저장')}`
      : null,
    addressHint: noAddress ? '주소를 검색해서 골라 주세요.' : null, // [추가/저장]이 꺼진 이유
    retryAddress: () => retry.mutate(),
    retrying: retry.isPending,
    canSubmit:
      no !== '' &&
      form.name.trim() !== '' &&
      phoneError(digits) === null &&
      !sameNo &&
      !samePhone &&
      !detailWithoutRoad &&
      !noAddress &&
      changed && // 수정에서 아무것도 안 바꿨으면 [저장] 꺼짐 (11/01 결정)
      !addressFail && // 사원은 이미 저장됨 → 주소 재시도 · 닫기만
      !save.isPending,
    isSubmitting: save.isPending,
    submit: () => save.mutate(),
  }
}
