import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { fromDateTimeLocal, toDateTimeLocal } from '@/shared/lib/format'
import type { Option } from '@/shared/ui'
import { PAYMENT_LABEL } from '@/features/order/labels'
import {
  BOX_TYPES,
  createOrder,
  orderQueries,
  type BoxType,
  type OrderInput,
  type PaymentMethod,
} from '@/features/order/api/orderApi'

type Side = 'sender' | 'receiver'
type Party = OrderInput['sender']

const EMPTY_PARTY: Party = { name: '', phone: '', roadAddress: '', detailAddress: '' }
const NO_ITEMS = Object.fromEntries(BOX_TYPES.map((b) => [b, 0])) as Record<BoxType, number>
const PAYMENT_OPTIONS: Option<PaymentMethod>[] = (
  ['credit', 'groupBilling', 'billing'] as const
).map((v) => ({ value: v, label: PAYMENT_LABEL[v] }))

const digits = (v: string, max: number) => v.replace(/\D/g, '').slice(0, max)
const phoneOk = (p: string) => p.length === 10 || p.length === 11

/** 03 주문 추가(수기 접수) 창 훅 (와이어프레임 03_주문내역_주문추가, 10/31)
 * 보내는 분 · 받는 분(이름 · 전화번호 · 주소 검색 · 상세주소) + 품목 수량 · 기타 품목 · 물품 가액 · 수거 희망 일시 · 결제 방식 · 요청 사항
 * 주소는 직접 칠 수 없고 검색으로만 고름 (오타 주소로 수거 실패 방지). 접수되면 목록을 다시 받고 창을 닫음 */
export function useOrderForm(onDone: () => void) {
  const qc = useQueryClient()
  const [parties, setParties] = useState<Record<Side, Party>>({
    sender: EMPTY_PARTY,
    receiver: EMPTY_PARTY,
  })
  const [counts, setCounts] = useState(NO_ITEMS)
  const [etcItem, setEtcItem] = useState('')
  const [declaredValue, setDeclaredValue] = useState('') // 숫자만
  const [pickupAt, setPickupAt] = useState('') // datetime-local 값
  const [payment, setPayment] = useState<PaymentMethod>('credit') // 와이어프레임 기본 = 월정산
  const [request, setRequest] = useState('')
  const [searching, setSearching] = useState<Side | null>(null) // 주소 검색 창이 열린 쪽

  const now = toDateTimeLocal(new Date())
  const pickupPast = pickupAt !== '' && pickupAt <= now // 같은 형식 문자열이라 비교 가능
  const hasItem = BOX_TYPES.some((b) => counts[b] > 0) || etcItem.trim() !== ''
  const partyOk = (p: Party) => p.name.trim() !== '' && phoneOk(p.phone) && p.roadAddress !== ''

  const input = (): OrderInput => {
    const trim = (p: Party): Party => ({
      ...p,
      name: p.name.trim(),
      detailAddress: p.detailAddress.trim(),
    })
    return {
      sender: trim(parties.sender),
      receiver: trim(parties.receiver),
      items: BOX_TYPES.filter((b) => counts[b] > 0).map((b) => ({ box: b, count: counts[b] })),
      etcItem: etcItem.trim(),
      declaredValue: declaredValue ? Number(declaredValue) : null,
      pickupAt: fromDateTimeLocal(pickupAt),
      paymentMethod: payment,
      request: request.trim(),
    }
  }

  // 멱등키: 같은 본문을 다시 보내면(실패 후 재시도) 같은 키, 본문이 바뀌면 새 키 (명세서 1.2)
  const sent = useRef<{ body: string; key: string } | null>(null)
  const mutation = useMutation({
    mutationFn: () => {
      const body = input()
      const json = JSON.stringify(body)
      if (sent.current?.body !== json) sent.current = { body: json, key: crypto.randomUUID() }
      return createOrder(body, sent.current.key)
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: orderQueries.all() })
      onDone()
    },
  })

  const party = (side: Side) => {
    const p = parties[side]
    const set = (patch: Partial<Party>) =>
      setParties((all) => ({ ...all, [side]: { ...all[side], ...patch } }))
    return {
      name: p.name,
      setName: (v: string) => set({ name: v }),
      phone: p.phone,
      setPhone: (v: string) => set({ phone: digits(v, 11) }),
      phoneError: p.phone && !phoneOk(p.phone) ? '10~11자리 숫자로 입력해 주세요.' : undefined,
      roadAddress: p.roadAddress,
      openSearch: () => setSearching(side),
      detailAddress: p.detailAddress,
      setDetailAddress: (v: string) => set({ detailAddress: v }),
    }
  }

  return {
    sender: party('sender'),
    receiver: party('receiver'),

    items: BOX_TYPES.map((b) => ({
      box: b,
      count: counts[b],
      setCount: (n: number) => setCounts((c) => ({ ...c, [b]: n })),
    })),
    etcItem,
    setEtcItem,
    declaredValue,
    setDeclaredValue: (v: string) => setDeclaredValue(digits(v, 10)),
    pickupAt,
    setPickupAt,
    pickupMin: now,
    pickupError: pickupPast ? '지금 이후 시각을 골라 주세요.' : undefined,
    payment,
    paymentOptions: PAYMENT_OPTIONS,
    setPayment,
    request,
    setRequest,

    // 주소 검색 창 (폼 창 대신 뜸 — 두 창이 겹치면 Esc가 둘 다 닫음)
    searching: searching !== null,
    searchTitle: searching === 'receiver' ? '받는 분 주소 검색' : '보내는 분 주소 검색',
    pickAddress: (road: string) => {
      if (searching)
        setParties((all) => ({ ...all, [searching]: { ...all[searching], roadAddress: road } }))
      setSearching(null)
    },
    closeSearch: () => setSearching(null),

    canSubmit:
      partyOk(parties.sender) &&
      partyOk(parties.receiver) &&
      hasItem &&
      pickupAt !== '' &&
      !pickupPast &&
      !mutation.isPending,
    isSubmitting: mutation.isPending,
    submitError: mutation.error?.message ?? null,
    submit: () => mutation.mutate(),
  }
}
