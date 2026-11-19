// 03 주문 목록 — 주문 하나를 화면 줄들로 · 검색칸 거르기. React · 네트워크를 모르는 순수 함수 (parcelRows.test.ts에서 확인)
import type { ListParcel, OrderListItem, OrderStatus } from './orderApi'

/** 화면 한 줄 = 배송 상세 하나 (보내는 분 1 + 받는 분 1, 11/01 결정) */
interface ParcelRow {
  key: string // 줄 키 — 같은 주문의 여러 줄을 구분
  orderSeq: number // 줄을 누르면 이 주문의 상세
  status: OrderStatus // 상세만 취소됐으면 그 줄은 'CANCELLED'
  createdAt: string
  pickupRequestedAt: string | null
  parcel: ListParcel | null // 상세가 아직 없는 접수 중 주문이면 null → 한 줄, 칸은 '—'
}

/** 주문 하나 → 줄들. 취소된 상세도 보여 줌 (취소돼도 계속 보임) */
export function parcelRows(o: OrderListItem): ParcelRow[] {
  const base = {
    orderSeq: o.orderSeq,
    createdAt: o.createdAt,
    pickupRequestedAt: o.pickupRequestedAt,
  }
  if (o.parcels.length === 0)
    return [{ ...base, key: String(o.orderSeq), status: o.status, parcel: null }]
  return o.parcels.map((p) => ({
    ...base,
    key: `${o.orderSeq}-${p.orderParcelSeq}`,
    status: p.status === 'CANCELLED' ? 'CANCELLED' : o.status,
    parcel: p,
  }))
}
