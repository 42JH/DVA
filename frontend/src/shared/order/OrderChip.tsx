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

// small = 03 목록 줄 (11/06 시안) — 테두리 1 · 모서리 4 · 폭 63 · 글자 12 · 글자색 = 테두리색, 짧은 이름
const SMALL: Record<OrderGroup, { label: string; color: string }> = {
  COLLECTING: { label: '미완료', color: 'border-[#a234c7] text-[#a234c7]' },
  notPaid: { label: '결제 대기', color: 'border-[#fe9800] text-[#fe9800]' },
  PAID: { label: '결제 완료', color: 'border-[#3182f6] text-[#3182f6]' },
  SUBMISSION_FAILED: { label: '접수 실패', color: 'border-[#b42318] text-[#b42318]' }, // 시안에 없는 상태 — 취소보다 진한 빨강
  CANCELLED: { label: '취소', color: 'border-[#f04452] text-[#f04452]' },
}

export function OrderChip({ group, small }: { group: OrderGroup; small?: boolean }) {
  if (small)
    return (
      <span
        className={`inline-grid h-6 w-[63px] shrink-0 place-items-center rounded border text-[12px] leading-none whitespace-nowrap ${SMALL[group].color}`}
      >
        {SMALL[group].label}
      </span>
    )
  return (
    <span
      className={`grid h-8 w-[105px] shrink-0 place-items-center rounded-2xl border-2 text-body font-semibold whitespace-nowrap text-sub ${BORDER[group]}`}
    >
      {ORDER_GROUP_LABEL[group]}
    </span>
  )
}
