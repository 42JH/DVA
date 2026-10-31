import { Button, ChipGroup, FormModal, Stepper, TextField } from '@/shared/ui'
import { useOrderForm } from '@/features/order/hooks/useOrderForm'
import { AddressSearchModal } from './AddressSearchModal'
import { OrderPartyFields } from './OrderPartyFields'

// 03 주문 추가 (수기 접수) 창 (와이어프레임 03_주문내역_주문추가, 10/31) — 폭 960
// 위: 보내는 분 | 받는 분 (가운데 세로선) → 가로선 → 접수 정보: 품목 수량 4 · 기타 품목 | 물품 가액 · 수거 희망 일시 | 결제 방식 · 고객 요청 사항
// 아래 [취소] [접수]. 주소 칸을 누르면 이 창 대신 주소 검색 창 (고르면 돌아옴, 적던 내용 그대로)
export function OrderFormModal({ onClose }: { onClose: () => void }) {
  const vm = useOrderForm(onClose)

  if (vm.searching)
    return (
      <AddressSearchModal title={vm.searchTitle} onPick={vm.pickAddress} onClose={vm.closeSearch} />
    )

  return (
    <FormModal
      title="주문 추가 (수기 접수)"
      width={960}
      onClose={onClose}
      footer={
        <>
          {vm.submitError && (
            <p role="alert" className="mr-auto self-center text-label text-danger">
              {vm.submitError}
            </p>
          )}
          <Button onClick={onClose}>취소</Button>
          <Button kind="primary" disabled={!vm.canSubmit} onClick={vm.submit}>
            {vm.isSubmitting ? '접수 중…' : '접수'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-6 border-t border-line pt-6">
        <div className="grid grid-cols-[1fr_1px_1fr] gap-8">
          <OrderPartyFields title="보내는 분" party={vm.sender} />
          <div className="bg-line" />
          <OrderPartyFields title="받는 분" party={vm.receiver} />
        </div>

        <section className="flex flex-col gap-3 border-t border-line pt-6">
          <h3 className="mb-1 text-body font-bold">접수 정보</h3>
          <div className="grid grid-cols-[120px_1fr] items-center gap-x-4">
            <span className="text-label text-sub">품목</span>
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              {vm.items.map((i) => (
                <Stepper key={i.box} label={i.box} value={i.count} onChange={i.setCount} />
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-x-8 gap-y-3">
            <TextField
              label="기타 품목"
              inline
              placeholder="기타 품목"
              value={vm.etcItem}
              onChange={(e) => vm.setEtcItem(e.target.value)}
            />
            <TextField
              label="물품 가액"
              inline
              inputMode="numeric"
              suffix="원"
              placeholder="숫자만 입력"
              value={vm.declaredValue}
              onChange={(e) => vm.setDeclaredValue(e.target.value)}
            />
            <TextField
              label="수거 희망 일시"
              inline
              type="datetime-local"
              min={vm.pickupMin}
              hint="선택"
              value={vm.pickupAt}
              error={vm.pickupError}
              onChange={(e) => vm.setPickupAt(e.target.value)}
            />
            <ChipGroup
              name="결제 방식"
              compact
              options={vm.paymentOptions}
              value={vm.payment}
              onChange={vm.setPayment}
            />
          </div>
          <TextField
            label="고객 요청 사항"
            inline
            placeholder="선택 (예: 경비실에 맡겨 주세요)"
            value={vm.request}
            onChange={(e) => vm.setRequest(e.target.value)}
          />
        </section>
      </div>
    </FormModal>
  )
}
