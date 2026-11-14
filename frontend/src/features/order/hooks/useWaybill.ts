// 주문 상세(운송장 패널) — GET /orders/{id} 그대로, 고른 배송 상세로 바꿔 끼움. 미완료면 빈 필수 칸을 짚어 줌
import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError } from '@/shared/api/client'
import { fmtPhone } from '@/shared/lib/format'
import { dateTime } from '@/shared/lib/when'
import { callKinds } from '@/shared/lib/kinds'
import { cancelOrder, retryOrder, type OrderStatus } from '@/features/order/api/orderApi'
import { deleteDraft } from '@/features/order/api/draftApi'
import { orderQueries, type Party } from '@/shared/order/orderApi'
import { pickParcel } from '@/shared/order/useOrderDetail'
import {
  orderNo,
  PAYMENT_METHOD_LABEL,
  PAYMENT_STATE_LABEL,
  priceBand,
} from '@/shared/order/labels'
import { itemsText, STATUS_LOOK, won } from '@/shared/order/look'

// [디버에 다시 접수] 응답 상태 → 안내 (11/10). 성공(ACCEPTED)은 뱃지 · 버튼이 바뀌어 안내 없음
// SUBMITTING = 서버가 결과 저장에 실패 — 디버엔 접수됐을 수 있어 바로 다시 누르지 않게 (order-submission.service finishSubmission)
const RETRY_NOTICE: Partial<Record<OrderStatus, { text: string; tone: 'stop' | 'wait' }>> = {
  SUBMISSION_FAILED: {
    text: '디버에 다시 보냈지만 접수되지 않았어요. 주소 · 물품을 확인하고 다시 시도해 주세요.',
    tone: 'stop',
  },
  SUBMITTING: {
    text: '디버 응답을 확인하는 중이에요. 잠시 뒤 상태를 확인해 주세요. 바로 다시 누르지 마세요.',
    tone: 'wait',
  },
}

const party = (p: Party) => ({
  name: p.name,
  phone: p.phoneNumber ? fmtPhone(p.phoneNumber) : '',
  address: p.roadAddress,
  detail: p.detailAddress ?? '',
})

/** 상세를 못 받았을 때 한 줄. gone = 보던 미완료 주문이 목록에서 빠짐 */
const loadError = (error: unknown, gone: boolean) => {
  if (!error) return null
  if (gone)
    return '이 미완료 주문은 목록에서 빠졌습니다. 24시간이 지났거나, 더 최근 통화로 정리됐거나, 이미 처리됐습니다.'
  return error instanceof ApiError && error.status === 404
    ? '주문을 찾을 수 없습니다.'
    : '불러오지 못했습니다. 다시 시도해 주세요.'
}

export function useWaybill(orderSeq: number, parcelSeq: number | null) {
  const qc = useQueryClient()
  // 30초 안에 받은 상세(줄에 마우스를 올려 미리 받은 것)는 다시 묻지 않음 — 수정 · 취소는 무효화로 새로 받음
  const q = useQuery({ ...orderQueries.detail(orderSeq), staleTime: 30_000 })
  // 미완료가 사라졌으면(24시간 지남 · 더 최신 통화로 정리 · 다른 관리자가 처리) 404 → 목록 · 건수를 다시 읽음 (백엔드 후속 명세 11/09)
  const gone = orderSeq < 0 && q.error instanceof ApiError && q.error.status === 404
  useEffect(() => {
    if (gone) void qc.invalidateQueries({ queryKey: ['screen'] })
  }, [gone, qc])
  const done = () =>
    qc
      .invalidateQueries({ queryKey: ['orders'] })
      .then(() => qc.invalidateQueries({ queryKey: ['screen'] }))
  // 미완료(배송 초안)는 주문 취소가 아니라 초안 삭제 (서버 숨김)
  const cancel = useMutation({
    mutationFn: () => (orderSeq < 0 ? deleteDraft(-orderSeq) : cancelOrder(orderSeq)),
    onSuccess: () => (orderSeq < 0 ? void qc.invalidateQueries({ queryKey: ['screen'] }) : done()),
    // 지우려던 미완료가 이미 사라졌으면 목록만 다시 읽음
    onError: (e) => {
      if (orderSeq < 0 && e instanceof ApiError && e.status === 404)
        void qc.invalidateQueries({ queryKey: ['screen'] })
    },
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
    itemPrice: o.itemPrice === null ? '' : priceBand(o.itemPrice).label,
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
    missing,
    error: loadError(q.error, gone),
    canEdit:
      !!status && status !== 'CANCELLED' && !['PAID', 'SUBMITTING', 'ACCEPTED'].includes(status),
    canCancel: status === 'COLLECTING' || status === 'notPaid',
    canRetry: status === 'SUBMISSION_FAILED',
    // after = 끝나면 할 일 (초안 삭제면 패널 닫기 — 지운 초안을 다시 묻지 않게)
    cancel: (after?: () => void) => cancel.mutate(undefined, { onSuccess: () => after?.() }),
    // after = 성공하면 할 일 (확인 창 닫기 — 다시 실패해도 버튼이 남아 창이 저절로 안 닫힘)
    retry: (after?: () => void) => retry.mutate(undefined, { onSuccess: () => after?.() }),
    busy: cancel.isPending || retry.isPending,
    // 다시 누르면(mutate) 지난 응답이 지워져 안내도 사라짐
    retryNotice: retry.data ? (RETRY_NOTICE[retry.data.data.status] ?? null) : null,
    actionError:
      cancel.error || retry.error
        ? '처리하지 못했습니다. 상태를 확인하고 다시 시도해 주세요.'
        : null,
  }
}

export type Waybill = ReturnType<typeof useWaybill>
