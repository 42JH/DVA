import { Button, FormModal } from '@/shared/ui'
import { useOrderToEdit } from '@/features/order/hooks/useOrderToEdit'
import { OrderFormModal } from './OrderFormModal'

// 03 주문 수정 창 — 주문을 불러온 뒤 주문 추가와 같은 창(OrderFormModal)을 그 값으로 채워 띄움
// 불러오는 동안 · 실패하면 같은 크기의 빈 창에 안내 한 줄 (상세에서 바로 오면 이미 받아 둔 값이라 거의 안 보임)
// 버전 충돌(409) → 최신 주문을 다시 받아 창을 새로 채움(key = version) + 안내. 입력하던 값은 버림 (명세: 자동 덮어쓰기 금지, 11/01 결정)
export function OrderEditModal({
  orderId,
  parcelSeq,
  onDone,
  onClose,
}: {
  orderId: number
  parcelSeq: number | null
  onDone: (notice?: string) => void
  onClose: () => void
}) {
  const { order, notice, conflict, onConflict } = useOrderToEdit(orderId, parcelSeq)

  if (!order)
    return (
      <FormModal
        title="주문 수정"
        width={960}
        onClose={onClose}
        footer={<Button onClick={onClose}>닫기</Button>}
      >
        <p className="py-16 text-center text-body text-muted">{notice}</p>
      </FormModal>
    )
  return (
    <OrderFormModal
      key={order.version} // 최신 버전이 오면 칸을 새로 채움
      order={order}
      parcelSeq={parcelSeq}
      notice={conflict}
      onConflict={onConflict}
      onDone={onDone}
      onClose={onClose}
    />
  )
}
