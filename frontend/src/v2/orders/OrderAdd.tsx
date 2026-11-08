// v2 주문 추가 (수기 접수) 창 — 칸은 상세 패널 수정과 같은 OrderFields. 규칙 · 요청은 기존 useOrderForm 그대로
// 처음엔 빈 칸을 빨갛게 하지 않고, 모자란 채로 [접수]를 누르면 그때 빈 칸을 짚음
import { useState } from 'react'
import { useOrderForm } from '@/features/order/hooks/useOrderForm'
import { Btn } from '@/v2/ui'
import { Modal } from '@/v2/ui/Modal'
import { OrderFields } from './OrderFields'

export function OrderAddModal({ onClose }: { onClose: () => void }) {
  const f = useOrderForm(() => onClose())
  const [tried, setTried] = useState(false)
  return (
    <Modal
      title="주문 추가"
      onClose={onClose}
      width={960}
      footer={
        !f.searching && (
          <>
            {/* 배송비 — 물품을 넣으면 바로 계산 (직접 입력 없음) */}
            <p className="flex items-baseline gap-2">
              <span className="text-[12px] font-medium text-ops-sub">배송비</span>
              {f.shippingFee ? (
                <span className="text-[18px] font-bold tabular-nums">{f.shippingFee}</span>
              ) : (
                <span className="text-[13px] text-ops-faint">물품을 넣으면 계산됩니다</span>
              )}
            </p>
            {f.submitError && (
              <p role="alert" className="min-w-0 flex-1 text-[12px] text-ops-stop">
                {f.submitError}
              </p>
            )}
            <Btn className="ml-auto" onClick={onClose}>
              취소
            </Btn>
            {/* 모자라도 누를 수 있음 — 누르면 빈 칸을 짚어 줌 */}
            <Btn
              kind="primary"
              type="submit"
              form="order-add"
              aria-disabled={!f.canSubmit}
              disabled={f.isSubmitting}
              className="aria-disabled:opacity-60"
            >
              {f.isSubmitting ? '접수 중…' : '접수'}
            </Btn>
          </>
        )
      }
    >
      <form
        id="order-add"
        onSubmit={(e) => {
          e.preventDefault()
          if (f.canSubmit) f.submit()
          else setTried(true)
        }}
      >
        <OrderFields f={f} showEmpty={tried} wide />
      </form>
    </Modal>
  )
}
