import { Button, FormModal, SearchBox } from '@/shared/ui'
import { useAddressSearch } from '@/features/order/hooks/useAddressSearch'

// 주소 검색 창 — 도로명으로 찾아 한 줄을 누르면 그 주소로. 주문 추가 창 대신 떴다가 고르면 돌아감
export function AddressSearchModal({
  title,
  onPick,
  onClose,
}: {
  title: string
  onPick: (road: string) => void
  onClose: () => void
}) {
  const vm = useAddressSearch()

  return (
    <FormModal
      title={title}
      width={600}
      onClose={onClose}
      footer={<Button onClick={onClose}>취소</Button>}
    >
      <div className="flex flex-col gap-3">
        <SearchBox value={vm.q} onChange={vm.setQ} placeholder="도로명 · 건물 번호" />
        {vm.notice ? (
          <p className="py-10 text-center text-body text-muted">{vm.notice}</p>
        ) : (
          <ul className="max-h-[320px] overflow-auto">
            {vm.results.map((road) => (
              <li key={road} className="border-b border-line last:border-b-0">
                <button
                  type="button"
                  onClick={() => onPick(road)}
                  className="w-full rounded-lg px-3 py-3 text-left text-body hover:bg-bg hover:text-action"
                >
                  {road}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </FormModal>
  )
}
