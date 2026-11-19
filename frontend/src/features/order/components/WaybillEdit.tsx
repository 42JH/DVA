// 주문 수정 — 상세 패널 안에서 그 자리에 고침 (모달 대신). 칸은 주문 추가와 같은 OrderFields
// 기업 피드백: 조회 · 수정 칸을 같게(가격 · 배송비 둘 다), 칸마다 바로 검증. 저장 · 접수 규칙은 기존 useOrderForm 그대로
import { useOrderForm } from '../hooks/useOrderForm'
import { useOrderToEdit } from '../hooks/useOrderToEdit'
import { Btn } from '@/shared/ui'
import { OrderFields } from './OrderFields'

export function WaybillEdit({
  orderSeq,
  parcelSeq,
  fee,
  onDone,
}: {
  orderSeq: number
  parcelSeq: number | null
  fee: string // 수정에서 못 바꾸는 배송비 — 상세와 같은 값을 보여 줌
  onDone: (notice?: string, newOrderSeq?: number) => void
}) {
  const src = useOrderToEdit(orderSeq, parcelSeq)
  if (!src.order) return <p className="py-10 text-center text-[14px] text-ops-sub">{src.notice}</p>
  // 버전이 바뀌면(다른 관리자가 먼저 저장) 최신 값으로 다시 채움
  return (
    <Form key={src.order.version ?? 0} src={src} fee={fee} onDone={onDone} parcelSeq={parcelSeq} />
  )
}

function Form({
  src,
  fee,
  parcelSeq,
  onDone,
}: {
  src: ReturnType<typeof useOrderToEdit>
  fee: string
  parcelSeq: number | null
  onDone: (notice?: string, newOrderSeq?: number) => void
}) {
  const f = useOrderForm(onDone, src.order!, parcelSeq, src.onConflict)
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (f.canSubmit) f.submit()
      }}
      className="flex flex-col gap-4"
    >
      {src.conflict && (
        <p className="rounded-md bg-ops-wait-soft px-3 py-2 text-[13px] text-ops-wait">
          {src.conflict}
        </p>
      )}
      {f.missing.length > 0 && (
        <p className="rounded-md bg-ops-wait-soft px-3 py-2 text-[13px] text-ops-wait">
          접수하려면 {f.missing.join(', ')}을(를) 채워 주세요.
        </p>
      )}
      <OrderFields f={f} fee={fee} showEmpty />

      {/* 아래 줄 — 패널 바닥에 붙음. 주소를 고르는 동안엔 숨김 */}
      <div
        hidden={f.searching}
        className="sticky -bottom-4 -mx-5 flex flex-col gap-2 border-t border-ops-line bg-white px-5 py-3"
      >
        {f.asking ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="flex-1 text-[13px]">보내는 분 이름과 주소를 고객 정보에도 저장할까요?</p>
            <Btn onClick={() => f.answer(false)}>주문만</Btn>
            <Btn kind="primary" onClick={() => f.answer(true)}>
              고객 정보도
            </Btn>
          </div>
        ) : f.customerFailMessage ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="flex-1 text-[12px] text-ops-stop">{f.customerFailMessage}</p>
            <Btn onClick={f.finish}>닫기</Btn>
            <Btn kind="primary" disabled={f.retrying} onClick={f.retryCustomer}>
              다시 저장
            </Btn>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            {f.submitError && <p className="flex-1 text-[12px] text-ops-stop">{f.submitError}</p>}
            <Btn className="ml-auto" onClick={() => onDone()}>
              취소
            </Btn>
            <Btn kind="primary" type="submit" disabled={!f.canSubmit}>
              {f.isSubmitting ? '저장 중…' : f.submitLabel}
            </Btn>
          </div>
        )}
      </div>
    </form>
  )
}
