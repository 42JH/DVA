import { useQuery } from '@tanstack/react-query'
import { ApiError } from '@/shared/api/client'
import { fmtDetailTime, fmtPhone } from '@/shared/lib/format'
import type { TagKind } from '@/shared/ui'
import { PAYMENT_METHOD_LABEL, PAYMENT_STATE_LABEL, RELATED_CALL_LABEL } from './labels'
import { orderQueries, type OrderDetail, type Party } from './orderApi'

/** 주문 상세 화면용 값 (읽기 전용) — OrderDetail(본문) · OrderDetailModal(창)이 그림 */
export interface OrderView {
  orderSeq: number
  tags: { label: string; kind: TagKind }[] // [전화] · [수기] (+ [주문 취소])
  subtitle: string // '접수 10.20 (화) 13:12 · AI 전화 접수' · '… · 수기 접수 이재훈'
  sender: [string, string][] // [항목, 값]
  receiver: [string, string][]
  items: string
  info: [string, string][] // 수거 희망 일시 · 결제 방식 · 물품 가액 · 결제 (두 칸씩)
  clientComment: string
  relatedCalls: { key: string; callSessionSeq: number; time: string; tag: string; text: string }[]
  canEdit: boolean // 취소된 주문은 [수정] 없음
}

/** 주문 하나 불러와 화면용 값으로 (shared/auth처럼 여러 기능이 쓰는 공통 훅이라 useQuery를 여기서). id가 null이면 안 부름 */
export function useOrderDetail(orderId: number | null) {
  const q = useQuery({ ...orderQueries.detail(orderId ?? 0), enabled: orderId !== null })
  return {
    order: q.data ? toView(q.data) : null,
    isLoading: orderId !== null && q.isPending,
    error: !q.error
      ? null
      : q.error instanceof ApiError && q.error.status === 404
        ? '주문을 찾을 수 없습니다.'
        : '불러오지 못했습니다. 다시 시도해 주세요.',
  }
}

function toView(o: OrderDetail): OrderView {
  const phone = o.route === 'PHONE'
  return {
    orderSeq: o.orderSeq,
    tags: [
      { label: phone ? '전화' : '수기', kind: 'blue' },
      ...(o.cancelled ? [{ label: '주문 취소', kind: 'gray' as TagKind }] : []),
    ],
    subtitle: `접수 ${fmtDetailTime(o.acceptedAt)} · ${phone ? 'AI 전화 접수' : `수기 접수 ${o.manualBy ?? ''}`.trim()}`,
    sender: partyRows(o.sender),
    receiver: partyRows(o.receiver),
    items: itemsText(o),
    info: [
      ['수거 희망 일시', o.pickupRequestedAt ? fmtDetailTime(o.pickupRequestedAt) : '없음'],
      ['결제 방식', PAYMENT_METHOD_LABEL[o.paymentMethod]],
      ['물품 가액', o.itemPrice === null ? '없음' : `${o.itemPrice.toLocaleString('ko-KR')}원`],
      ['결제', PAYMENT_STATE_LABEL[o.paymentState]],
    ],
    clientComment: o.clientComment ?? '없음',
    relatedCalls: o.relatedCalls.map((c) => ({
      key: `${c.callSessionSeq}-${c.kind}`,
      callSessionSeq: c.callSessionSeq,
      time: fmtDetailTime(c.startedAt),
      tag: RELATED_CALL_LABEL[c.kind].tag,
      text: RELATED_CALL_LABEL[c.kind].text,
    })),
    canEdit: !o.cancelled,
  }
}

const partyRows = (p: Party): [string, string][] => [
  ['이름', p.name],
  ['전화번호', fmtPhone(p.phoneNumber)],
  ['주소', p.roadAddress],
  ['상세주소', p.detailAddress ?? '없음'],
]

function itemsText(o: OrderDetail) {
  const i = o.items
  return `서류 ${i.document} · 소박스 ${i.small} · 중박스 ${i.medium} · 대박스 ${i.big} · 기타 ${i.other ?? '—'}`
}
