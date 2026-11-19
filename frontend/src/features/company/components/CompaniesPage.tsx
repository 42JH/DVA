// 기업 목록 — 통화 목록과 같은 표 · 줄을 누르면 기업 상세. 칸: 기업 · 담당자 · 사원 · 부서 · 이번 달 청구액 · 등록
// 삭제 · 이름 수정은 상세 화면에서 (줄마다 버튼 · 체크 없음). 정렬은 등록 최신순 고정(서버 기본)
import { useRef } from 'react'
import { Link, useNavigate } from 'react-router'
import { useCompanyList } from '@/features/company/hooks/useCompanyList'
import { useFitNames } from '@/features/company/fitNames'
import { PageHead } from '@/shared/ui'
import { Btn, Icon } from '@/shared/ui'
import { SearchBox, SkeletonRows } from '@/shared/ui/ListFrame'
import { useScrollable } from '@/shared/lib/useScrollable'
import { useKeepScroll } from '@/shared/lib/keepScroll'
import { CompanyCsvModal } from './CompanyModals'
import { Pagination } from '@/shared/ui/Pagination'
import { usePageSize } from '@/shared/lib/paging'
import { todayYmd } from '@/shared/lib/dateRange'

const won = (n: number) => `${n.toLocaleString('ko-KR')}원`

export function CompaniesPage() {
  const navigate = useNavigate()
  const [size, setSize] = usePageSize()
  const vm = useCompanyList(size)
  const box = useRef<HTMLDivElement>(null)
  const scrollable = useScrollable(box, [vm.rows])
  useKeepScroll(box, 'list')
  const month = Number(todayYmd().slice(5, 7))
  return (
    <>
      <PageHead title="기업">
        <SearchBox
          value={vm.q}
          onChange={vm.setQ}
          placeholder="기업명으로 검색"
          label="기업 검색"
        />
        <Btn kind="primary" className="ml-auto" onClick={vm.openCsv}>
          <Icon name="sheet" />
          CSV로 기업 등록
        </Btn>
      </PageHead>
      <section aria-label="기업 목록" className="flex min-h-0 flex-1 flex-col gap-3 px-6 pt-4 pb-4">
        <div
          ref={box}
          data-scrollable={scrollable || undefined}
          className="flex min-h-0 flex-1 [scrollbar-width:thin] flex-col overflow-auto rounded-lg border border-ops-line bg-white"
        >
          <table className="ops-table min-w-[900px]">
            <thead>
              <tr>
                <th scope="col">기업</th>
                <th scope="col" className="w-[32%]">
                  담당자
                </th>
                <th scope="col" className="w-[90px]">
                  사원
                </th>
                <th scope="col" className="w-[80px]">
                  부서
                </th>
                <th scope="col" className="w-[130px]">
                  {month}월 청구액
                </th>
                <th scope="col" className="w-[120px]">
                  등록
                </th>
              </tr>
            </thead>
            <tbody>
              {vm.rows.map((r) => (
                // 줄 어디를 눌러도 기업 상세로. 이름 칸은 링크라 키보드 · 새 탭도 됨
                <tr
                  key={r.id}
                  onClick={() => navigate(`/companies/${r.id}`)}
                  className="h-11 cursor-pointer"
                >
                  <td className="p-0! text-left">
                    <Link
                      to={`/companies/${r.id}`}
                      onClick={(e) => e.stopPropagation()}
                      className="flex h-11 w-full min-w-0 items-center px-[15px] font-semibold outline-none hover:text-ops-route focus-visible:ring-2 focus-visible:ring-ops-route focus-visible:ring-inset"
                    >
                      <span className="truncate">{r.name}</span>
                    </Link>
                  </td>
                  <td className="text-left">
                    <Managers names={r.managers} />
                  </td>
                  <td className="text-center tabular-nums">
                    {r.members.toLocaleString('ko-KR')}명
                  </td>
                  <td className="text-center tabular-nums">
                    {r.departments === null ? '' : `${r.departments}곳`}
                  </td>
                  <td
                    className={`text-center tabular-nums ${r.amount ? 'font-semibold text-ops-ink' : 'text-ops-faint'}`}
                  >
                    {r.amount === null ? '' : won(r.amount)}
                  </td>
                  <td className="text-center text-ops-sub tabular-nums">{r.date}</td>
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
    </>
  )
}

/** 담당자 칸 — 들어가는 만큼 이름 + '외 n명' */
function Managers({ names }: { names: string[] }) {
  const [ref, text] = useFitNames(names)
  return (
    <span ref={ref} className="block overflow-hidden whitespace-nowrap">
      {text}
    </span>
  )
}
