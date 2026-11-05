import { useQuery } from '@tanstack/react-query'
import { ApiError } from '@/shared/api/client'
import { fmtDetailTime, fmtPhone } from '@/shared/lib/format'
import {
  ORDER_GROUP,
  PAYMENT_METHOD_LABEL,
  PAYMENT_STATE_LABEL,
  RELATED_CALL_LABEL,
  orderNo,
  type OrderGroup,
} from './labels'
import { orderQueries, type OrderDetail, type Party } from './orderApi'
import { kindChips, type CallKind } from '@/shared/lib/callKind'

/** 보내는 분 · 받는 분 카드 — 빈 칸은 '' (미완료 주문) */
export interface PartyView {
  name: string
  phone: string // '010-1234-5678'
  address: string // 도로명 + 상세주소 (03 목록과 같은 한 줄)
}

/** 주문 상세 화면용 값 (읽기 전용) — OrderDetailModal이 그림 */
export interface OrderView {
  orderSeq: number
  orderNo: string // 'DV-10519'
  group: OrderGroup | null // 머리 칩 — 03 목록 줄과 같은 칩. 이 상세만 취소됐어도 '주문 취소'
  meta: string // '접수 11-04 (수) 13:12 · AI 전화 접수 · 배송 1/2'
  sender: PartyView
  receiver: PartyView
  info: { label: string; value: string; wide?: boolean }[] // 품목 · 수거 희망 일시 · 결제 방식 · 물품 가액 · 결제 · 고객 요청 사항 (wide = 두 칸 차지)
  relatedCalls: {
    key: string
    callSessionSeq: number
    time: string
    kinds: { kind: CallKind; label: string }[] // 04 통화 목록 줄과 같은 칩 (11/05 사용자: 모양 · 내용 통일)
    analyzed: boolean // false = 분석 전 칩
    text: string
  }[]
  canEdit: boolean // 취소 · 결제 완료(디버 접수 중 · 접수 완료 포함)는 [수정] 없음 (11/05 사용자). 접수 실패는 고쳐서 다시 접수하게 둠
  canCancel: boolean // 결제 전(미완료 · 결제 대기)만 취소 가능 (명세 4.5, 11/01 결정)
  canRetry: boolean // 디버 접수 최종 실패만 [다시 접수] (11/01 결정)
  parcelCount: number // 취소 확인 창 '배송 n건이 모두 취소' — 취소 안 된 상세 수
}

/** 주문 하나 불러와 화면용 값으로 (shared/auth처럼 여러 기능이 쓰는 공통 훅이라 useQuery를 여기서). id가 null이면 안 부름
 * parcelSeq를 주면 그 배송 상세의 보내는 분 · 받는 분 · 품목 (03 목록에서 누른 줄, 11/01). 안 주면 첫 상세 · 합계 (06 팝업) */
export function useOrderDetail(orderId: number | null, parcelSeq?: number | null) {
  const q = useQuery({ ...orderQueries.detail(orderId ?? 0), enabled: orderId !== null })
  return {
    order: q.data ? toView(pickParcel(q.data, parcelSeq)) : null,
    isLoading: orderId !== null && q.isPending,
    error: !q.error
      ? null
      : q.error instanceof ApiError && q.error.status === 404
        ? '주문을 찾을 수 없습니다.'
        : '불러오지 못했습니다. 다시 시도해 주세요.',
    notFound: q.error instanceof ApiError && q.error.status === 404,
  }
}

/** 고른 배송 상세로 바꿔 끼움 (03 주문 수정 창도 씀). 상세가 여러 개면 '배송 2/3'을 함께 (어느 줄을 열었는지) */
export function pickParcel(
  o: OrderDetail,
  parcelSeq?: number | null,
): OrderDetail & { position?: string } {
  const list = o.parcels ?? []
  const i = list.findIndex((p) => p.orderParcelSeq === parcelSeq)
  const p = list[i]
  if (!p) return o
  return {
    ...o,
    sender: p.sender,
    receiver: p.receiver,
    items: p.items,
    itemPrice: p.itemPrice,
    clientComment: p.clientComment,
    notifiedPrice: p.notifiedPrice,
    cancelled: o.cancelled || p.cancelled, // 이 상세만 취소돼도 [수정] 없음 · '주문 취소' 태그
    position: list.length > 1 ? `배송 ${i + 1}/${list.length}` : undefined,
  }
}

function toView(o: OrderDetail & { position?: string }): OrderView {
  const phone = o.route === 'PHONE'
  const group = o.cancelled ? 'CANCELLED' : o.status ? ORDER_GROUP[o.status] : null
  return {
    orderSeq: o.orderSeq,
    orderNo: orderNo(o.orderSeq),
    group,
    meta: [
      `접수 ${fmtDetailTime(o.acceptedAt)}`,
      phone ? 'AI 전화 접수' : `수기 접수 ${o.manualBy ?? ''}`.trim(),
      o.position,
    ]
      .filter(Boolean)
      .join(' · '),
    sender: party(o.sender),
    receiver: party(o.receiver),
    info: [
      { label: '품목', value: itemsText(o), wide: true },
      {
        label: '수거 희망 일시',
        value: o.pickupRequestedAt ? fmtDetailTime(o.pickupRequestedAt) : '없음',
      },
      { label: '결제 방식', value: PAYMENT_METHOD_LABEL[o.paymentMethod] },
      {
        label: '물품 가액',
        value: o.itemPrice === null ? '없음' : `${o.itemPrice.toLocaleString('ko-KR')}원`,
      },
      { label: '결제', value: PAYMENT_STATE_LABEL[o.paymentState] },
      { label: '고객 요청 사항', value: o.clientComment || '없음', wide: true },
    ],
    relatedCalls: o.relatedCalls.map((c) => ({
      key: `${c.callSessionSeq}-${c.kind}`,
      callSessionSeq: c.callSessionSeq,
      time: fmtDetailTime(c.startedAt),
      // 통화 요약이 있으면 04와 같은 칩, 없는 가짜 주문은 kind로 한 칩
      kinds:
        c.counts === undefined
          ? [
              {
                kind: c.kind === 'CANCEL' ? 'cancel' : 'accept',
                label: c.kind === 'CANCEL' ? '취소' : '접수',
              },
            ]
          : kindChips(c.counts),
      analyzed: c.counts !== null,
      text: RELATED_CALL_LABEL[c.kind].text,
    })),
    canEdit: group !== 'CANCELLED' && group !== 'PAID',
    canCancel: o.status === 'COLLECTING' || o.status === 'notPaid',
    canRetry: o.status === 'SUBMISSION_FAILED',
    parcelCount: o.parcels?.filter((p) => !p.cancelled).length || 1,
  }
}

const party = (p: Party): PartyView => ({
  name: p.name,
  phone: p.phoneNumber ? fmtPhone(p.phoneNumber) : '',
  address: [p.roadAddress, p.detailAddress].filter(Boolean).join(' '),
})

/** '소박스 1 · 중박스 1 · 기타 화분' — 0개는 뺌 (03 목록에 있던 품목 칸과 같은 모양) */
function itemsText({ items: i }: OrderDetail) {
  const parts = (
    [
      ['서류', i.document],
      ['소박스', i.small],
      ['중박스', i.medium],
      ['대박스', i.big],
    ] as const
  )
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k} ${n}`)
  if (i.other) parts.push(`기타 ${i.other}`)
  return parts.join(' · ') || '없음'
}
