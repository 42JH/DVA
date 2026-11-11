// 고객 (11/06) — 모든 고객 표(이름 · 전화번호 · 구분(개인/기업) · 기본 주소 · 상세주소 · 결제 방법) → 줄을 누르면 오른쪽에 고객 정보 · 개인 주소록 · 주문 내역 · 통화 내역 바로 가기
import { useRef } from 'react'
import { Link } from 'react-router'
import { Btn, PageHead } from '@/shared/ui'
import { Icon } from '@/shared/ui'
import { rowKeys, useEscape } from '@/shared/lib/keys'
import { SearchBox } from '@/shared/ui/ListFrame'
import { Pagination } from '@/shared/ui/Pagination'
import { useScrollable } from '@/shared/lib/useScrollable'
import { useCustomer, useCustomers } from '../hooks/useCustomers'
import { CustomerEditForm } from './CustomerEditForm'

export function CustomersPage() {
  const vm = useCustomers()
  const box = useRef<HTMLDivElement>(null)
  const scrollable = useScrollable(box, [vm.rows])
  return (
    <>
      <PageHead title="고객">
        <SearchBox
          value={vm.q}
          onChange={vm.setQ}
          placeholder="이름, 전화번호로 검색"
          label="고객 검색"
        />
      </PageHead>
      <div className="flex min-h-0 flex-1">
        <section
          aria-label="고객 목록"
          className="flex min-w-0 flex-1 flex-col gap-3 px-6 pt-4 pb-4"
        >
          <div
            ref={box}
            data-scrollable={scrollable || undefined}
            className={`flex min-h-0 flex-1 [scrollbar-width:thin] flex-col overflow-auto rounded-lg border border-ops-line bg-white ${vm.isStale ? 'opacity-60' : ''}`}
          >
            <table className="ops-table min-w-[740px]">
              <thead>
                <tr>
                  <th scope="col" className="w-[100px]">
                    이름
                  </th>
                  <th scope="col" className="w-[130px]">
                    전화번호
                  </th>
                  <th scope="col" className="w-[100px]">
                    구분
                  </th>
                  <th scope="col">기본 주소</th>
                  <th scope="col">상세주소</th>
                  <th scope="col" className="w-[200px]">
                    결제 방법
                  </th>
                </tr>
              </thead>
              <tbody>
                {vm.rows.map((r) => {
                  const on = vm.open === r.seq
                  return (
                    <tr
                      key={r.seq}
                      tabIndex={0}
                      aria-selected={on}
                      onClick={() => vm.pick(r.seq)}
                      onKeyDown={rowKeys(() => vm.pick(r.seq))}
                      onMouseEnter={() => vm.warm(r.seq)}
                      onFocus={() => {
                        vm.warm(r.seq)
                        if (vm.open && !on) vm.pick(r.seq)
                      }}
                      className={`h-11 cursor-pointer outline-none focus-visible:bg-ops-route-soft ${on ? 'bg-ops-route-soft shadow-[inset_3px_0_0_var(--color-ops-route)]' : ''}`}
                    >
                      <td className="truncate font-medium">{r.name}</td>
                      <td className="text-[13px] whitespace-nowrap tabular-nums">{r.phone}</td>
                      <td className="text-[13px]" title={r.company}>
                        {r.kind}
                      </td>
                      <td className="truncate text-left text-[13px]" title={r.address}>
                        {r.address}
                      </td>
                      <td className="truncate text-left text-[13px]" title={r.detail}>
                        {r.detail}
                      </td>
                      <td className="truncate text-left text-[13px]">{r.payments?.join(', ')}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {vm.rows.length === 0 && (
              <p className="flex flex-1 items-center justify-center py-16 text-center text-[14px] text-ops-sub">
                {vm.isLoading
                  ? '불러오는 중…'
                  : (vm.error ?? (vm.q ? '검색어에 맞는 고객이 없습니다.' : '고객이 없습니다.'))}
              </p>
            )}
          </div>
          <Pagination
            page={vm.page}
            size={vm.size}
            total={vm.total}
            unit="명"
            onPage={vm.setPage}
            onSize={vm.setSize}
          />
        </section>
        {vm.open && (
          <div className="flex shrink-0 motion-safe:animate-panel-in">
            <CustomerPanel key={vm.open} seq={vm.open} onClose={vm.close} />
          </div>
        )}
      </div>
    </>
  )
}

function CustomerPanel({ seq, onClose }: { seq: number; onClose: () => void }) {
  const v = useCustomer(seq)
  useEscape(v.editing ? v.stopEdit : onClose) // 수정 중 Esc는 수정만 취소 (적던 내용을 패널째 잃지 않게)
  return (
    <aside
      aria-label="고객 정보"
      className="flex w-[420px] shrink-0 flex-col border-l border-ops-line bg-white max-xl:w-[360px]"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-ops-line px-5">
        <span className="text-[12px] font-medium text-ops-sub">고객 #{seq}</span>
        {v.canEdit && !v.editing && (
          <Btn kind="warning" className="ml-auto" onClick={v.startEdit}>
            수정
          </Btn>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="닫기"
          className={`${v.canEdit && !v.editing ? '' : 'ml-auto'} grid size-8 place-items-center rounded-md text-ops-sub hover:text-ops-ink`}
        >
          <Icon name="x" />
        </button>
      </div>
      <div className="min-h-0 flex-1 [scrollbar-width:thin] overflow-y-auto px-5 py-4">
        {!v.c ? (
          <p className="py-10 text-center text-[14px] text-ops-sub">{v.error ?? '불러오는 중…'}</p>
        ) : v.editing && v.dto ? (
          <CustomerEditForm before={v.dto} onDone={v.stopEdit} onWithdrawn={onClose} />
        ) : (
          <>
            <p className="text-[20px] font-bold">{v.c.name}</p>
            <p className="text-[14px] whitespace-nowrap text-ops-sub tabular-nums">{v.c.phone}</p>
            <dl className="mt-4 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-[13px]">
              <dt className="text-ops-sub">기본 주소</dt>
              <dd>{v.c.address || <span className="text-ops-faint">없음</span>}</dd>
              <dt className="text-ops-sub">상세주소</dt>
              <dd>{v.c.detail || <span className="text-ops-faint">없음</span>}</dd>
              <dt className="text-ops-sub">구분</dt>
              <dd>{v.c.payments && (v.c.company ? '기업 고객' : '일반 고객')}</dd>
              {v.c.company && (
                <>
                  <dt className="text-ops-sub">소속</dt>
                  <dd>
                    {v.c.companySeq ? (
                      <Link
                        to={`/companies/${v.c.companySeq}`}
                        className="text-ops-route underline-offset-2 hover:underline"
                      >
                        {v.c.company}
                      </Link>
                    ) : (
                      v.c.company
                    )}
                  </dd>
                </>
              )}
              <dt className="text-ops-sub">결제 방법</dt>
              <dd>{v.c.payments?.join(', ')}</dd>
              {v.monthly && (
                <>
                  <dt className="self-center text-ops-sub">이번 달 월결제</dt>
                  <dd className="text-[16px] font-bold tabular-nums">{v.monthly}</dd>
                </>
              )}
              <dt className="text-ops-sub">상태</dt>
              <dd>{v.c.withdrawn ? '탈퇴' : '이용 중'}</dd>
            </dl>
            <div className="mt-4 flex gap-2">
              <Link
                to={`/orders?q=${v.c.digits}&r=all`}
                className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md text-[13px] font-semibold ring-1 ring-ops-line ring-inset"
              >
                <Icon name="box" className="size-4" />
                주문 내역
              </Link>
              <Link
                to={`/calls?q=${v.c.digits}&r=all`}
                className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md text-[13px] font-semibold ring-1 ring-ops-line ring-inset"
              >
                <Icon name="phone" className="size-4" />
                통화 내역
              </Link>
            </div>

            <section className="mt-6">
              <h2 className="mb-2 flex items-baseline gap-1.5 text-[13px] font-semibold text-ops-sub">
                개인 주소록 <span className="text-ops-faint tabular-nums">{v.pinTotal}</span>
              </h2>
              {v.pinsError ? (
                <p className="text-[13px] text-ops-stop">{v.pinsError}</p>
              ) : v.pins.length === 0 ? (
                <p className="text-[13px] text-ops-faint">
                  {v.pinsLoading ? '불러오는 중…' : '저장된 주소가 없습니다.'}
                </p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {v.pins.map((p) => (
                    <li
                      key={p.key}
                      className="flex gap-2.5 rounded-md border border-ops-line px-3 py-2.5"
                    >
                      <Icon name="pin" className="mt-0.5 size-4 text-ops-sub" />
                      <span className="min-w-0 text-[13px]">
                        <span className="flex items-baseline gap-2">
                          <span className="font-semibold">{p.name}</span>
                          <span className="whitespace-nowrap text-ops-sub tabular-nums">
                            {p.phone}
                          </span>
                        </span>
                        <span className="block text-ops-ink/80">{p.address}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </aside>
  )
}
