// 고객 정보 수정 — 패널 수정 모드. 이름 · 기본 주소(검색) + 상세주소 · 월결제 자격. 바뀐 칸만 PATCH
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError } from '@/shared/api/client'
import type { Address, CustomerDto } from '@/shared/customer/customerApi'
import { customerQueries } from '@/shared/customer/customerApi'
import type { SearchedAddress } from '@/shared/ui'
import { updateCustomer, type CustomerUpdate } from '../api/customerApi'

function saveError(e: unknown) {
  if (!(e instanceof ApiError)) return '저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.'
  if (e.status === 0) return '서버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.'
  if (e.status === 404) return '고객을 찾을 수 없습니다. 이미 삭제됐을 수 있어요.'
  return e.message // 서버 문장이 가장 정확 (400 · 409)
}

/** before = 지금 고객(상세 조회 결과). 패널이 불러온 뒤에만 수정 모드를 열어서 항상 있음 */
export function useCustomerEdit(before: CustomerDto, onDone: () => void, onWithdrawn: () => void) {
  const qc = useQueryClient()
  const [name, setName] = useState(before.name)
  const [detail, setDetail] = useState(before.address?.detailAddress ?? '')
  const [monthly, setMonthly] = useState(before.monthlyBillingEnabled)
  const [picked, setPicked] = useState<SearchedAddress | null>(null) // 주소를 새로 고르면
  const [searching, setSearching] = useState(false) // 주소 검색 화면을 칸 자리에 펼침

  const trimmedName = name.trim()
  const trimmedDetail = detail.trim()
  const road = picked?.roadAddress ?? before.address?.roadAddress ?? ''
  // 주소는 객체 통째로 교체 — 새로 골랐으면 검색 결과, 상세주소만 바꿨으면 원래 주소에 상세만 새로
  const address: Address | undefined = picked
    ? { ...picked, detailAddress: trimmedDetail }
    : before.address && trimmedDetail !== (before.address.detailAddress ?? '')
      ? { ...before.address, detailAddress: trimmedDetail }
      : undefined

  const changes: CustomerUpdate = {
    ...(trimmedName !== before.name && { name: trimmedName }),
    ...(address && { address }),
    ...(monthly !== before.monthlyBillingEnabled && { monthlyBillingEnabled: monthly }),
  }
  const nameError = trimmedName === '' ? '이름을 입력해 주세요.' : null
  const detailError = trimmedDetail !== '' && road === '' ? '기본 주소를 먼저 골라 주세요.' : null

  const [confirming, setConfirming] = useState(false) // 탈퇴 확인 창
  const refresh = () =>
    // 목록 · 상세(+주소록) · 결제 방법(월결제) · 주문 화면 고객 추천이 모두 이 고객을 보여 줌
    Promise.all([
      qc.invalidateQueries({ queryKey: ['screen', 'customers'] }),
      qc.invalidateQueries({ queryKey: ['screen', 'customer', before.customerSeq] }),
      qc.invalidateQueries({ queryKey: ['screen', 'customer-context', before.phoneNumber] }),
      qc.invalidateQueries({ queryKey: customerQueries.all() }),
    ])
  const save = useMutation({
    mutationFn: () => updateCustomer(before.customerSeq, changes),
    onSuccess: async () => {
      await refresh()
      onDone()
    },
  })
  // 탈퇴는 적던 수정과 섞지 않고 상태만 보냄 (확인 창에서 '탈퇴'만 눌렀으니)
  const withdraw = useMutation({
    mutationFn: () => updateCustomer(before.customerSeq, { status: 'WITHDRAWN' }),
    onSuccess: async () => {
      await refresh()
      onWithdrawn()
    },
    onSettled: () => setConfirming(false), // 실패하면 창을 닫고 폼 아래에 오류
  })
  const busy = save.isPending || withdraw.isPending
  const failed = save.error ?? withdraw.error

  return {
    name,
    setName,
    detail,
    setDetail,
    monthly,
    setMonthly,
    road,
    searching,
    openSearch: () => setSearching(true),
    closeSearch: () => setSearching(false),
    pick: (a: SearchedAddress) => {
      setPicked(a)
      setSearching(false)
    },
    nameError,
    detailError,
    canSave: Object.keys(changes).length > 0 && !nameError && !detailError && !busy,
    saving: save.isPending,
    error: failed ? saveError(failed) : null,
    save: () => {
      withdraw.reset()
      save.mutate()
    },
    busy,
    confirming,
    askWithdraw: () => setConfirming(true),
    cancelWithdraw: () => setConfirming(false),
    withdrawing: withdraw.isPending,
    withdraw: () => {
      save.reset()
      withdraw.mutate()
    },
  }
}
