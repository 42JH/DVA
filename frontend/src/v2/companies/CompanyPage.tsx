// v2 기업 상세 (11/06) — 위: 기업 이름 · 사원 수 · 등록일 · 대표자 / 사원 표(사번 · 이름 · 전화 · 주소) · 사원 추가 · CSV · 수정 · 삭제
// 데이터 · 저장은 기존 useCompanyDetail · v2 창(CompanyModals) — 규칙은 기존 훅 그대로
import { useRef } from 'react'
import { useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { companyQueries } from '@/features/company/api/companyApi'
import { useCompanyDetail } from '@/features/company/hooks/useCompanyDetail'
import { PageHead } from '@/v2/V2Layout'
import { Badge, Btn, Icon } from '@/v2/ui'
import { SearchBox, SkeletonRows } from '@/v2/ui/ListFrame'
import { useScrollable } from '@/v2/lib/useScrollable'
import { Pagination } from '@/v2/ui/Pagination'
import { usePageSize } from '@/v2/lib/paging'
import { MemberCsvModal, MemberFormModal } from './CompanyModals'
import { Confirm } from '@/v2/ui/Modal'

export function CompanyPage() {
  const id = Number(useParams().companyId)
  // 부서 번호 → 이름 (사원 응답엔 번호만 있음)
  const depts = useQuery(companyQueries.departments(id))
  const deptName = new Map((depts.data ?? []).map((d) => [d.departmentSeq, d.name]))
  const [size, setSize] = usePageSize()
  const vm = useCompanyDetail(id, size)
  const box = useRef<HTMLDivElement>(null)
  const scrollable = useScrollable(box, [vm.rows])
  const facts = vm.summary ? vm.summary.split(' · ') : [] // 훅이 만든 한 줄을 칸으로 나눠 보여 줌

  return (
    <>
      <PageHead title={vm.name || '기업'} back={{ to: '/companies', label: '기업 목록으로' }}>
        <SearchBox
          value={vm.q}
          onChange={vm.setQ}
          placeholder="이름, 사번, 전화번호로 검색"
          label="사원 검색"
        />
        <span className="ml-auto flex gap-2">
          <Btn kind="primaryLime" onClick={vm.openCsv}>
            <Icon name="sheet" />
            CSV로 사원 등록
          </Btn>
          <Btn kind="primary" onClick={vm.openAdd}>
            <Icon name="users" />
            사원 등록
          </Btn>
        </span>
      </PageHead>
      {vm.notFound || vm.loadError ? (
        <p className="flex flex-1 items-center justify-center py-16 text-center text-[14px] text-ops-sub">
          {vm.notFound ? '기업을 찾을 수 없습니다.' : vm.loadError}
        </p>
      ) : (
        <section aria-label="사원" className="flex min-h-0 flex-1 flex-col gap-3 px-6 pt-4 pb-4">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            {facts.map((f) => (
              <span key={f} className="text-[13px] text-ops-sub">
                {f}
              </span>
            ))}
          </div>
          <div
            ref={box}
            data-scrollable={scrollable || undefined}
            className="flex min-h-0 flex-1 [scrollbar-width:thin] flex-col overflow-auto rounded-lg border border-ops-line bg-white"
          >
            <table className="ops-table min-w-[1040px]">
              <thead>
                <tr>
                  <th scope="col" className="w-[100px]">
                    사번
                  </th>
                  <th scope="col" className="w-[100px]">
                    부서
                  </th>
                  <th scope="col" className="w-[80px]">
                    직급
                  </th>
                  <th scope="col" className="w-[100px]">
                    이름
                  </th>
                  <th scope="col" className="w-[130px]">
                    전화번호
                  </th>
                  <th scope="col">주소</th>
                  <th scope="col" className="w-[100px] text-right">
                    관리
                  </th>
                </tr>
              </thead>
              <tbody>
                {vm.rows.map((r) => (
                  <tr key={r.id} className="h-11">
                    <td className="text-[13px] whitespace-nowrap tabular-nums">{r.employeeNo}</td>
                    <td className="truncate text-[13px]">
                      {deptName.get(r.member.membership.departmentSeq ?? -1) ?? ''}
                    </td>
                    <td>{r.leader && <Badge tone="route">대표자</Badge>}</td>
                    <td>
                      <span className="flex items-center justify-center gap-1.5">
                        <span className="truncate font-medium">{r.name}</span>
                      </span>
                    </td>
                    <td className="text-[13px] whitespace-nowrap tabular-nums">{r.phone}</td>
                    <td
                      className="truncate text-left text-[13px]"
                      title={`${r.address} ${r.detail}`}
                    >
                      {r.address === '없음' ? (
                        <span className="text-ops-stop">주소 없음</span>
                      ) : (
                        `${r.address} ${r.detail === '없음' ? '' : r.detail}`
                      )}
                    </td>
                    <td>
                      <span className="flex justify-center gap-1">
                        <Btn kind="warning" onClick={() => vm.openEdit(r.member)}>
                          수정
                        </Btn>
                        <Btn kind="dangerBadge" onClick={() => vm.askDelete(r.member)}>
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
                  {vm.q
                    ? '검색어에 맞는 사원이 없습니다.'
                    : '등록된 사원이 없습니다. 사원을 추가하거나 CSV로 한 번에 등록하세요.'}
                </p>
              ))}
          </div>
          <Pagination
            page={vm.page}
            size={size}
            total={vm.total}
            unit="명"
            onPage={vm.setPage}
            onSize={setSize}
          />
        </section>
      )}
      {(vm.modal?.kind === 'add' || vm.modal?.kind === 'edit') && (
        <MemberFormModal
          companyId={id}
          companyName={vm.name}
          member={vm.modal.kind === 'edit' ? vm.modal.member : null}
          onClose={vm.close}
        />
      )}
      {vm.modal?.kind === 'delete' && (
        <Confirm
          title="사원을 삭제할까요?"
          ok="삭제"
          danger
          busy={vm.deleting}
          error={vm.deleteError}
          onOk={vm.confirmDelete}
          onClose={vm.close}
        >
          <b className="font-semibold">{vm.modal.member.customer.name}</b> 사원을 이 기업에서
          삭제합니다. 고객 정보와 지난 주문은 남습니다.
        </Confirm>
      )}
      {vm.modal?.kind === 'csv' && (
        <MemberCsvModal companyId={id} companyName={vm.name} onClose={vm.close} />
      )}
    </>
  )
}
