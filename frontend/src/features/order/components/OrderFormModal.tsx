import { AddressSearchModal, Button, ChipGroup, Dialog, Stepper, TextField } from '@/shared/ui'
import { OrderChip } from '@/shared/order/OrderChip'
import { ORDER_GROUP, orderNo } from '@/shared/order/labels'
import { PartyPair } from '@/shared/order/PartyCards'
import { useOrderForm } from '@/features/order/hooks/useOrderForm'
import type { OrderDetail } from '@/features/order/api/orderApi'
import { OrderPartyFields } from './OrderPartyFields'

// 03 주문 추가 (수기 접수) · 주문 수정 창 — 새 디자인 창(shared/ui Dialog, 11/04: Figma에 없어 주문 상세 창과 같은 말투로). order를 주면 수정
// 머리: '수기 접수' + 주문 추가 / '주문 수정' + DV-00001 + 상태 칩 | ✕
// 몸: 보내는 분 ≫ 받는 분 카드(이름 · 전화번호 · 주소(검색으로만) · 상세주소) → 접수 정보: 품목 수량 4 | 기타 품목 · 물품 가액 | 배송비 · 수거 희망 일시 | 결제 방식 | 고객 요청 사항
// 아래: (접수하려면 · 오류 한 줄) … [취소] [접수/저장]. 주소 칸을 누르면 이 창 대신 주소 검색 창 (고르면 돌아옴, 적던 내용 그대로)
// 칸 · 칩 · 수량은 Dialog 안이라 새 모양 (shared/ui/newLook.ts). 라벨 칸 폭: 카드 72 · 접수 정보 116 (--field-label)
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
  onDone: (notice?: string) => void // 접수 · 저장 성공 (notice = 미완료 주문 접수 결과)
  onClose: () => void
}) {
  const vm = useOrderForm(onDone, order, parcelSeq, onConflict)
  const group = order && (order.cancelled ? 'CANCELLED' : order.status && ORDER_GROUP[order.status])

  if (vm.searching)
    return (
      <AddressSearchModal
        big
        title={vm.searchTitle}
        onPick={vm.pickAddress}
        onClose={vm.closeSearch}
      />
    )
  // 보내는 분 이름 · 주소를 고쳤을 때 (jiw/order-sender-customer-save.md 1장 문구 그대로). 겹치면 Esc가 둘 다 닫아 폼 대신 띄움
  if (vm.asking)
    return (
      <Dialog
        label="고객정보에도 저장"
        title="변경한 이름과 주소를 고객정보에도 저장할까요?"
        width={640}
        onClose={vm.cancelAsk}
        footer={
          <>
            <Button big className="ml-auto" onClick={vm.cancelAsk}>
              취소
            </Button>
            <Button big kind="brandLine" onClick={() => vm.answer(false)}>
              이번 주문에만 저장
            </Button>
            <Button big kind="brand" onClick={() => vm.answer(true)}>
              고객정보에도 저장
            </Button>
          </>
        }
      >
        <p className="pb-1 text-strong text-sub">
          고객정보에 저장하면 해당 고객의 기본 정보도 변경됩니다. 다른 주문의 배송정보와 PIN은
          변경되지 않습니다.
        </p>
      </Dialog>
    )

  return (
    <Dialog
      label={vm.isEdit ? '주문 수정' : '주문 추가'}
      eyebrow={vm.isEdit ? '주문 수정' : '수기 접수'}
      title={order ? orderNo(order.orderSeq) : '주문 추가'}
      extra={group && <OrderChip group={group} />}
      onClose={onClose}
      footer={
        vm.customerFailMessage ? (
          // 주문은 저장됨 — 고객정보만 다시 보내거나 닫기 (주문 PATCH는 다시 안 함)
          <>
            <Button big className="ml-auto" onClick={vm.finish}>
              닫기
            </Button>
            <Button big kind="brand" disabled={vm.retrying} onClick={vm.retryCustomer}>
              {vm.retrying ? '저장 중…' : '고객정보 다시 저장'}
            </Button>
          </>
        ) : (
          <>
            {!vm.submitError && vm.missing.length > 0 && (
              // 미완료 주문: 무엇을 채워야 [접수]가 켜지는지
              <p className="min-w-0 text-body text-sub">접수하려면: {vm.missing.join(' · ')}</p>
            )}
            {vm.submitError && (
              <p role="alert" className="min-w-0 text-body font-semibold text-danger">
                {vm.submitError}
              </p>
            )}
            <Button big className="ml-auto" onClick={onClose}>
              취소
            </Button>
            <Button big kind="brand" disabled={!vm.canSubmit} onClick={vm.submit}>
              {vm.isSubmitting ? `${vm.submitLabel} 중…` : vm.submitLabel}
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-5">
        {[vm.customerFailMessage, notice].map(
          (t) =>
            t && (
              <p
                key={t}
                role="alert"
                className="rounded-lg bg-danger-soft px-4 py-3 text-body text-danger"
              >
                {t}
              </p>
            ),
        )}
        <PartyPair
          sender={<OrderPartyFields title="보내는 분" party={vm.sender} />}
          receiver={<OrderPartyFields title="받는 분" party={vm.receiver} />}
        />

        <section className="flex flex-col gap-3 [--field-label:116px]">
          <h3 className="text-strong font-bold">접수 정보</h3>
          <div className="grid grid-cols-[var(--field-label)_minmax(0,1fr)] items-center gap-x-4">
            <span className="text-body text-sub">품목</span>
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              {vm.items.map((i) => (
                <Stepper key={i.key} label={i.label} value={i.count} onChange={i.setCount} />
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-x-10 gap-y-3">
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
            {vm.showFee && (
              // 배송비 — 요청자가 입력(자동 견적 API 없음, 명세 4.4). 추가 · 미완료 주문 수정에만 (그 외 수정은 그대로 유지)
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
            <div className="col-span-2">
              {vm.paymentLocked ? (
                // 결제 방식은 미완료(접수 중단) 상태에서만 바꿀 수 있음 (명세 4.3) — 잠긴 값은 글자로
                <TextField
                  label="결제 방식"
                  inline
                  locked
                  value={vm.paymentOptions.find((o) => o.value === vm.payment)?.label ?? vm.payment}
                  hint="결제 방식은 미완료 주문에서만 바꿀 수 있습니다."
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
    </Dialog>
  )
}
