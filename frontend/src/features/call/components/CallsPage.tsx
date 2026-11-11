// 통화 (11/06) — 운영팀이 통화 내역을 훑고 문제 통화(불만 · 미분석)를 찾는 표. 줄을 누르면 통화 상세
import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { Link, useLocation } from 'react-router'
import { PageHead } from '@/shared/ui'
import { Badge, Kinds, Segments, SortTh } from '@/shared/ui'
import { ListFrame, SearchBox } from '@/shared/ui/ListFrame'
import { RANGES } from '@/shared/lib/range'
import { useCalls, type CallsRow } from '../hooks/useCalls'
import { STATE_FILTERS } from '../callState'

const COLS = [
  { label: '번호', className: 'w-[84px]' },
  { label: '상태', className: 'w-[80px]' },
  { label: '시작', className: 'w-[140px]' },
  { label: '고객', className: 'w-[150px]' },
  { label: '구분', className: 'w-[80px] max-[1600px]:hidden' }, // 1600 아래에선 숨김 (통화 상세에 있음)
  { label: '전화번호', className: 'w-[130px]' },
  { label: '접수 주문', className: 'w-[100px]' },
  // 칩 칸 둘은 머리 글 · 칩 모두 왼쪽(칸 안 여백 15 = td와 같게) — 칩 수가 줄마다 달라 왼쪽에 모아야 훑기 쉬움 (11/11 사용자: 정렬 기준)
  { label: '고객 용건', className: 'pl-[15px] text-left!', chips: 'kinds' }, // 남는 자리 전부 (바닥 KINDS_BASE)
  { label: '고객 불만', className: 'pl-[15px] text-left!', chips: 'complaints' }, // 대상 칩 셋이 다 들어가는 폭으로 고정
  { label: '통화 시간', className: 'w-[90px] max-[1600px]:hidden' },
]

export function CallsPage() {
  const vm = useCalls()
  const from = useLocation().search
  const table = useRef<HTMLTableElement>(null)
  const { minWidth, complaintsWidth } = useChipColumns(table, vm.rows)
  return (
    <>
      <PageHead title="통화">
        <SearchBox
          value={vm.q}
          onChange={vm.setQ}
          placeholder="이름, 전화번호로 검색"
          label="통화 검색"
        />
      </PageHead>
      <section aria-label="통화 목록" className="flex min-h-0 flex-1 flex-col gap-3 px-6 pt-4 pb-4">
        <div className="flex flex-wrap items-center gap-3">
          <Segments label="상태" value={vm.state} items={[...STATE_FILTERS]} onPick={vm.setState} />
          {vm.capped && (
            <span className="text-[12px] text-ops-wait">
              통화가 많아 최근 2,000건에서만 찾았습니다. 기간을 줄여 보세요.
            </span>
          )}
          <span className="ml-auto">
            <Segments label="기간" value={vm.range} items={RANGES} onPick={vm.setRange} />
          </span>
        </div>
        <ListFrame
          list={vm.list}
          unit="통화"
          empty={
            vm.q || vm.state
              ? '조건에 맞는 통화가 없습니다. 기간을 넓혀 보세요.'
              : '이 기간에 통화가 없습니다.'
          }
        >
          {/* 칩은 늘 모두 보이게 — 용건 칸은 칩 폭만큼, 불만 칩이 남는 자리보다 길면 표를 넓혀 표 안에서 가로 스크롤 */}
          <table ref={table} className="ops-table" style={{ minWidth }}>
            <thead>
              <tr>
                {COLS.map((c) =>
                  c.label === '시작' ? (
                    <SortTh
                      key={c.label}
                      label={c.label}
                      asc={vm.asc}
                      onToggle={vm.toggleSort}
                      className={`${c.className} font-semibold`}
                    />
                  ) : (
                    <th
                      key={c.label}
                      scope="col"
                      data-chips-col={c.chips}
                      style={c.chips === 'complaints' ? { width: complaintsWidth } : undefined}
                      className={`${c.className} font-semibold`}
                    >
                      {c.label}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {vm.rows.map((r) => (
                <Row key={r.seq} r={r} from={`/calls${from}`} onWarm={() => vm.warm(r.seq)} />
              ))}
            </tbody>
          </table>
        </ListFrame>
      </section>
    </>
  )
}

// 칩이 다 생겼을 때를 바닥으로 — 쪽마다 칩 수에 따라 칸이 줄었다 늘었다 하지 않게 (11/11 사용자: 모든 칩이 생겼을 때 기준)
// 고객 용건: 한 자리 숫자 칩 4개(택배 접수 · 주문 확인 · 접수 취소 · 문의). 고객 불만: 대상 칩 3개(AI 응대 · 요금 정책 · 배송)
const KINDS_BASE = 310
const COMPLAINTS_BASE = 172

/** 고객 불만 칸은 칩 셋 폭으로 고정(더 긴 줄이 있을 때만 늘림), 고객 용건 칸이 남는 자리 전부(table-layout fixed) — 용건이 더 넓음.
 *  용건 칩이 남는 자리(바닥 KINDS_BASE)에 안 들어가면 표 최소 너비를 늘려 가로 스크롤 */
function useChipColumns(ref: RefObject<HTMLTableElement | null>, rows: unknown) {
  const [minWidth, setMinWidth] = useState(1120)
  const [complaintsWidth, setComplaintsWidth] = useState(COMPLAINTS_BASE)
  useLayoutEffect(() => {
    const t = ref.current
    if (!t) return
    const widest = (chips: string) => {
      let need = 0
      t.querySelectorAll<HTMLElement>(`[data-chips="${chips}"]`).forEach((el) => {
        need = Math.max(need, el.scrollWidth)
      })
      return need + 32 // 32 = 칸 안 여백(좌우 15) + 테두리
    }
    const measure = () => {
      const fixed = [...t.querySelectorAll<HTMLElement>('thead th')]
        .filter((th) => !th.dataset.chipsCol && th.offsetWidth > 0) // 숨긴 칸(1600 아래 구분 · 통화 시간)은 0
        .reduce((sum, th) => sum + th.offsetWidth, 0)
      const complaints = Math.max(COMPLAINTS_BASE, widest('complaints'))
      setComplaintsWidth(complaints)
      setMinWidth(Math.max(1120, fixed + Math.max(KINDS_BASE, widest('kinds')) + complaints))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(t.parentElement ?? t)
    return () => ro.disconnect()
  }, [ref, rows])
  return { minWidth, complaintsWidth }
}

function Row({ r, from, onWarm }: { r: CallsRow; from: string; onWarm: () => void }) {
  const to = `/calls/${r.seq}`
  // 줄 전체가 링크처럼 — 칸마다 같은 Link (표 구조 유지 · 키보드는 첫 칸 링크로)
  const cell = (
    child: React.ReactNode,
    first = false,
    align: 'left' | 'center' = 'center',
    extra = '',
  ) => (
    <td className={`${align === 'left' ? 'text-left' : 'text-center'} ${extra}`}>
      <Link
        to={to}
        state={{ from }}
        tabIndex={first ? 0 : -1}
        className={`flex h-11 min-w-0 items-center ${align === 'left' ? 'justify-start' : 'justify-center'} outline-none`}
      >
        {child}
      </Link>
    </td>
  )
  const failed = r.state.label === '분석 실패'
  return (
    <tr
      onMouseEnter={onWarm}
      onFocus={onWarm}
      // 분석 실패 줄은 주문의 미완료 줄처럼 글자를 흐리게
      className={`has-[a:focus-visible]:bg-ops-route-soft ${failed ? 'text-ops-faint' : ''}`}
    >
      {cell(
        <span
          className={`font-semibold whitespace-nowrap tabular-nums ${failed ? '' : 'text-ops-sub'}`}
        >
          #{r.seq}
        </span>,
        true,
      )}
      {cell(<Badge tone={r.state.tone}>{r.state.label}</Badge>)}
      {cell(
        <span className="text-[13px] whitespace-nowrap text-ops-sub tabular-nums">
          {r.startedAt}
        </span>,
      )}
      {cell(
        // 이름만 가운데 — 신규는 흐름 밖(absolute)에 두어 이름 위치를 밀지 않음
        <span className="relative min-w-0">
          <span className="block truncate font-medium">{r.name}</span>
          {r.isNew && (
            <span className="absolute top-1/2 left-full ml-1.5 -translate-y-1/2 rounded bg-ops-route-soft px-1 text-[11px] font-semibold whitespace-nowrap text-ops-route">
              신규
            </span>
          )}
        </span>,
      )}
      {cell(
        <span className="text-[13px] whitespace-nowrap">{r.kind}</span>,
        false,
        'center',
        'max-[1600px]:hidden',
      )}
      {cell(<span className="text-[13px] whitespace-nowrap tabular-nums">{r.phone}</span>)}
      {cell(
        // 주문번호만 — 주문 상태는 주문 화면에서 (통화 목록은 통화 상태만)
        r.order && (
          <span className="text-[13px] font-semibold whitespace-nowrap tabular-nums">
            {r.order.no}
          </span>
        ),
      )}
      {cell(
        <span data-chips="kinds" className="flex gap-1 whitespace-nowrap">
          <Kinds kinds={r.kinds} />
        </span>,
        false,
        'left',
      )}
      {cell(
        <span data-chips="complaints" className="flex gap-1 whitespace-nowrap">
          {r.judging ? (
            <span className="text-[12px] text-ops-faint">판정 전</span>
          ) : (
            r.complaints.map((c) => (
              <span key={c.key} title={c.title}>
                <Badge tone="stop">{c.label}</Badge>
              </span>
            ))
          )}
        </span>,
        false,
        'left',
      )}
      {cell(
        <span className="w-full text-center text-[13px] whitespace-nowrap text-ops-sub tabular-nums">
          {r.duration}
        </span>,
        false,
        'center',
        'max-[1600px]:hidden',
      )}
    </tr>
  )
}
