// 기업 상세 (11/11 재설계, Figma '기업 재설계 v3') — 위: 이름 · 등록 · 담당자 수 · 사원 수 · [이름 수정] [기업 삭제]
// 청구액 카드(달 이동) · 왼쪽 부서(사원 거르기 · 추가 · 이름 변경 · 삭제) · 오른쪽 탭: 사원 / 청구 내역(+ 고른 건 상세)
// 기업은 월결제 고정(기업 간 배송) → 결제 설정 없음. 숨긴 버튼 · 설명 문구 없음 (11/11 사용자)
import { useRef } from 'react'
import { Link, useParams } from 'react-router'
import { useCompanyDetail } from '@/features/company/hooks/useCompanyDetail'
import type { Charge } from '@/features/company/api/companyApi'
import { PageHead } from '@/shared/ui'
import { Badge, Btn, Icon, Segments } from '@/shared/ui'
import { SearchBox, SkeletonRows } from '@/shared/ui/ListFrame'
import { useScrollable } from '@/shared/lib/useScrollable'
import { useKeepScroll } from '@/shared/lib/keepScroll'
import { Pagination } from '@/shared/ui/Pagination'
import { usePageSize } from '@/shared/lib/paging'
import { fmtDate, fmtDateTime, fmtPhone } from '@/shared/lib/format'
import { MemberCsvModal, MemberFormModal, NameModal } from './CompanyModals'
import { Confirm } from '@/shared/ui/Modal'

const won = (n: number) => `${n.toLocaleString('ko-KR')}원`
const card = 'rounded-lg border border-ops-line bg-white'

export function CompanyPage() {
  const id = Number(useParams().companyId)
  const [size, setSize] = usePageSize()
  const vm = useCompanyDetail(id, size)

  return (
    <>
      <PageHead title={vm.name || '기업'} back={{ to: '/companies', label: '기업 목록으로' }}>
        {/* 이름 수정은 이름 바로 옆 연필 (11/11: 위 줄 색 버튼을 줄임) */}
        <button
          type="button"
          aria-label="기업 이름 수정"
          title="기업 이름 수정"
          onClick={() => vm.open({ kind: 'rename' })}
          className="-ml-2 grid size-8 place-items-center rounded-md text-ops-faint hover:bg-ops-paper hover:text-ops-ink"
        >
          <Icon name="pen" />
        </button>
        <span className="flex items-center gap-4 pl-1">
          {vm.facts.map(([k, v]) => (
            <span key={k} className="flex gap-1.5 text-[13px]">
              <span className="text-ops-faint">{k}</span>
              <span className="font-medium text-ops-sub tabular-nums">{v}</span>
            </span>
          ))}
        </span>
        <Btn kind="danger" className="ml-auto" onClick={() => vm.open({ kind: 'deleteCompany' })}>
          기업 삭제
        </Btn>
      </PageHead>
      {vm.notFound || vm.loadError ? (
        <p className="flex flex-1 items-center justify-center py-16 text-center text-[14px] text-ops-sub">
          {vm.notFound ? '기업을 찾을 수 없습니다.' : vm.loadError}
        </p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4 px-6 pt-4 pb-4">
          <BillingCard vm={vm} />
          <div className="flex min-h-0 flex-1 gap-4">
            <DeptPanel vm={vm} />
            <section
              aria-label="사원과 청구 내역"
              className={`${card} flex min-w-0 flex-1 flex-col`}
            >
              <TabHead vm={vm} />
              {vm.tab === 'members' ? <MemberTable vm={vm} /> : <ChargeTable vm={vm} />}
              <div className="border-t border-ops-line px-4 py-2.5">
                <Pagination
                  page={vm.page}
                  size={size}
                  total={vm.total}
                  unit={vm.tab === 'members' ? '명' : '건'}
                  onPage={vm.setPage}
                  onSize={setSize}
                />
              </div>
            </section>
          </div>
        </div>
      )}
      <Modals vm={vm} id={id} />
    </>
  )
}

type VM = ReturnType<typeof useCompanyDetail>

/** 청구액 — 기업 월결제로 그 달 청구할 금액 · 건수 · 지난달 */
function BillingCard({ vm }: { vm: VM }) {
  return (
    <section aria-label="청구액" className={`${card} flex items-end gap-3 px-5 py-4`}>
      <div className="flex flex-col gap-1">
        <h2 className="text-[13px] font-semibold text-ops-sub">{vm.monthNum}월 청구액</h2>
        <p className="flex items-baseline gap-2.5">
          <b className="text-[26px] font-bold tabular-nums">
            {vm.amount === null ? '' : won(vm.amount)}
          </b>
          {vm.chargeTotal !== null && (
            <span className="text-[13px] font-medium text-ops-sub">{vm.chargeTotal}건</span>
          )}
          {vm.prevAmount !== null && (
            <span className="text-[12px] text-ops-faint">지난달 {won(vm.prevAmount)}</span>
          )}
        </p>
      </div>
      <span className="ml-auto flex items-center gap-1 self-start">
        <Btn kind="plain" aria-label="이전 달" onClick={vm.prevMonth} className="px-1.5!">
          <Icon name="chevron" className="size-4 rotate-90" />
        </Btn>
        <span className="min-w-[88px] text-center text-[13px] font-semibold tabular-nums">
          {vm.monthLabel}
        </span>
        <Btn
          kind="plain"
          aria-label="다음 달"
          onClick={vm.nextMonth}
          disabled={!vm.nextMonth}
          className="px-1.5!"
        >
          <Icon name="chevron" className="size-4 -rotate-90" />
        </Btn>
      </span>
    </section>
  )
}

/** 부서 — 누르면 사원 탭이 그 부서로 걸러짐. 이름 변경 · 삭제는 줄에 바로 보이게 */
function DeptPanel({ vm }: { vm: VM }) {
  const item = (key: string, name: string, count: number, actions?: React.ReactNode) => {
    const on = vm.dept === key
    return (
      <li key={key} className={`border-b border-ops-line ${on ? 'bg-ops-route-soft' : ''}`}>
        <button
          type="button"
          aria-pressed={on}
          onClick={() => vm.pickDept(key)}
          className="flex w-full items-center gap-1.5 px-4 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ops-route focus-visible:ring-inset"
        >
          <span className={`truncate text-[14px] font-semibold ${on ? 'text-ops-route' : ''}`}>
            {name}
          </span>
          <span className="text-[12px] text-ops-sub tabular-nums">{count}명</span>
        </button>
        {/* 이름 변경 · 삭제는 고른 부서에만 (부서마다 버튼이 붙어 시끄러웠음, 11/11) */}
        {on && actions && <div className="-mt-1 flex gap-1.5 px-4 pb-2.5">{actions}</div>}
      </li>
    )
  }
  return (
    <section aria-label="부서" className={`${card} flex w-[220px] shrink-0 flex-col xl:w-[280px]`}>
      <div className="flex h-12 items-center border-b border-ops-line px-4">
        <h2 className="text-[14px] font-bold">부서</h2>
      </div>
      <ul className="min-h-0 flex-1 [scrollbar-width:thin] overflow-y-auto">
        {item('', '전체 사원', vm.allCount)}
        {vm.depts.map((d) =>
          item(
            String(d.departmentSeq),
            d.name,
            d.memberCount,
            <>
              <Btn kind="editBadge" onClick={() => vm.open({ kind: 'renameDept', dept: d })}>
                이름 변경
              </Btn>
              <Btn kind="dangerBadge" onClick={() => vm.open({ kind: 'deleteDept', dept: d })}>
                삭제
              </Btn>
            </>,
          ),
        )}
        {vm.noDeptCount > 0 && item('none', '부서 없음', vm.noDeptCount)}
        <li>
          <button
            type="button"
            onClick={() => vm.open({ kind: 'addDept' })}
            className="flex w-full items-center gap-1.5 px-4 py-3 text-[13px] font-semibold text-ops-route outline-none hover:bg-ops-route-soft focus-visible:ring-2 focus-visible:ring-ops-route focus-visible:ring-inset"
          >
            <Icon name="plus" />
            부서 추가
          </button>
        </li>
      </ul>
    </section>
  )
}

/** 탭 머리 — 사원 / 청구 내역 · 탭마다 검색과 버튼 */
function TabHead({ vm }: { vm: VM }) {
  const tab = (key: 'members' | 'charges', label: string, n: number | null) => {
    const on = vm.tab === key
    return (
      <button
        type="button"
        role="tab"
        aria-selected={on}
        onClick={() => vm.setTab(key)}
        className={`flex h-12 items-center gap-1.5 border-b-2 text-[14px] whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ops-route ${on ? 'border-ops-ink font-bold' : 'border-transparent font-medium text-ops-sub hover:text-ops-ink'}`}
      >
        {label}
        {n !== null && (
          <span className={`text-[13px] tabular-nums ${on ? 'text-ops-route' : 'text-ops-faint'}`}>
            {n}
          </span>
        )}
      </button>
    )
  }
  return (
    // 좁은 화면(1024)에선 오른쪽 도구가 아랫줄로 넘어감
    <div className="flex flex-wrap items-center gap-x-3 border-b border-ops-line pr-3 pl-5 max-xl:pb-2">
      <div role="tablist" aria-label="사원과 청구 내역" className="flex shrink-0 gap-5">
        {tab('members', '사원', vm.allCount)}
        {tab('charges', '청구 내역', vm.chargeTotal)}
      </div>
      {vm.tab === 'members' ? (
        <span className="ml-auto flex items-center gap-2">
          <span className="shrink-0">
            <Segments
              label="구분"
              value={vm.role}
              items={[
                { value: 'all', label: '전체', count: vm.byDeptCount },
                { value: 'manager', label: '담당자', count: vm.byDeptManagers },
              ]}
              onPick={vm.setRole}
            />
          </span>
          <span className="[&>label]:w-56 max-xl:[&>label]:w-40">
            <SearchBox
              value={vm.q}
              onChange={vm.setQ}
              placeholder="이름, 사번, 전화번호"
              label="사원 검색"
            />
          </span>
          <Btn kind="line" onClick={() => vm.open({ kind: 'add' })}>
            <Icon name="plus" />
            사원 등록
          </Btn>
        </span>
      ) : (
        <span className="ml-auto max-xl:[&>label]:w-60">
          <SearchBox
            value={vm.cq}
            onChange={vm.setCq}
            placeholder="보낸 사원, 받는 기업, 받는 분, 주문 번호"
            label="청구 내역 검색"
          />
        </span>
      )}
    </div>
  )
}

function useBox(dep: unknown) {
  const box = useRef<HTMLDivElement>(null)
  const scrollable = useScrollable(box, [dep])
  useKeepScroll(box, 'table')
  return { ref: box, 'data-scrollable': scrollable || undefined }
}

/** 사원 표 — 사번 · 이름 · 구분 · 부서 · 전화번호 · 주소 · 관리 */
function MemberTable({ vm }: { vm: VM }) {
  const box = useBox(vm.rows)
  return (
    <div {...box} className="flex min-h-0 flex-1 [scrollbar-width:thin] flex-col overflow-auto">
      <table className="ops-table min-w-[860px]">
        <thead>
          <tr>
            <th scope="col" className="w-[72px]">
              사번
            </th>
            <th scope="col" className="w-[96px]">
              이름
            </th>
            <th scope="col" className="w-[84px]">
              구분
            </th>
            <th scope="col" className="w-[90px]">
              부서
            </th>
            <th scope="col" className="w-[136px]">
              전화번호
            </th>
            <th scope="col" className="pl-[15px]! text-left!">
              주소
            </th>
            <th scope="col" className="w-[212px]">
              관리
            </th>
          </tr>
        </thead>
        <tbody>
          {vm.rows.map((r) => (
            <tr key={r.id} className="h-11">
              <td className="text-center text-ops-sub tabular-nums">{r.employeeNo}</td>
              <td className="truncate text-center font-semibold">{r.name}</td>
              <td className="text-center">
                {r.manager ? (
                  <Badge tone="route">담당자</Badge>
                ) : (
                  <span className="text-ops-sub">사원</span>
                )}
              </td>
              <td className={`truncate text-center ${r.dept === null ? 'text-ops-faint' : ''}`}>
                {r.dept ?? '없음'}
              </td>
              <td className="text-center whitespace-nowrap tabular-nums">{r.phone}</td>
              <td className="truncate text-left" title={r.address ?? undefined}>
                {r.address ?? <span className="text-ops-stop">주소 없음</span>}
              </td>
              <td>
                <span className="flex justify-center gap-1.5">
                  <Btn kind="plainBadge" onClick={() => vm.showCharges(r.name)}>
                    청구 내역
                  </Btn>
                  <Btn kind="editBadge" onClick={() => vm.open({ kind: 'edit', member: r.member })}>
                    수정
                  </Btn>
                  <Btn kind="dangerBadge" onClick={() => vm.askDeleteMember(r.member)}>
                    삭제
                  </Btn>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {vm.rows.length === 0 &&
        (vm.membersLoading ? (
          <SkeletonRows rows={6} />
        ) : (
          <p className="flex flex-1 items-center justify-center py-16 text-center text-[14px] text-ops-sub">
            {vm.q ? '검색어에 맞는 사원이 없습니다.' : '사원이 없습니다.'}
          </p>
        ))}
    </div>
  )
}

/** 청구 내역 — 그 달 기업 간 배송 월결제 건. 줄을 누르면 오른쪽에 그 건 상세(다시 누르거나 X로 닫음) */
function ChargeTable({ vm }: { vm: VM }) {
  const box = useBox(vm.charges)
  const searching = vm.cq.trim() !== ''
  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <p className="flex h-9 shrink-0 items-center gap-2 border-b border-ops-line bg-[#f7f8fa] px-5 text-[12px] text-ops-sub">
          <span className="font-semibold">{searching ? '검색' : `${vm.monthNum}월 청구`}</span>
          <span className="tabular-nums">{vm.total}건</span>
          {vm.chargesSum !== null && (
            <b className="text-[13px] font-bold text-ops-ink tabular-nums">{won(vm.chargesSum)}</b>
          )}
        </p>
        <div {...box} className="flex min-h-0 flex-1 [scrollbar-width:thin] flex-col overflow-auto">
          <table className="ops-table min-w-[480px]">
            <thead>
              <tr>
                <th scope="col" className="w-[96px]">
                  결제
                </th>
                <th scope="col" className="w-[150px]">
                  보낸 사원
                </th>
                <th scope="col" className="pl-[15px]! text-left!">
                  받는 기업
                </th>
                <th scope="col" className="w-[120px]">
                  금액
                </th>
              </tr>
            </thead>
            <tbody>
              {vm.charges.map((c) => (
                <tr
                  key={c.orderSeq}
                  aria-selected={vm.picked?.orderSeq === c.orderSeq}
                  onClick={() => vm.pick(c.orderSeq)}
                  className="h-[52px] cursor-pointer"
                >
                  <td className="text-center leading-tight tabular-nums">
                    <b className="block text-[13px] font-semibold">
                      {fmtDateTime(c.paidAt).slice(0, 5).replace('-', '.')}
                    </b>
                    <span className="text-[12px] text-ops-sub">
                      {fmtDateTime(c.paidAt).slice(6)}
                    </span>
                  </td>
                  <td className="text-center leading-tight">
                    <b className="block truncate text-[13px] font-semibold">{c.sender.name}</b>
                    <span className="text-[12px] text-ops-sub">
                      {c.sender.departmentName ?? '부서 없음'}
                    </span>
                  </td>
                  <td className="text-left leading-tight">
                    <b className="block truncate text-[13px] font-semibold">
                      {c.recipient.organizationName}
                    </b>
                    <span className="text-[12px] text-ops-sub">{c.recipient.name}</span>
                  </td>
                  <td className="text-center font-bold tabular-nums">{won(c.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {vm.charges.length === 0 &&
            (vm.chargesLoading ? (
              <SkeletonRows rows={6} />
            ) : (
              <p className="flex flex-1 items-center justify-center py-16 text-center text-[14px] text-ops-sub">
                {vm.chargesError ??
                  (searching ? '검색어에 맞는 청구 건이 없습니다.' : '이 달에 청구 건이 없습니다.')}
              </p>
            ))}
        </div>
      </div>
      {vm.picked && <ChargePanel c={vm.picked} onClose={vm.unpick} />}
    </div>
  )
}

/** 고른 청구 건 — 결제 일시 · 보낸 사원 · 받는 기업 · 품목 · 합계 · [주문 상세](주문 화면의 송장 상세로) */
function ChargePanel({ c, onClose }: { c: Charge; onClose: () => void }) {
  const dash = 'border-t border-dashed border-[#c3c9d3]'
  return (
    <aside
      aria-label="청구 건"
      className="flex w-[330px] shrink-0 flex-col gap-3.5 overflow-y-auto border-l border-ops-line bg-[#fbfcfd] px-5 py-4 text-[13px]"
    >
      <div className="flex items-center gap-2">
        <h3 className="text-[15px] font-bold">청구 건</h3>
        <span className="ml-auto text-[12px] text-ops-sub tabular-nums">
          DV-{String(c.orderSeq).padStart(5, '0')}
        </span>
        <button
          type="button"
          aria-label="닫기"
          onClick={onClose}
          className="grid size-7 place-items-center rounded-md text-ops-sub hover:bg-ops-paper hover:text-ops-ink"
        >
          <Icon name="x" />
        </button>
      </div>
      <p className="flex justify-between">
        <span className="text-ops-sub">결제 일시</span>
        <span className="tabular-nums">
          {fmtDate(c.paidAt)} {fmtDateTime(c.paidAt).slice(6)}
        </span>
      </p>
      <hr className={dash} />
      <Party
        title="보낸 사원"
        name={c.sender.name}
        sub={c.sender.departmentName}
        phone={c.sender.phoneNumber}
        address={c.sender.address}
      />
      <Party
        title="받는 기업"
        org={c.recipient.organizationName}
        name={c.recipient.name}
        phone={c.recipient.phoneNumber}
        address={c.recipient.address}
      />
      <hr className={dash} />
      <ul className="flex flex-col gap-1.5">
        {c.items.map((it) => (
          <li key={it.label} className="flex justify-between">
            <span className="text-ops-sub">{it.label}</span>
            <span className="tabular-nums">{won(it.amount)}</span>
          </li>
        ))}
      </ul>
      <hr className="border-t border-ops-line" />
      <p className="flex items-center justify-between">
        <span className="font-semibold">합계</span>
        <b className="text-[20px] font-bold tabular-nums">{won(c.amount)}</b>
      </p>
      <Link
        to={`/orders?o=${c.orderSeq}`}
        className="mt-auto flex h-9 items-center justify-center rounded-md bg-ops-route text-[13px] font-semibold text-white hover:brightness-110"
      >
        주문 상세
      </Link>
    </aside>
  )
}

function Party(p: {
  title: string
  org?: string
  name: string
  sub?: string | null
  phone: string
  address: string
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] font-semibold text-ops-faint">{p.title}</span>
      {p.org && <b className="text-[14px] font-bold">{p.org}</b>}
      <span className="flex items-center gap-2">
        <b className="font-semibold">{p.name}</b>
        {p.sub && <span className="text-[12px] text-ops-sub">{p.sub}</span>}
        <span className="text-[12px] text-ops-sub tabular-nums">{fmtPhone(p.phone)}</span>
      </span>
      <span>{p.address}</span>
    </div>
  )
}

/** 창 — 한 번에 하나 */
function Modals({ vm, id }: { vm: VM; id: number }) {
  const m = vm.modal
  if (!m) return null
  switch (m.kind) {
    case 'add':
    case 'edit':
      return (
        <MemberFormModal
          companyId={id}
          companyName={vm.name}
          member={m.kind === 'edit' ? m.member : null}
          onClose={vm.close}
          onCsv={() => vm.open({ kind: 'csv' })}
          initialDept={/^\d+$/.test(vm.dept) ? Number(vm.dept) : null}
        />
      )
    case 'csv':
      return <MemberCsvModal companyId={id} companyName={vm.name} onClose={vm.close} />
    case 'rename':
      return (
        <NameModal
          title="기업 이름 수정"
          label="기업명"
          initial={vm.name}
          busy={vm.busy}
          error={vm.error}
          onSave={vm.renameCompany}
          onClose={vm.close}
        />
      )
    case 'addDept':
      return (
        <NameModal
          title="부서 추가"
          label="부서 이름"
          ok="추가"
          busy={vm.busy}
          error={vm.error}
          onSave={vm.addDept}
          onClose={vm.close}
        />
      )
    case 'renameDept':
      return (
        <NameModal
          title="부서 이름 변경"
          label="부서 이름"
          initial={m.dept.name}
          busy={vm.busy}
          error={vm.error}
          onSave={(name) => vm.renameDept(m.dept, name)}
          onClose={vm.close}
        />
      )
    case 'deleteDept':
      return (
        <Confirm
          // 백엔드: 부서를 지우면 그 부서 사원의 기업 소속도 해제됨 (company-deletion.md)
          title={
            m.dept.memberCount
              ? `${m.dept.name}과(와) 사원 ${m.dept.memberCount}명을 삭제할까요?`
              : `${m.dept.name}을(를) 삭제할까요?`
          }
          ok="삭제"
          busy={vm.busy}
          error={vm.error}
          onOk={() => vm.deleteDept(m.dept)}
          onClose={vm.close}
        />
      )
    case 'deleteCompany':
      return (
        <Confirm
          title={`${vm.name}을(를) 삭제할까요?`}
          ok="기업 삭제"
          danger
          busy={vm.busy}
          error={vm.error}
          onOk={vm.deleteCompany}
          onClose={vm.close}
        />
      )
    case 'deleteMember':
      // 기업마다 담당자 1명 이상 (11/11 사용자) — 마지막 담당자는 지우지 못함
      return m.last ? (
        <Confirm
          title="마지막 담당자는 삭제할 수 없습니다"
          ok="확인"
          onOk={vm.close}
          onClose={vm.close}
        >
          다른 사원을 담당자로 지정한 뒤 삭제해 주세요.
        </Confirm>
      ) : (
        <Confirm
          title={`${m.member.customer.name} 사원을 삭제할까요?`}
          ok="삭제"
          busy={vm.busy}
          error={vm.error}
          onOk={() => vm.deleteMember(m.member)}
          onClose={vm.close}
        />
      )
  }
}
