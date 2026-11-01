import { Button, ChipGroup, FormModal, Stepper, TextField } from '@/shared/ui'
import { useOrderForm } from '@/features/order/hooks/useOrderForm'
import type { OrderDetail } from '@/features/order/api/orderApi'
import { AddressSearchModal } from './AddressSearchModal'
import { OrderPartyFields } from './OrderPartyFields'

// 03 주문 추가 (수기 접수) · 주문 수정 창 (와이어프레임 03_주문내역_주문추가 · _주문수정, 10/31) — 폭 960. order를 주면 수정
// 위: 보내는 분 | 받는 분 (가운데 세로선) → 가로선 → 접수 정보: 품목 수량 4 · 기타 품목 | 물품 가액 · 수거 희망 일시 | 결제 방식 · 고객 요청 사항
// 아래 [취소] [접수]. 주소 칸을 누르면 이 창 대신 주소 검색 창 (고르면 돌아옴, 적던 내용 그대로)
export function OrderFormModal({
  order,
  parcelSeq = null,
  notice,
  onConflict,
  onDone,
  onClose,
}: {
  order?: OrderDetail
  parcelSeq?: number | null // 수정: 목록에서 누른 배송 상세
  notice?: string | null // 수정: 버전 충돌로 최신 값을 다시 채웠다는 안내
  onConflict?: () => void
  onDone: () => void // 접수 · 저장 성공
  onClose: () => void
}) {
  const vm = useOrderForm(onDone, order, parcelSeq, onConflict)

  if (vm.searching)
    return (
      <AddressSearchModal title={vm.searchTitle} onPick={vm.pickAddress} onClose={vm.closeSearch} />
    )

  return (
    <FormModal
      title={vm.isEdit ? '주문 수정' : '주문 추가 (수기 접수)'}
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
            {vm.isSubmitting ? (vm.isEdit ? '저장 중…' : '접수 중…') : vm.isEdit ? '저장' : '접수'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-6">
        {notice && (
          <p role="alert" className="rounded-lg bg-danger-soft px-4 py-3 text-label text-danger">
            {notice}
          </p>
        )}
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
                <Stepper key={i.key} label={i.label} value={i.count} onChange={i.setCount} />
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-x-8 gap-y-3">
            <TextField
              label="기타 품목"
              inline
              placeholder="기타 품목"
              value={vm.etcItem}
              error={vm.etcError}
              onChange={(e) => vm.setEtcItem(e.target.value)}
            />
            <TextField
              label="물품 가액"
              inline
              inputMode="numeric"
              suffix="원"
              placeholder="숫자만 입력"
              value={vm.declaredValue}
              error={vm.priceError}
              onChange={(e) => vm.setDeclaredValue(e.target.value)}
            />
            {!vm.isEdit && (
              // 배송비 — 수기 접수는 요청자가 입력(자동 견적 API 없음, 명세 4.4). 수정 창에선 그대로 유지라 안 보임
              <TextField
                label="배송비"
                inline
                inputMode="numeric"
                suffix="원"
                placeholder="숫자만 입력"
                value={vm.shippingFee}
                error={vm.feeError}
                onChange={(e) => vm.setShippingFee(e.target.value)}
              />
            )}
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
            {vm.paymentLocked ? (
              // 결제 방식은 접수 중단 상태에서만 바꿀 수 있음 (명세 4.3) — 잠긴 값은 글자로
              <TextField
                label="결제 방식"
                inline
                locked
                value={vm.paymentOptions.find((o) => o.value === vm.payment)?.label ?? vm.payment}
                hint="결제 방식은 접수 중단 상태에서만 바꿀 수 있습니다."
              />
            ) : (
              <ChipGroup
                name="결제 방식"
                compact
                options={vm.paymentOptions}
                value={vm.payment}
                onChange={vm.setPayment}
              />
            )}
          </div>
          <TextField
            label="고객 요청 사항"
            inline
            placeholder="선택 (예: 경비실에 맡겨 주세요)"
            value={vm.request}
            error={vm.requestError}
            onChange={(e) => vm.setRequest(e.target.value)}
          />
        </section>
      </div>
    </FormModal>
  )
}
