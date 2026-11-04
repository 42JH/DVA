import { ORDER_GROUP_LABEL, type OrderGroup } from './labels'

// 주문 상태 칩 (Figma '주문' 11/04) — 03 목록 줄 · 주문 상세 머리. 테두리 2 · 모서리 16 · 높이 32 · 글자 16/600 회색
// 폭은 모두 105 — 가장 긴 '미완료 주문' 기준 (11/04 사용자: 칩 크기 동일하게)
const BORDER: Record<OrderGroup, string> = {
  COLLECTING: 'border-order-open',
  notPaid: 'border-order-wait',
  PAID: 'border-order-paid',
  SUBMISSION_FAILED: 'border-order-fail',
  CANCELLED: 'border-order-cancel',
}

export function OrderChip({ group }: { group: OrderGroup }) {
  return (
    <span
      className={`grid h-8 w-[105px] shrink-0 place-items-center rounded-2xl border-2 text-body font-semibold whitespace-nowrap text-sub ${BORDER[group]}`}
    >
      {ORDER_GROUP_LABEL[group]}
    </span>
  )
}
