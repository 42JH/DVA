import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { fromDateTimeLocal, toDateTimeLocal } from '@/shared/lib/format'
import { ApiError } from '@/shared/api/client'
import { PAYMENT_METHOD_LABEL } from '@/shared/order/labels'
import type { Option, SearchedAddress } from '@/shared/ui'
import {
  BOX_TYPES,
  createOrder,
  patchCustomer,
  submitOrder,
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
import {
  buildCustomerPatch,
  buildOrderPatch,
  submitMissing,
  type CustomerPatch,
} from '@/features/order/api/orderPatch'

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
// 접수 중단 주문 접수 결과(응답 status) → 목록 위 한 줄. ACCEPTED만 디버 접수 완료
const SUBMIT_RESULT: Partial<Record<string, string>> = {
  ACCEPTED: '접수했습니다.',
  notPaid: '접수했습니다. 고객 결제를 기다리는 중이에요.',
  PAID: '접수했습니다. 디버 접수를 이어서 진행해요.',
  SUBMITTING: '접수를 처리하는 중이에요. 잠시 뒤 목록에서 확인해 주세요.',
  SUBMISSION_FAILED: '접수는 됐지만 디버 전송이 실패했어요. 상세에서 [다시 접수]를 눌러 주세요.',
}

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
  onDone: (notice?: string) => void, // notice = 접수 중단 주문 접수 결과 (목록 위 한 줄)
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
  // 배송비 — 추가 · 접수 중단 주문 수정에만 (그 외 수정은 그대로 유지), 숫자만 · 1원 이상
  const [shippingFee, setShippingFee] = useState(order?.notifiedPrice?.toString() ?? '')
  const initialPickup = order?.pickupRequestedAt
    ? toDateTimeLocal(new Date(order.pickupRequestedAt))
    : ''
  const [pickupAt, setPickupAt] = useState(initialPickup) // datetime-local 값
  // 새 주문만 월정산 기본(와이어프레임). 수정은 서버 값 그대로 — 미정(null)을 월정산으로 채우면 안 바꿔도 credit이 나감
  const [payment, setPayment] = useState<PaymentMethod | null>(
    order ? order.paymentMethod : 'MONTHLY',
  )
  const [request, setRequest] = useState(order?.clientComment ?? '')
  const [searching, setSearching] = useState<Side | null>(null) // 주소 검색 창이 열린 쪽
  // 보내는 분 이름 · 주소를 고쳤을 때 '고객정보에도 저장할까요?' 창 (jiw/order-sender-customer-save.md)
  const [asking, setAsking] = useState(false)
  // 주문은 저장됐는데 고객정보 저장만 실패 — 고객만 다시 보냄(주문 PATCH는 다시 안 함)
  const [customerFail, setCustomerFail] = useState<{ body: CustomerPatch; error: unknown } | null>(
    null,
  )

  const now = toDateTimeLocal(new Date())
  // 같은 형식 문자열이라 비교 가능. 수정에서 원래 값을 안 건드렸으면 지났어도 통과 (이미 지난 주문의 다른 칸만 고칠 때)
  const pickupPast = pickupAt !== '' && pickupAt !== initialPickup && pickupAt <= now
  const hasItem = BOX_TYPES.some((b) => counts[b.key] > 0) || etcItem.trim() !== ''
  const partyOk = (p: PartyDraft) =>
    p.name.trim() !== '' && phoneOk(p.phone) && p.roadAddress !== ''
  // 결제 방식은 접수 중단(COLLECTING)일 때만 바꿀 수 있음 (명세 4.3, 11/01). 가짜 주문(status 없음)은 그대로
  const paymentLocked = !!order?.status && order.status !== 'COLLECTING'
  // 접수 중단 주문 수정 = 저장하면서 접수 (11/01 결정: 버튼 이름 [접수], 조건이 다 채워져야 켜짐)
  const collecting = order?.status === 'COLLECTING'

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
      shippingFee: collecting ? (shippingFee ? Number(shippingFee) : null) : undefined,
    }
  }

  // 수정: 지금 입력과 원래 값을 비교 — 바뀐 게 없으면 [저장] 꺼짐, 도로명이 바뀌면 좌표가 필요해 아직 못 보냄
  const draft = order ? buildOrderPatch(order, parcelSeq, input()) : null
  // 보내는 분 이름 · 주소가 바뀌었고 주문 고객이 있으면 고객정보 저장 여부를 물음 (전화만 바뀌면 안 물음)
  const customerDraft = order?.customerSeq ? buildCustomerPatch(order, input()) : null
  // 접수하려면 모자란 것 — 버튼 위에 보여 주고, 다 채워져야 [접수]
  const missing = collecting && order ? submitMissing(order, input()) : []
  const submitNotice = useRef<string | undefined>(undefined) // 접수 결과 — 고객정보 재시도 뒤 닫을 때도 전달
  const finish = async () => {
    await qc.invalidateQueries({ queryKey: orderQueries.all() }) // 다 끝난 뒤에 — 먼저 하면 새 버전으로 창이 다시 채워짐
    onDone(submitNotice.current)
  }

  // 멱등키: 같은 본문을 다시 보내면(실패 후 재시도) 같은 키, 본문이 바뀌면 새 키 (명세서 1.2)
  const sent = useRef<{ body: string; key: string } | null>(null)
  const mutation = useMutation({
    // alsoCustomer = '고객정보에도 저장'을 골랐는지 (주문 저장이 성공한 뒤에만 고객 PATCH — 별도 트랜잭션)
    mutationFn: async (alsoCustomer: boolean): Promise<'ok' | 'customerFailed'> => {
      const body = input()
      if (order) {
        let version = order.version ?? 0
        if (draft?.patch) version = (await saveOrder(order.orderSeq, draft.patch)).data.version
        // 접수 중단: 저장한 새 버전으로 최종 접수. 실패해도 저장은 유지 — 이유를 들고 상세로 (11/01 결정)
        if (collecting) {
          try {
            const r = await submitOrder(order.orderSeq, version)
            submitNotice.current =
              SUBMIT_RESULT[r.data.status] ?? '접수를 요청했습니다. 목록에서 상태를 확인해 주세요.'
          } catch (e) {
            submitNotice.current = `저장은 됐지만 접수하지 못했어요. ${orderErrorText(e, '접수')}`
          }
        }
        if (alsoCustomer && customerDraft && order.customerSeq) {
          try {
            await patchCustomer(order.customerSeq, customerDraft)
          } catch (error) {
            setCustomerFail({ body: customerDraft, error })
            return 'customerFailed'
          }
        }
        return 'ok'
      }
      const fee = Number(shippingFee)
      const json = JSON.stringify([body, fee])
      if (sent.current?.body !== json) sent.current = { body: json, key: crypto.randomUUID() }
      await createOrder(body, fee, sent.current.key)
      return 'ok'
    },
    onSuccess: (result) => {
      if (result === 'ok') void finish()
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') onConflict?.()
    },
  })

  const retry = useMutation({
    mutationFn: (body: CustomerPatch) => patchCustomer(order!.customerSeq!, body),
    onSuccess: () => void finish(),
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
      // 모자란 주소는 빨간 오류가 아니라 버튼 옆 회색 '접수하려면: … 주소(다시 검색)'로만 (다른 모자란 칸과 같게, 11/01)
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
    showFee: order === undefined || collecting, // 배송비 칸
    submitLabel: order === undefined || collecting ? '접수' : '저장',
    missing, // '접수하려면: 배송비 · 받는 분 주소(다시 검색)'
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
    paymentText: payment ? PAYMENT_METHOD_LABEL[payment] : '미정', // 잠긴 칸 글자 (지점 방문 포함)
    setPayment,
    paymentLocked, // 잠겼으면 칩 대신 글자로

    request,
    setRequest,

    // 주소 검색 창 (폼 창 대신 뜸 — 두 창이 겹치면 Esc가 둘 다 닫음)
    searching: searching !== null,
    searchTitle: searching === 'receiver' ? '받는 분 주소 검색' : '보내는 분 주소 검색',
    pickAddress: ({ roadAddress, ...picked }: SearchedAddress) => {
      if (searching)
        setParties((all) => ({
          ...all,
          [searching]: { ...all[searching], roadAddress, picked },
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
      (!draft ||
        (collecting
          ? missing.length === 0 // 접수 중단: 바뀐 게 없어도 조건만 채워지면 접수
          : draft.patch !== null && !draft.roadChanged)) && // 수정: 바뀐 게 있고 도로명은 그대로
      !customerFail && // 주문은 이미 저장됨 → 고객 재시도 · 닫기만
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
    // 수정에서 보내는 분 이름 · 주소가 바뀌었으면 먼저 묻고, 아니면 바로 저장
    submit: () => (customerDraft ? setAsking(true) : mutation.mutate(false)),
    asking,
    cancelAsk: () => setAsking(false),
    answer: (alsoCustomer: boolean) => {
      setAsking(false)
      mutation.mutate(alsoCustomer)
    },
    customerFailMessage: customerFail
      ? `주문은 수정됐지만 고객정보 저장에 실패했습니다. ${orderErrorText(retry.error ?? customerFail.error, '저장')}`
      : null,
    retryCustomer: () => customerFail && retry.mutate(customerFail.body),
    retrying: retry.isPending,
    finish: () => void finish(), // 고객 저장을 포기하고 닫기 (주문 수정은 유지)
  }
}
