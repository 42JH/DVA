// v2 통화 (11/06 실험) — 운영팀이 통화 내역을 훑고 문제 통화(불만 · 미분석)를 찾는 표. 줄을 누르면 통화 상세
import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { Link, useLocation } from 'react-router'
import { PageHead } from '@/v2/V2Layout'
import { Badge, Kinds, Segments } from '@/v2/ui'
import { ListFrame, SearchBox } from '@/v2/ui/ListFrame'
import { RANGES } from '@/v2/lib/range'
import { useCalls, type CallRowV2 } from './useCalls'

const COLS = [
  { label: '번호', className: 'w-[84px]' },
  { label: '상태', className: 'w-[80px]' },
  { label: '시작', className: 'w-[140px]' },
  { label: '고객', className: 'w-[150px]' },
  { label: '기업', className: 'w-[180px] max-[1600px]:hidden' }, // 1600 아래에선 숨김 (통화 상세에 있음)
  { label: '전화번호', className: 'w-[130px]' },
  { label: '접수 주문', className: 'w-[110px]' },
  { label: '고객 용건', className: '', half: true }, // 고객 용건 · 불만은 늘 같은 폭(반반)
  { label: '불만', className: '', half: true },
  { label: '통화 시간', className: 'w-[90px] max-[1600px]:hidden' },
]

export function CallsPage() {
  const vm = useCalls()
  const from = useLocation().search
  const table = useRef<HTMLTableElement>(null)
  const minWidth = useHalfColumns(table, vm.rows)
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
        <div className="flex items-center justify-end">
          <Segments label="기간" value={vm.range} items={RANGES} onPick={vm.setRange} />
        </div>
        <ListFrame
          list={vm.list}
          unit="통화"
          empty={
            vm.q
              ? '검색어에 맞는 통화가 없습니다. 기간을 넓혀 보세요.'
              : '이 기간에 통화가 없습니다.'
          }
        >
          {/* 칩은 늘 모두 보이게 — 칩이 반 칸보다 길면 두 칸을 똑같이 넓히고, 화면보다 넓으면 표 안에서 가로 스크롤 */}
          <table ref={table} className="ops-table" style={{ minWidth }}>
            <thead>
              <tr>
                {COLS.map((c) => (
                  <th
                    key={c.label}
                    scope="col"
                    data-half={c.half || undefined}
                    className={`${c.className} font-semibold`}
                  >
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {vm.rows.map((r) => (
                <Row key={r.seq} r={r} from={`/v2/calls${from}`} onWarm={() => vm.warm(r.seq)} />
              ))}
            </tbody>
          </table>
        </ListFrame>
      </section>
    </>
  )
}

/** 고객 용건 · 불만을 반반으로 — 둘 다 폭을 안 정해 남는 자리를 똑같이 나눔(table-layout fixed).
 *  한 줄이라도 칩이 반 칸에 안 들어가면, 그 칩 줄이 들어갈 만큼 표 최소 너비를 늘림 → 두 칸이 똑같이 넓어지고 가로 스크롤 */
function useHalfColumns(ref: RefObject<HTMLTableElement | null>, rows: unknown) {
  const [px, setPx] = useState(1120)
  useLayoutEffect(() => {
    const t = ref.current
    if (!t) return
    const measure = () => {
      const fixed = [...t.querySelectorAll<HTMLElement>('thead th')]
        .filter((th) => !th.dataset.half && th.offsetWidth > 0) // 숨긴 칸(1600 아래 기업 · 통화 시간)은 0
        .reduce((sum, th) => sum + th.offsetWidth, 0)
      let need = 0
      t.querySelectorAll<HTMLElement>('[data-chips]').forEach((el) => {
        need = Math.max(need, el.scrollWidth)
      })
      setPx(Math.max(1120, fixed + 2 * (need + 32))) // 32 = 칸 안 여백(좌우 15) + 테두리
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(t.parentElement ?? t)
    return () => ro.disconnect()
  }, [ref, rows])
  return px
}

function Row({ r, from, onWarm }: { r: CallRowV2; from: string; onWarm: () => void }) {
  const to = `/v2/calls/${r.seq}`
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
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-medium">{r.name}</span>
          {r.isNew && (
            <span className="shrink-0 rounded bg-ops-route-soft px-1 text-[11px] font-semibold text-ops-route">
              신규
            </span>
          )}
        </span>,
      )}
      {cell(
        <span className="truncate text-[13px]">{r.company}</span>,
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
        <span data-chips className="flex gap-1 whitespace-nowrap">
          <Kinds kinds={r.kinds} />
        </span>,
        false,
        'left',
      )}
      {cell(
        <span data-chips className="flex gap-1 whitespace-nowrap">
          {r.complaints.map((c) => (
            <span key={c.key} title={c.title}>
              <Badge tone="stop">{c.label}</Badge>
            </span>
          ))}
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
