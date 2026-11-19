import { useReducer, useState } from 'react'
import { ApiError } from '@/shared/api/client'
import type { SearchedAddress } from '@/shared/ui'
import { BOX_TYPES, type BoxKey, type OrderDetail } from '../api/orderApi'
import { orderErrorText } from '../labels'
import { MAX_BOXES, MAX_DOCUMENTS, kstLocal, pickupRange, priceOk } from '../api/orderLimits'
import { buildCustomerPatch, buildOrderPatch, submitMissing } from '../api/orderPatch'
import { useCustomerSuggest, type Suggestion } from './useCustomerSuggest'
import {
  digits,
  draftOf,
  EMPTY_PARTY,
  formFilled,
  itemsErrorOf,
  limitsOf,
  NO_ITEMS,
  PHONE_RULE,
  phoneOk,
  pickupOutOf,
  submitErrorOf,
  toInput,
  type OrderFormValues,
  type PartyDraft,
  type Side,
} from './orderForm'
import { useOrderPayment } from './useOrderPayment'
import { useOrderSubmit } from './useOrderSubmit'
import { fmtNum } from '@/shared/lib/format'

/** 보내는 분 · 받는 분 칸 묶음 */
function partyFields(
  side: Side,
  p: PartyDraft,
  x: {
    set: (patch: Partial<PartyDraft>) => void
    fieldError: (field: string) => string | undefined // 서버 칸별 오류
    suggest: { byName: Suggestion[]; byPhone: Suggestion[] }
    openSearch: () => void
  },
) {
  return {
    name: p.name,
    setName: (v: string) => x.set({ name: v }),
    nameError: x.fieldError(`${side}.name`),
    phone: p.phone,
    setPhone: (v: string) => x.set({ phone: digits(v, 11) }),
    phoneError:
      p.phone && !phoneOk(side, p.phone)
        ? PHONE_RULE[side].message
        : x.fieldError(`${side}.phoneNumber`),
    // 모자란 주소는 빨간 오류가 아니라 버튼 옆 회색 '접수하려면: … 주소(다시 검색)'로만 (다른 모자란 칸과 같게, 11/01)
    addressError: x.fieldError(`${side}.roadAddress`),
    detailError: x.fieldError(`${side}.detailAddress`),
    roadAddress: p.roadAddress,
    openSearch: x.openSearch,
    detailAddress: p.detailAddress,
    setDetailAddress: (v: string) => x.set({ detailAddress: v }),
    // 추천(보내는 분 = 고객, 받는 분 = 주소록)을 칸 아래에. 고르면 한 번에 채움
    suggest: x.suggest,
    // 주소가 없는 고객이면 이름 · 번호만 (주소 칸은 그대로)
    fill: (c: Suggestion) =>
      x.set({
        name: c.name,
        phone: digits(c.phoneNumber, 11),
        ...(c.address && {
          roadAddress: c.address.roadAddress,
          detailAddress: c.address.detailAddress ?? '',
          picked: {
            jibunAddress: c.address.jibunAddress,
            dongName: c.address.dongName,
            postalCode: c.address.postalCode,
          },
        }),
      }),
  }
}

/** 03 주문 추가(수기 접수) · 주문 수정 창 훅 (와이어프레임 03_주문내역_주문추가 · _주문수정, 10/31)
 * order를 주면 수정: 칸을 그 주문(누른 배송 상세, parcelSeq) 값으로 채우고 [저장] = PATCH(바뀐 칸만 + 버전, 11/01). 없으면 추가: 빈 칸 · [접수]
 * 수정 409 VERSION_CONFLICT = 다른 관리자가 먼저 저장 → onConflict(최신으로 다시 채움, 자동 덮어쓰기 금지)
 * 보내는 분 · 받는 분(이름 · 전화번호 · 주소 검색 · 상세주소) + 품목 수량 · 기타 품목 · 물품 가액 · 수거 희망 일시(선택) · 결제 방식 · 요청 사항
 * 주소는 직접 칠 수 없고 검색으로만 고름 (오타 주소로 수거 실패 방지). 접수되면 목록을 다시 받고 창을 닫음 */
export function useOrderForm(
  onDone: (notice?: string, newOrderSeq?: number) => void, // notice = 접수 중단 주문 접수 결과 · newOrderSeq = 초안을 접수해 생긴 주문
  order?: OrderDetail,
  parcelSeq: number | null = null,
  onConflict?: () => void,
) {
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
  const initialPrice = order?.itemPrice?.toString() ?? ''
  const [declaredValue, setDeclaredValue] = useState(initialPrice) // 숫자만
  // 칸 값은 한국 시간 (수거 규칙이 한국 시간 09 ~ 17시라 브라우저 시간대와 상관없이)
  const initialPickup = order?.pickupRequestedAt ? kstLocal(new Date(order.pickupRequestedAt)) : ''
  const [pickupAt, setPickupAt] = useState(initialPickup) // datetime-local 값
  const [request, setRequest] = useState(order?.clientComment ?? '')
  const [searching, setSearching] = useState<Side | null>(null) // 주소 검색 창이 열린 쪽
  // 보내는 분 이름 · 주소를 고쳤을 때 '고객정보에도 저장할까요?' 창 (jiw/order-sender-customer-save.md)
  const [asking, setAsking] = useState(false)
  const pay = useOrderPayment(order, parties.sender.phone) // 보내는 분 = 주문 고객

  const values: OrderFormValues = {
    parties,
    counts,
    etcItem,
    declaredValue,
    pickupAt,
    payment: pay.value,
    request,
  }
  const lim = limitsOf(values, order, { price: initialPrice, pickup: initialPickup }, new Date())
  // 창을 오래 열어 두면 '지금'이 흘러 범위를 벗어남 — 누르는 순간 다시 보고, 벗어났으면 다시 그려 오류 · [접수] 꺼짐
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  const pickupStillOk = () => {
    if (!pickupOutOf(pickupAt, initialPickup, pickupRange(new Date()))) return true
    redraw()
    return false
  }
  // 접수 중단 주문 수정 = 저장하면서 접수 (버튼 이름 [접수], 조건이 다 채워져야 켜짐)
  const collecting = order?.status === 'COLLECTING'
  const showFee = order === undefined || collecting

  const input = () =>
    toInput(values, { order, initialPickup, collecting, shippingFee: lim.shippingFee })
  // 수정: 지금 입력과 원래 값을 비교 — 바뀐 게 없으면 [저장] 꺼짐, 도로명이 바뀌면 좌표가 필요해 아직 못 보냄
  const draft = order ? buildOrderPatch(order, parcelSeq, input()) : null
  // 보내는 분 이름 · 주소가 바뀌었고 주문 고객이 있으면 고객정보 저장 여부를 물음 (전화만 바뀌면 안 물음)
  const customerDraft = order?.customerSeq ? buildCustomerPatch(order, input()) : null
  // 접수하려면 모자란 것 — 버튼 위에 보여 주고, 다 채워져야 [접수]
  const missing = collecting && order ? submitMissing(order, input()) : []
  // 접수 중단: 바뀐 게 없어도 조건만 채워지면 접수 · 수정: 바뀐 게 있고 도로명은 그대로
  const changeOk =
    !draft || (collecting ? missing.length === 0 : draft.patch !== null && !draft.roadChanged)

  const suggest = useCustomerSuggest(parties.sender, parties.receiver, order?.customerSeq ?? null)
  const send = useOrderSubmit({
    order,
    onDone,
    onConflict,
    input,
    shippingFee: lim.shippingFee,
    collecting,
    patch: draft?.patch ?? null,
    customerDraft,
    payCustomerSeq: pay.customerSeq,
  })
  const submitNow = (monthly: boolean) => {
    if (customerDraft) setAsking(true)
    else send.mutation.mutate({ alsoCustomer: false, monthly })
  }

  // 서버 칸별 오류 (명세서 error.details) — 칸 아래에. 화면 검사가 먼저 걸러서 보통은 안 옴
  const err = send.mutation.error
  const details = err instanceof ApiError ? err.details : []
  const fieldError = (field: string) => details.find((d) => d.field === field)?.reason
  const party = (side: Side) =>
    partyFields(side, parties[side], {
      set: (patch) => setParties((all) => ({ ...all, [side]: { ...all[side], ...patch } })),
      fieldError,
      suggest: suggest[side],
      openSearch: () => setSearching(side),
    })

  return {
    showFee, // 배송비 칸
    submitLabel: showFee ? '접수' : '저장',
    missing, // '접수하려면: 배송비 · 받는 분 주소(다시 검색)'
    sender: party('sender'),
    receiver: party('receiver'),

    items: BOX_TYPES.map((b) => ({
      key: b.key,
      label: b.label,
      count: counts[b.key],
      // 박스는 셋 합계가 10을 넘지 않게 — 남은 개수까지만 [+]
      max: b.key === 'document' ? MAX_DOCUMENTS : MAX_BOXES - lim.boxTotal + counts[b.key],
      setCount: (n: number) => setCounts((c) => ({ ...c, [b.key]: n })),
    })),
    itemsError: itemsErrorOf(lim, showFee),
    etcItem,
    setEtcItem,
    declaredValue,
    setDeclaredValue: (v: string) => setDeclaredValue(digits(v, 10)),
    priceInRange: declaredValue !== '' && priceOk(Number(declaredValue)), // 1원 ~ 1억 (구간 고르기에서 범위 밖 금액은 '구간 선택')
    shippingFee: lim.shippingFee ? `${fmtNum(lim.shippingFee)}원` : '', // 잠긴 칸은 suffix를 안 그림
    pickupAt,
    setPickupAt,
    pickupMin: lim.pickup.min,
    pickupMax: lim.pickup.max,
    pickupError: lim.pickupOut
      ? '09:00 ~ 17:00 사이, 지금부터 1시간 뒤 ~ 3일 안으로 골라 주세요.'
      : fieldError('pickupRequestedAt'),
    etcError: fieldError('items.other'),
    priceError: lim.priceOut ? '1원 ~ 1억 원 사이로 입력해 주세요.' : fieldError('itemPrice'),
    requestError: fieldError('clientComment'),
    payment: pay.value,
    paymentOptions: pay.options,
    paymentText: pay.text,
    setPayment: pay.choose,
    paymentLocked: pay.locked,
    paymentError: pay.error,
    paymentHint: pay.hint,
    askingMonthly: pay.asking,
    monthlyName: parties.sender.name.trim() || '이 고객',
    agreeMonthly: () => {
      if (pay.agree() && pickupStillOk()) submitNow(true)
    },
    declineMonthly: pay.decline,

    request,
    setRequest,

    // 주소 검색 창 (폼 창 대신 뜸 — 두 창이 겹치면 Esc가 둘 다 닫음)
    searching: searching !== null,
    searchTitle: searching === 'receiver' ? '받는 분 주소 검색' : '보내는 분 주소 검색',
    // 이미 채운 도로명으로 바로 검색. 상세주소는 넣으면 결과가 안 나올 수 있어 뺌
    searchQuery: searching ? parties[searching].roadAddress : '',
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
      formFilled(values, lim, order === undefined) &&
      changeOk &&
      !pay.blocked &&
      !send.customerFail && // 주문은 이미 저장됨 → 고객 재시도 · 닫기만
      !send.finished &&
      !send.mutation.isPending,
    isSubmitting: send.mutation.isPending,
    submitError: submitErrorOf(err, order ? '저장' : '접수'),
    // 수정에서 보내는 분 이름 · 주소가 바뀌었으면 먼저 묻고, 아니면 바로 저장
    submit: () => {
      if (!pickupStillOk()) return
      // 월결제이 기본으로 골라져 있어 아직 안 물었으면(새 주문) 여기서 물음
      if (pay.mustAsk) return pay.askThenSubmit()
      submitNow(pay.adding)
    },
    asking,
    answer: (alsoCustomer: boolean) => {
      setAsking(false)
      if (pickupStillOk()) send.mutation.mutate({ alsoCustomer, monthly: pay.adding }) // 묻는 창을 띄워 둔 사이에도 시간이 흐름
    },
    customerFailMessage: send.customerFail
      ? `주문은 수정됐지만 고객정보 저장에 실패했습니다. ${orderErrorText(send.retry.error ?? send.customerFail.error, '저장')}`
      : null,
    retryCustomer: () => send.customerFail && send.retry.mutate(send.customerFail.body),
    retrying: send.retry.isPending,
    finish: () => void send.finish(), // 고객 저장을 포기하고 닫기 (주문 수정은 유지)
  }
}
