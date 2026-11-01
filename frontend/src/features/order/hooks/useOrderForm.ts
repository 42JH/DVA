import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import type { Address } from 'react-daum-postcode'
import { fromDateTimeLocal, toDateTimeLocal } from '@/shared/lib/format'
import { ApiError } from '@/shared/api/client'
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
  type PartyInput,
  type PaymentMethod,
  type PickedAddress,
} from '@/features/order/api/orderApi'
import { orderErrorText } from '@/features/order/labels'
import { buildOrderPatch } from '@/features/order/api/orderPatch'

type Side = 'sender' | 'receiver'
/** 입력 중인 칸 그대로 (전부 글자). 보낼 때 Party로 바꿈 */
type PartyDraft = {
  name: string
  phone: string
  roadAddress: string
  detailAddress: string
  picked?: PickedAddress // 주소를 새로 고르면 지번 · 동 · 우편번호 (서버 필수)
}

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
 * order를 주면 수정: 칸을 그 주문(누른 배송 상세, parcelSeq) 값으로 채우고 [저장] = PATCH(바뀐 칸만 + 버전, 11/01). 없으면 추가: 빈 칸 · [접수]
 * 수정 409 VERSION_CONFLICT = 다른 관리자가 먼저 저장 → onConflict(최신으로 다시 채움, 자동 덮어쓰기 금지)
 * 보내는 분 · 받는 분(이름 · 전화번호 · 주소 검색 · 상세주소) + 품목 수량 · 기타 품목 · 물품 가액 · 수거 희망 일시(선택) · 결제 방식 · 요청 사항
 * 주소는 직접 칠 수 없고 검색으로만 고름 (오타 주소로 수거 실패 방지). 접수되면 목록을 다시 받고 창을 닫음 */
export function useOrderForm(
  onDone: () => void,
  order?: OrderDetail,
  parcelSeq: number | null = null,
  onConflict?: () => void,
) {
  const qc = useQueryClient()
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
  const [shippingFee, setShippingFee] = useState('') // 배송비 — 추가에만 (수정은 그대로 유지), 숫자만 · 1원 이상
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
  // 결제 방식은 접수 중단(COLLECTING)일 때만 바꿀 수 있음 (명세 4.3, 11/01). 가짜 주문(status 없음)은 그대로
  const paymentLocked = !!order?.status && order.status !== 'COLLECTING'

  const input = (): OrderInput => {
    const party = (p: PartyDraft): PartyInput => ({
      name: p.name.trim(),
      phoneNumber: p.phone,
      roadAddress: p.roadAddress,
      detailAddress: orNull(p.detailAddress),
      picked: p.picked,
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

  // 수정: 지금 입력과 원래 값을 비교 — 바뀐 게 없으면 [저장] 꺼짐, 도로명이 바뀌면 좌표가 필요해 아직 못 보냄
  const draft = order ? buildOrderPatch(order, parcelSeq, input()) : null

  // 멱등키: 같은 본문을 다시 보내면(실패 후 재시도) 같은 키, 본문이 바뀌면 새 키 (명세서 1.2)
  const sent = useRef<{ body: string; key: string } | null>(null)
  const mutation = useMutation({
    mutationFn: () => {
      const body = input()
      if (order)
        return draft?.patch
          ? saveOrder(order.orderSeq, draft.patch).then(() => undefined)
          : Promise.resolve()
      const fee = Number(shippingFee)
      const json = JSON.stringify([body, fee])
      if (sent.current?.body !== json) sent.current = { body: json, key: crypto.randomUUID() }
      return createOrder(body, fee, sent.current.key).then(() => undefined)
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: orderQueries.all() })
      onDone()
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') onConflict?.()
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
      addressError:
        draft?.roadChanged &&
        p.roadAddress !== (side === 'sender' ? order?.sender : order?.receiver)?.roadAddress
          ? '주소를 다시 검색해서 골라 주세요.'
          : fieldError(`${side}.roadAddress`),
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
    shippingFee,
    setShippingFee: (v: string) => setShippingFee(digits(v, 9)),
    feeError: fieldError('parcels.0.notifiedPrice') ?? fieldError('totalAmount'),
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
    paymentLocked, // 잠겼으면 칩 대신 글자로

    request,
    setRequest,

    // 주소 검색 창 (폼 창 대신 뜸 — 두 창이 겹치면 Esc가 둘 다 닫음)
    searching: searching !== null,
    searchTitle: searching === 'receiver' ? '받는 분 주소 검색' : '보내는 분 주소 검색',
    pickAddress: (a: Address) => {
      // 도로명이 기본. 지번 주소를 골랐으면 도로명이 비어 있을 수 있어 그땐 고른 주소 그대로
      const road = a.roadAddress || a.address
      const picked: PickedAddress = {
        jibunAddress: a.jibunAddress || a.autoJibunAddress, // 도로명을 고르면 지번이 비고 auto에 있음
        dongName: a.bname,
        postalCode: a.zonecode,
      }
      if (searching)
        setParties((all) => ({
          ...all,
          [searching]: { ...all[searching], roadAddress: road, picked },
        }))
      setSearching(null)
    },
    closeSearch: () => setSearching(null),

    canSubmit:
      partyOk(parties.sender) &&
      partyOk(parties.receiver) &&
      hasItem &&
      (order !== undefined || Number(shippingFee) >= 1) && // 추가: 배송비 필수 (명세 4.4, 자동 견적 없음)
      (order !== undefined || (!!parties.sender.picked && !!parties.receiver.picked)) && // 추가: 주소는 검색으로 고른 것만
      declaredValue !== '' && // 물품 가액 필수 (명세 4.4, 11/01 결정)
      !pickupPast &&
      (!draft || (draft.patch !== null && !draft.roadChanged)) && // 수정: 바뀐 게 있고 도로명은 그대로
      !mutation.isPending,
    isSubmitting: mutation.isPending,
    // 칸에 못 붙인 오류 · 칸 오류가 없는 실패(연결 · 409 등)는 버튼 줄에 한 줄
    submitError: !err
      ? null
      : err instanceof ApiError && err.code === 'VERSION_CONFLICT'
        ? null // 창 위에 안내(onConflict)
        : details.length && !unshown
          ? null // 칸 아래에 이미 보임
          : orderErrorText(err, order ? '저장' : '접수'),
    submit: () => mutation.mutate(),
  }
}
