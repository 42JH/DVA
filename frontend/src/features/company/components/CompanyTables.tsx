// 08 기업 상세의 표 — 사원 탭 · 청구 내역 탭(고른 건 상세 포함). 화면 틀 · 카드 · 창은 CompanyPage
import { useRef } from 'react'
import { Link } from 'react-router'
import type { useCompanyDetail } from '@/features/company/hooks/useCompanyDetail'
import type { Charge } from '@/features/company/api/companyApi'
import { Badge, Btn, Icon } from '@/shared/ui'
import { SkeletonRows } from '@/shared/ui/ListFrame'
import { useScrollable } from '@/shared/lib/useScrollable'
import { useKeepScroll } from '@/shared/lib/keepScroll'
import { fmtDate, fmtDateTime, fmtPhone } from '@/shared/lib/format'

const won = (n: number) => `${n.toLocaleString('ko-KR')}원`

type VM = ReturnType<typeof useCompanyDetail>

function useBox(dep: unknown) {
  const box = useRef<HTMLDivElement>(null)
  const scrollable = useScrollable(box, [dep])
  useKeepScroll(box, 'table')
  return { ref: box, 'data-scrollable': scrollable || undefined }
}

/** 사원 표 — 사번 · 이름 · 구분 · 부서 · 전화번호 · 주소 · 관리 */
export function MemberTable({ vm }: { vm: VM }) {
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
export function ChargeTable({ vm }: { vm: VM }) {
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
