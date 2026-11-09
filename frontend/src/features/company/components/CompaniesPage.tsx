// 기업 목록 (11/06) — 검색 · 체크 · 줄마다 [삭제] · CSV로 기업 등록. 이름을 누르면 기업 상세(사원)
// 삭제: 줄의 [삭제] → 확인 창. 체크한 줄의 [삭제]를 누르면 체크한 곳 모두 (체크해야만 나타나는 버튼은 두지 않음)
// 목록 · 여러 곳 삭제 · CSV는 기존 useCompanyList · CSV 창(CompanyModals)
import { useRef, useState } from 'react'
import { Link } from 'react-router'
import { errorText } from '@/features/company/labels'
import { useCompanyList } from '@/features/company/hooks/useCompanyList'
import { PageHead } from '@/shared/ui'
import { Btn, Icon } from '@/shared/ui'
import { SearchBox, SkeletonRows } from '@/shared/ui/ListFrame'
import { useScrollable } from '@/shared/lib/useScrollable'
import { CompanyCsvModal } from './CompanyModals'
import { Pagination } from '@/shared/ui/Pagination'
import { usePageSize } from '@/shared/lib/paging'
import { Confirm } from '@/shared/ui/Modal'

export function CompaniesPage() {
  const [size, setSize] = usePageSize()
  const vm = useCompanyList(size)
  const all = vm.rows.length > 0 && vm.selected.size === vm.rows.length
  const box = useRef<HTMLDivElement>(null)
  const scrollable = useScrollable(box, [vm.rows])
  const [asking, setAsking] = useState<{ id: number; name: string } | null>(null) // 한 곳 삭제 확인
  const removeOne = vm.removeOne
  const askRow = (id: number, name: string) => {
    if (vm.selected.has(id) && vm.selected.size > 1)
      vm.askDelete() // 체크한 곳 모두
    else setAsking({ id, name })
  }
  return (
    <>
      <PageHead title="기업">
        <SearchBox
          value={vm.q}
          onChange={vm.setQ}
          placeholder="기업명으로 검색"
          label="기업 검색"
        />
        <Btn kind="primaryLime" className="ml-auto" onClick={vm.openCsv}>
          <Icon name="sheet" />
          CSV로 기업 등록
        </Btn>
      </PageHead>
      <section aria-label="기업 목록" className="flex min-h-0 flex-1 flex-col gap-3 px-6 pt-4 pb-4">
        <p className="flex h-8 items-center gap-2 text-[13px] text-ops-sub">
          {vm.selected.size
            ? `${vm.selected.size}곳 선택`
            : `기업 ${vm.total.toLocaleString('ko-KR')}곳`}
          {vm.deleteError && <span className="text-ops-stop">{vm.deleteError}</span>}
        </p>
        <div
          ref={box}
          data-scrollable={scrollable || undefined}
          className="flex min-h-0 flex-1 [scrollbar-width:thin] flex-col overflow-auto rounded-lg border border-ops-line bg-white"
        >
          <table className="ops-table min-w-[760px]">
            <thead>
              <tr>
                <th scope="col" className="w-[52px]">
                  <input
                    type="checkbox"
                    aria-label="이 쪽 전체 선택"
                    checked={all}
                    onChange={vm.toggleAll}
                    className="mx-auto block size-4 accent-ops-route"
                  />
                </th>
                <th scope="col">기업</th>
                <th scope="col" className="w-[110px] text-right">
                  사원
                </th>
                <th scope="col" className="w-[120px]">
                  결제
                </th>
                <th scope="col" className="w-[140px]">
                  등록
                </th>
                <th scope="col" className="w-[90px] text-right">
                  관리
                </th>
              </tr>
            </thead>
            <tbody>
              {vm.rows.map((r) => (
                <tr key={r.id} aria-selected={vm.selected.has(r.id)} className="h-11">
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`${r.name} 선택`}
                      checked={vm.selected.has(r.id)}
                      onChange={() => vm.toggle(r.id)}
                      className="mx-auto block size-4 accent-ops-route"
                    />
                  </td>
                  <td className="text-left">
                    <span className="flex min-w-0 items-center gap-2">
                      <Link
                        to={`/companies/${r.id}`}
                        className="truncate font-medium hover:text-ops-route"
                      >
                        {r.name}
                      </Link>
                    </span>
                  </td>
                  <td className="tabular-nums">{r.members.toLocaleString('ko-KR')}명</td>
                  <td className="text-[13px]">{r.billing}</td>
                  <td className="text-[13px] whitespace-nowrap text-ops-sub tabular-nums">
                    {r.date}
                  </td>
                  <td>
                    <span className="flex justify-center">
                      <Btn kind="dangerBadge" onClick={() => askRow(r.id, r.name)}>
                        삭제
                      </Btn>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {vm.rows.length === 0 &&
            (vm.isLoading ? (
              <SkeletonRows rows={8} />
            ) : (
              <p className="flex flex-1 items-center justify-center py-16 text-center text-[14px] text-ops-sub">
                {vm.loadError ??
                  (vm.q ? '검색어에 맞는 기업이 없습니다.' : '등록된 기업이 없습니다.')}
              </p>
            ))}
        </div>
        <Pagination
          page={vm.page}
          size={size}
          total={vm.total}
          unit="곳"
          onPage={vm.setPage}
          onSize={setSize}
        />
      </section>
      {vm.csvOpen && <CompanyCsvModal onClose={vm.closeCsv} />}
      {(vm.confirming || asking) && (
        <Confirm
          title="기업을 삭제할까요?"
          ok="삭제"
          danger
          busy={vm.deleting || removeOne.isPending}
          error={removeOne.error ? errorText(removeOne.error, '삭제') : null}
          onOk={() =>
            vm.confirming
              ? void vm.removeSelected()
              : asking && removeOne.mutate(asking.id, { onSuccess: () => setAsking(null) })
          }
          onClose={() => {
            vm.cancelDelete()
            setAsking(null)
            removeOne.reset()
          }}
        >
          <b className="font-semibold">
            {vm.confirming
              ? `${vm.selectedNames.slice(0, 3).join(', ')}${vm.selectedNames.length > 3 ? ` 외 ${vm.selectedNames.length - 3}곳` : ''}`
              : asking?.name}
          </b>
          을(를) 삭제합니다. 사원 소속도 함께 지워지고 되돌릴 수 없습니다.
        </Confirm>
      )}
    </>
  )
}
