// 주문 (11/06) — 상태 묶음(건수) · 기간 · 검색 → 칸 많은 표(가로 스크롤은 표 안에서만, 이전 · 다음 커서 쪽) → 줄을 누르면 오른쪽 운송장 패널
// 기업 피드백 반영: 주문번호 맨 앞 · 전화번호 · 물품 칸 추가 · 미완료는 회색으로 죽임 · 모달 대신 옆 패널
import { useState } from 'react'
import { PageHead } from '@/shared/ui'
import { Badge, Btn, Icon, Segments, SortTh } from '@/shared/ui'
import { rowKeys } from '@/shared/lib/keys'
import { ListFrame, SearchBox } from '@/shared/ui/ListFrame'
import { RANGES } from '@/shared/lib/range'
import { useOrders, type OrderRow, type OrdersVm } from '../hooks/useOrders'
import { WaybillPanel } from './Waybill'
import { OrderAddModal } from './OrderAdd'
import { CallOverlay } from './CallOverlay'
import { useWaybill } from '../hooks/useWaybill'

export function OrdersPage() {
  const vm = useOrders()
  const [adding, setAdding] = useState(false)
  const [moved, setMoved] = useState<{ seq: number; notice?: string } | null>(null) // 미완료 접수로 생긴 주문 · 결과

  return (
    <>
      <PageHead title="주문">
        <SearchBox
          value={vm.q}
          onChange={vm.setQ}
          placeholder="이름, 전화번호, 주소로 검색"
          label="주문 검색"
        />
        <Btn kind="primary" onClick={() => setAdding(true)} className="ml-auto">
          <Icon name="plus" />
          주문 추가
        </Btn>
      </PageHead>
      <div className="flex min-h-0 flex-1">
        <section
          aria-label="주문 목록"
          className="relative flex min-w-0 flex-1 flex-col gap-3 px-6 pt-4 pb-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Segments label="주문 상태" value={vm.group} items={vm.groups} onPick={vm.setGroup} />
            {vm.ranged && (
              <Segments label="기간" value={vm.range} items={RANGES} onPick={vm.setRange} />
            )}
          </div>
          <Table vm={vm} />
          {vm.picked && vm.callSeq && (
            <OpenCall
              orderSeq={vm.picked.orderSeq}
              parcelSeq={vm.picked.parcelSeq}
              seq={vm.callSeq}
              onClose={() => vm.setCall(null)}
            />
          )}
        </section>
        {vm.picked && (
          // 패널 틀은 처음 열 때만 미끄러져 들어오고, 줄을 바꾸면 안쪽만 바뀜
          <div className="flex shrink-0 motion-safe:animate-panel-in">
            <WaybillPanel
              key={`${vm.picked.orderSeq}-${vm.picked.parcelSeq}`}
              orderSeq={vm.picked.orderSeq}
              parcelSeq={vm.picked.parcelSeq}
              onClose={vm.unpick}
              openCall={vm.callSeq}
              onOpenCall={(c) => vm.setCall(c.seq)}
              // 미완료를 접수하면 새로 생긴 주문을 열고 결과 안내를 이어서 보여 줌
              onMoved={(seq, notice) => {
                setMoved({ seq, notice })
                vm.pick(seq, null)
              }}
              initialNotice={moved?.seq === vm.picked.orderSeq ? (moved.notice ?? null) : null}
            />
          </div>
        )}
      </div>
      {adding && <OrderAddModal onClose={() => setAdding(false)} />}
    </>
  )
}

// more = 상세 패널이 열리면 숨기는 칸 (표가 좁아져도 가로 스크롤 없이 핵심만)
const COLS: { label: string; className: string; more?: true }[] = [
  { label: '주문번호', className: 'w-[100px]' },
  { label: '상태', className: 'w-[85px]' },
  { label: '접수', className: 'w-[140px]' }, // '2026-11-07 14:31'이 들어가는 폭
  { label: '보내는 분', className: 'w-[170px]' },
  { label: '보내는 주소', className: '', more: true },
  { label: '받는 분', className: 'w-[170px]' },
  { label: '받는 주소', className: '', more: true },
  { label: '물품', className: 'w-[120px]', more: true },
  { label: '수거 희망', className: 'w-[140px]', more: true },
]

function Table({ vm }: { vm: OrdersVm }) {
  return (
    <ListFrame
      list={vm.list}
      unit="주문"
      empty={
        vm.q ? '검색어에 맞는 주문이 없습니다. 기간을 넓혀 보세요.' : '이 기간에 주문이 없습니다.'
      }
    >
      <table
        className={`ops-table [&_tbody_td:nth-child(2)]:px-2 ${vm.picked ? 'min-w-[680px]' : 'min-w-[1440px]'}`}
      >
        <thead>
          <tr>
            {COLS.filter((c) => !(vm.picked && c.more)).map((c) =>
              c.label === '접수' ? (
                <SortTh
                  key={c.label}
                  label={c.label}
                  asc={vm.asc}
                  onToggle={vm.toggleSort}
                  className={`${c.className} font-semibold text-black`}
                />
              ) : (
                <th key={c.label} scope="col" className={`${c.className} font-semibold text-black`}>
                  {c.label}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody className="text-[#333]">
          {vm.rows.map((r) => (
            <Row
              key={r.key}
              r={r}
              on={vm.picked?.orderSeq === r.orderSeq && vm.picked.parcelSeq === r.parcelSeq}
              compact={!!vm.picked}
              onPick={() => vm.pick(r.orderSeq, r.parcelSeq)}
              onWarm={() => vm.warm(r.orderSeq)}
            />
          ))}
        </tbody>
      </table>
    </ListFrame>
  )
}

function Row({
  r,
  on,
  compact,
  onPick,
  onWarm,
}: {
  r: OrderRow
  on: boolean
  compact: boolean
  onPick: () => void
  onWarm: () => void
}) {
  const dim = r.incomplete ? 'text-ops-faint' : ''
  return (
    <tr
      tabIndex={0}
      aria-selected={on}
      onClick={onPick}
      onKeyDown={rowKeys(onPick)}
      onMouseEnter={onWarm}
      // 상세가 열린 채 ↑ ↓로 옮기면 그 줄 상세로 (메일 앱처럼)
      onFocus={() => {
        onWarm()
        if (compact && !on) onPick()
      }}
      className={`h-11 cursor-pointer outline-none focus-visible:bg-ops-route-soft ${on ? 'bg-ops-route-soft shadow-[inset_3px_0_0_var(--color-ops-route)]' : ''} ${dim}`}
    >
      <td className="font-semibold tabular-nums">{r.no}</td>
      <td>
        <Badge tone={r.look.tone}>{r.look.label}</Badge>
      </td>
      <td className="text-[13px] whitespace-nowrap text-ops-sub tabular-nums">{r.createdAt}</td>
      <Person p={r.sender} />
      {!compact && (
        <td className="truncate text-left" title={r.sender.address}>
          {r.sender.address}
        </td>
      )}
      <Person p={r.receiver} />
      {!compact && (
        <>
          <td className="truncate text-left" title={r.receiver.address}>
            {r.receiver.address}
          </td>
          <td className="truncate text-center text-[13px]" title={r.items}>
            {r.items}
          </td>
          <td className="text-[13px] whitespace-nowrap text-ops-sub tabular-nums">{r.pickupAt}</td>
        </>
      )}
    </tr>
  )
}

/** 주소의 통화 번호(c) → 띄울 통화. 주문 상세는 오른쪽 패널이 받아 둔 것을 같이 씀 (요청 더 없음) */
function OpenCall({
  orderSeq,
  parcelSeq,
  seq,
  onClose,
}: {
  orderSeq: number
  parcelSeq: number | null
  seq: number
  onClose: () => void
}) {
  const call = useWaybill(orderSeq, parcelSeq).view?.calls.find((c) => c.seq === seq)
  return call ? <CallOverlay call={call} onClose={onClose} /> : null
}

function Person({ p }: { p: { name: string; phone: string } }) {
  return (
    <td>
      <span
        className="flex min-w-0 items-baseline justify-center gap-2"
        title={[p.name, p.phone].filter(Boolean).join(' ')}
      >
        <span className="max-w-[5.5em] shrink-0 truncate font-medium">{p.name}</span>
        <span className="truncate text-[13px] whitespace-nowrap text-ops-sub tabular-nums">
          {p.phone}
        </span>
      </span>
    </td>
  )
}
