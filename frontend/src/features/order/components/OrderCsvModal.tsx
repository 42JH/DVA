import { Button, FileDrop, FormModal } from '@/shared/ui'
import { useOrderCsvImport } from '@/features/order/hooks/useOrderCsvImport'

// 03 CSV로 주문 추가 창 — 디자인 08 'CSV로 기업 등록' 창과 같은 모양 (기업명 칸만 없음), 폭 672
// CSV 파일(끌어다 놓기 · 파일 선택) → 고르자마자 검사 → 틀리면 'n행 …' 한 줄, 맞으면 '주문 n건을 추가합니다.' → [등록]
export function OrderCsvModal({ onClose }: { onClose: () => void }) {
  const vm = useOrderCsvImport(onClose)

  return (
    <FormModal
      title="CSV로 주문 추가"
      width={672}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>취소</Button>
          <Button kind="primary" disabled={!vm.canSubmit} onClick={vm.submit}>
            {vm.isSubmitting ? '등록 중…' : '등록'}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-[120px_1fr] items-start gap-x-4">
        <span className="flex h-11 items-center text-label text-sub">CSV 파일</span>
        <div className="flex min-w-0 flex-col gap-2">
          <FileDrop
            file={vm.file}
            accept=".csv"
            error={vm.error}
            onPick={vm.pick}
            onRemove={vm.remove}
          />
          {vm.summary && <p className="text-label font-semibold text-action">{vm.summary}</p>}
          <p className="text-caption text-muted">
            주문 추가 창과 같은 칸을 열로 적습니다. 엑셀에서는 &lsquo;CSV UTF-8&rsquo;로 저장해
            주세요.{' '}
            <button
              type="button"
              onClick={vm.downloadTemplate}
              className="font-semibold text-action underline-offset-2 hover:underline"
            >
              양식 받기
            </button>
          </p>
        </div>
      </div>
    </FormModal>
  )
}
