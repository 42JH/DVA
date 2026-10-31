import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import type { Address } from 'react-daum-postcode'
import { fromDateTimeLocal, toDateTimeLocal } from '@/shared/lib/format'
import { ApiError } from '@/shared/api/client'
import { useSession } from '@/shared/auth/useSession'
import { PAYMENT_METHOD_LABEL } from '@/shared/order/labels'
import type { Option } from '@/shared/ui'
import {
  BOX_TYPES,
  createOrder,
  orderQueries,
  type BoxKey,
  saveOrder,
  type OrderDetail,
  type OrderInput,
  type Party,
  type PaymentMethod,
} from '@/features/order/api/orderApi'

type Side = 'sender' | 'receiver'
/** 입력 중인 칸 그대로 (전부 글자). 보낼 때 Party로 바꿈 */
type PartyDraft = { name: string; phone: string; roadAddress: string; detailAddress: string }

const EMPTY_PARTY: PartyDraft = { name: '', phone: '', roadAddress: '', detailAddress: '' }
const NO_ITEMS = Object.fromEntries(BOX_TYPES.map((b) => [b.key, 0])) as Record<BoxKey, number>
const PAYMENT_OPTIONS: Option<PaymentMethod>[] = (
  ['MONTHLY', 'GROUP_CARD', 'PERSONAL_CARD'] as const
).map((v) => ({ value: v, label: PAYMENT_METHOD_LABEL[v] }))
const orNull = (v: string) => v.trim() || null
// 서버 422 details.field 중 이 창이 칸 아래에 보여 주는 것 (나머지는 아래 버튼 줄에 한 줄로)
const SHOWN_FIELDS = new Set(
  ['sender', 'receiver']
    .flatMap((s) => ['name', 'phoneNumber', 'roadAddress', 'detailAddress'].map((f) => `${s}.${f}`))
    .concat(['items.other', 'itemPrice', 'pickupRequestedAt', 'clientComment']),
)
const draftOf = (p: Party): PartyDraft => ({
  name: p.name,
  phone: p.phoneNumber,
  roadAddress: p.roadAddress,
  detailAddress: p.detailAddress ?? '',
})

const digits = (v: string, max: number) => v.replace(/\D/g, '').slice(0, max)
const phoneOk = (p: string) => p.length === 10 || p.length === 11

/** 03 주문 추가(수기 접수) · 주문 수정 창 훅 (와이어프레임 03_주문내역_주문추가 · _주문수정, 10/31)
 * order를 주면 수정: 칸을 그 주문 값으로 채우고 [저장] = 수정 API. 없으면 추가: 빈 칸 · [접수] = 접수 API
 * 보내는 분 · 받는 분(이름 · 전화번호 · 주소 검색 · 상세주소) + 품목 수량 · 기타 품목 · 물품 가액 · 수거 희망 일시(선택) · 결제 방식 · 요청 사항
 * 주소는 직접 칠 수 없고 검색으로만 고름 (오타 주소로 수거 실패 방지). 접수되면 목록을 다시 받고 창을 닫음 */
export function useOrderForm(onDone: () => void, order?: OrderDetail) {
  const qc = useQueryClient()
  const { me } = useSession()
  // 수정이면 처음 한 번 그 주문 값으로 채움 (창이 열려 있는 동안 서버 값이 바뀌어도 입력 중인 칸은 그대로)
  const [parties, setParties] = useState<Record<Side, PartyDraft>>(() =>
    order
      ? { sender: draftOf(order.sender), receiver: draftOf(order.receiver) }
      : { sender: EMPTY_PARTY, receiver: EMPTY_PARTY },
  )
  const [counts, setCounts] = useState<Record<BoxKey, number>>(() =>
    order
      ? (Object.fromEntries(BOX_TYPES.map((b) => [b.key, order.items[b.key]])) as Record<
          BoxKey,
          number
        >)
      : NO_ITEMS,
  )
  const [etcItem, setEtcItem] = useState(order?.items.other ?? '')
  const [declaredValue, setDeclaredValue] = useState(order?.itemPrice?.toString() ?? '') // 숫자만
  const initialPickup = order?.pickupRequestedAt
    ? toDateTimeLocal(new Date(order.pickupRequestedAt))
    : ''
  const [pickupAt, setPickupAt] = useState(initialPickup) // datetime-local 값
  const [payment, setPayment] = useState<PaymentMethod>(order?.paymentMethod ?? 'MONTHLY') // 와이어프레임 기본 = 월정산
  const [request, setRequest] = useState(order?.clientComment ?? '')
  const [searching, setSearching] = useState<Side | null>(null) // 주소 검색 창이 열린 쪽

  const now = toDateTimeLocal(new Date())
  // 같은 형식 문자열이라 비교 가능. 수정에서 원래 값을 안 건드렸으면 지났어도 통과 (이미 지난 주문의 다른 칸만 고칠 때)
  const pickupPast = pickupAt !== '' && pickupAt !== initialPickup && pickupAt <= now
  const hasItem = BOX_TYPES.some((b) => counts[b.key] > 0) || etcItem.trim() !== ''
  const partyOk = (p: PartyDraft) =>
    p.name.trim() !== '' && phoneOk(p.phone) && p.roadAddress !== ''

  const input = (): OrderInput => {
    const party = (p: PartyDraft): Party => ({
      name: p.name.trim(),
      phoneNumber: p.phone,
      roadAddress: p.roadAddress,
      detailAddress: orNull(p.detailAddress),
    })
    return {
      sender: party(parties.sender),
      receiver: party(parties.receiver),
      items: { ...counts, other: orNull(etcItem) },
      declaredValue: declaredValue ? Number(declaredValue) : null,
      pickupAt: pickupAt ? fromDateTimeLocal(pickupAt) : null,
      paymentMethod: payment,
      request: orNull(request),
    }
  }

  // 멱등키: 같은 본문을 다시 보내면(실패 후 재시도) 같은 키, 본문이 바뀌면 새 키 (명세서 1.2)
  const sent = useRef<{ body: string; key: string } | null>(null)
  const mutation = useMutation({
    mutationFn: () => {
      const body = input()
      if (order) return saveOrder(order.orderSeq, body)
      const json = JSON.stringify(body)
      if (sent.current?.body !== json) sent.current = { body: json, key: crypto.randomUUID() }
      return createOrder(body, sent.current.key, me?.loginId ?? '').then(() => undefined)
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: orderQueries.all() })
      onDone()
    },
  })

  // 서버 칸별 오류 (명세서 error.details) — 칸 아래에. 화면 검사가 먼저 걸러서 보통은 안 옴
  const err = mutation.error
  const details = err instanceof ApiError ? err.details : []
  const fieldError = (field: string) => details.find((d) => d.field === field)?.reason
  const unshown = details.find((d) => !SHOWN_FIELDS.has(d.field))

  const party = (side: Side) => {
    const p = parties[side]
    const set = (patch: Partial<PartyDraft>) =>
      setParties((all) => ({ ...all, [side]: { ...all[side], ...patch } }))
    return {
      name: p.name,
      setName: (v: string) => set({ name: v }),
      nameError: fieldError(`${side}.name`),
      phone: p.phone,
      setPhone: (v: string) => set({ phone: digits(v, 11) }),
      phoneError:
        p.phone && !phoneOk(p.phone)
          ? '10~11자리 숫자로 입력해 주세요.'
          : fieldError(`${side}.phoneNumber`),
      addressError: fieldError(`${side}.roadAddress`),
      detailError: fieldError(`${side}.detailAddress`),
      roadAddress: p.roadAddress,
      openSearch: () => setSearching(side),
      detailAddress: p.detailAddress,
      setDetailAddress: (v: string) => set({ detailAddress: v }),
    }
  }

  return {
    isEdit: order !== undefined,
    sender: party('sender'),
    receiver: party('receiver'),

    items: BOX_TYPES.map((b) => ({
      key: b.key,
      label: b.label,
      count: counts[b.key],
      setCount: (n: number) => setCounts((c) => ({ ...c, [b.key]: n })),
    })),
    etcItem,
    setEtcItem,
    declaredValue,
    setDeclaredValue: (v: string) => setDeclaredValue(digits(v, 10)),
    pickupAt,
    setPickupAt,
    pickupMin: now,
    pickupError: pickupPast ? '지금 이후 시각을 골라 주세요.' : fieldError('pickupRequestedAt'),
    etcError: fieldError('items.other'),
    priceError: fieldError('itemPrice'),
    requestError: fieldError('clientComment'),
    payment,
    paymentOptions: PAYMENT_OPTIONS,
    setPayment,
    request,
    setRequest,

    // 주소 검색 창 (폼 창 대신 뜸 — 두 창이 겹치면 Esc가 둘 다 닫음)
    searching: searching !== null,
    searchTitle: searching === 'receiver' ? '받는 분 주소 검색' : '보내는 분 주소 검색',
    pickAddress: (a: Address) => {
      // 도로명이 기본. 지번 주소를 골랐으면 도로명이 비어 있을 수 있어 그땐 고른 주소 그대로
      const road = a.roadAddress || a.address
      if (searching)
        setParties((all) => ({ ...all, [searching]: { ...all[searching], roadAddress: road } }))
      setSearching(null)
    },
    closeSearch: () => setSearching(null),

    canSubmit:
      partyOk(parties.sender) &&
      partyOk(parties.receiver) &&
      hasItem &&
      !pickupPast &&
      !mutation.isPending,
    isSubmitting: mutation.isPending,
    // 칸에 못 붙인 오류 · 칸 오류가 없는 실패(연결 · 409 등)는 버튼 줄에 한 줄
    submitError: !err
      ? null
      : unshown
        ? unshown.reason
        : details.length
          ? null
          : err instanceof ApiError && err.status === 409
            ? '같은 요청을 처리하는 중입니다. 잠시 뒤 목록을 확인해 주세요.'
            : err.message,
    submit: () => mutation.mutate(),
  }
}
