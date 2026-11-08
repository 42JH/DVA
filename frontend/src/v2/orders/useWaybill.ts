// v2 주문 상세(운송장 패널) — GET /orders/{id} 그대로, 고른 배송 상세로 바꿔 끼움. 미완료면 빈 필수 칸을 짚어 줌
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError } from '@/shared/api/client'
import { fmtPhone } from '@/shared/lib/format'
import { dateTime } from '@/v2/lib/when'
import { callKinds } from '@/v2/lib/kinds'
import { cancelOrder, retryOrder } from '@/features/order/api/orderApi'
import { deleteDraft } from '@/features/order/api/draftApi'
import { orderQueries, type Party } from '@/shared/order/orderApi'
import { pickParcel } from '@/shared/order/useOrderDetail'
import { orderNo, PAYMENT_METHOD_LABEL, PAYMENT_STATE_LABEL } from '@/shared/order/labels'
import { itemsText, STATUS_LOOK, won } from './orderLook'

const party = (p: Party) => ({
  name: p.name,
  phone: p.phoneNumber ? fmtPhone(p.phoneNumber) : '',
  address: p.roadAddress,
  detail: p.detailAddress ?? '',
})

export function useWaybill(orderSeq: number, parcelSeq: number | null) {
  const qc = useQueryClient()
  // 30초 안에 받은 상세(줄에 마우스를 올려 미리 받은 것)는 다시 묻지 않음 — 수정 · 취소는 무효화로 새로 받음
  const q = useQuery({ ...orderQueries.detail(orderSeq), staleTime: 30_000 })
  const done = () =>
    qc
      .invalidateQueries({ queryKey: ['orders'] })
      .then(() => qc.invalidateQueries({ queryKey: ['v2'] }))
  // 미완료(배송 초안)는 주문 취소가 아니라 초안 삭제 (서버 숨김)
  const cancel = useMutation({
    mutationFn: () => (orderSeq < 0 ? deleteDraft(-orderSeq) : cancelOrder(orderSeq)),
    onSuccess: () => (orderSeq < 0 ? void qc.invalidateQueries({ queryKey: ['v2'] }) : done()),
  })
  const retry = useMutation({ mutationFn: () => retryOrder(orderSeq), onSuccess: done })

  const o = q.data ? pickParcel(q.data, parcelSeq) : null
  const status = o ? (o.cancelled ? 'CANCELLED' : (o.status ?? null)) : null
  const view = o && {
    no: o.draft?.label ?? orderNo(o.orderSeq),
    isDraft: !!o.draft,
    look: status ? STATUS_LOOK[status] : null,
    acceptedAt: dateTime(o.acceptedAt),
    route:
      o.route === 'PHONE' ? 'AI 전화 접수' : o.manualBy ? `${o.manualBy} 수기 접수` : '수기 접수',
    position: o.position ?? '',
    sender: party(o.sender),
    receiver: party(o.receiver),
    items: itemsText(o.items),
    itemPrice: won(o.itemPrice),
    fee: won(o.notifiedPrice),
    payMethod: o.paymentMethod ? PAYMENT_METHOD_LABEL[o.paymentMethod] : '',
    payState: PAYMENT_STATE_LABEL[o.paymentState],
    pickupAt: dateTime(o.pickupRequestedAt),
    comment: o.clientComment ?? '',
    calls: o.relatedCalls.map((c) => ({
      key: `${c.callSessionSeq}-${c.kind}`,
      seq: c.callSessionSeq,
      at: dateTime(c.startedAt),
      what: c.kind === 'CANCEL' ? '주문 취소 통화' : '접수 통화',
      kinds: c.counts === undefined ? [] : callKinds(c.counts),
      analyzed: c.counts !== null,
    })),
  }
  // 미완료 주문: 접수하려면 채워야 하는 칸 (주문 추가와 같은 규칙 — 물품 가액 · 결제 방식 포함). 기업 피드백: 미완료 사유 · 빈 칸 강조
  const missing = new Set<string>()
  if (o && status === 'COLLECTING') {
    const need = (k: string, ok: unknown) => !ok && missing.add(k)
    need('sender.name', o.sender.name)
    need('sender.phone', o.sender.phoneNumber)
    need('sender.address', o.sender.roadAddress)
    need('receiver.name', o.receiver.name)
    need('receiver.phone', o.receiver.phoneNumber)
    need('receiver.address', o.receiver.roadAddress)
    need('items', itemsText(o.items))
    need('itemPrice', o.itemPrice !== null)
    need('payMethod', o.paymentMethod)
  }

  return {
    view,
    status,
    missing,
    isLoading: q.isPending,
    error: !q.error
      ? null
      : q.error instanceof ApiError && q.error.status === 404
        ? '주문을 찾을 수 없습니다.'
        : '불러오지 못했습니다. 다시 시도해 주세요.',
    canEdit:
      !!status && status !== 'CANCELLED' && !['PAID', 'SUBMITTING', 'ACCEPTED'].includes(status),
    canCancel: status === 'COLLECTING' || status === 'notPaid',
    canRetry: status === 'SUBMISSION_FAILED',
    // after = 끝나면 할 일 (초안 삭제면 패널 닫기 — 지운 초안을 다시 묻지 않게)
    cancel: (after?: () => void) => cancel.mutate(undefined, { onSuccess: () => after?.() }),
    retry: () => retry.mutate(),
    busy: cancel.isPending || retry.isPending,
    actionError:
      cancel.error || retry.error
        ? '처리하지 못했습니다. 상태를 확인하고 다시 시도해 주세요.'
        : null,
  }
}

export type Waybill = ReturnType<typeof useWaybill>
