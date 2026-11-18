import { type OrderDetail } from './orderApi'

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
