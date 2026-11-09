// 목록 아래 줄 (모든 목록 공통) — 일반 게시판 방식, 쪽 이동은 가운데
//   왼쪽 '1–50 / 526건' | 가운데 « ‹ 1 2 3 … 10 › » | 오른쪽 [50개씩]
import { PAGE_SIZES, pageGroup } from '@/shared/lib/paging'
import { Icon, type IconName } from './controls'

const box =
  'grid size-8 place-items-center rounded-md text-[13px] tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ops-route'

export function Pagination({
  page,
  size,
  total,
  pages: pagesProp,
  unit = '건',
  onPage,
  onSize,
}: {
  page: number
  size: number
  total: number
  pages?: number // 쪽 수를 따로 셀 때 (관리자 활성화: 보이는 수는 나를 빼고, 쪽은 서버 건수로)
  unit?: string // '건', '명', '곳'
  onPage: (p: number) => void
  onSize: (n: number) => void
}) {
  if (total <= 0) return null
  const pages = pagesProp ?? Math.max(1, Math.ceil(total / size))
  const from = (page - 1) * size + 1
  const to = Math.min(page * size, total)
  const move = (label: string, icon: IconName, turn: string, p: number, off: boolean) => (
    <button
      type="button"
      aria-label={label}
      disabled={off}
      onClick={() => onPage(p)}
      className={`${box} text-ops-sub hover:bg-white hover:text-ops-ink disabled:pointer-events-none disabled:opacity-30`}
    >
      <Icon name={icon} className={`size-4 ${turn}`} />
    </button>
  )
  return (
    <div className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-4 text-[13px] text-ops-sub">
      <span className="tabular-nums">
        {from.toLocaleString('ko-KR')}–{to.toLocaleString('ko-KR')} /{' '}
        {total.toLocaleString('ko-KR')}
        {unit}
      </span>
      <nav aria-label="쪽" className="flex items-center gap-0.5">
        {move('첫 쪽', 'chevrons', '', 1, page <= 1)}
        {move('이전 쪽', 'chevron', 'rotate-90', page - 1, page <= 1)}
        <span className="mx-1 flex items-center gap-0.5">
          {pageGroup(page, pages).map((p) => (
            <button
              key={p}
              type="button"
              aria-current={p === page ? 'page' : undefined}
              onClick={() => onPage(p)}
              className={`${box} ${p === page ? 'bg-ops-route font-semibold text-white' : 'text-ops-sub hover:bg-white hover:text-ops-ink'}`}
            >
              {p}
            </button>
          ))}
        </span>
        {move('다음 쪽', 'chevron', '-rotate-90', page + 1, page >= pages)}
        {move('마지막 쪽', 'chevrons', 'rotate-180', pages, page >= pages)}
      </nav>
      <select
        aria-label="한 쪽에 보일 개수"
        value={size}
        // 개수를 바꿔도 보던 첫 줄이 들어 있는 쪽으로
        onChange={(e) => {
          const n = Number(e.target.value)
          onSize(n)
          onPage(Math.floor((from - 1) / n) + 1)
        }}
        className="h-8 justify-self-end rounded-md bg-white px-2 text-[13px] text-ops-ink ring-1 ring-ops-line outline-none ring-inset focus-visible:ring-2 focus-visible:ring-ops-route"
      >
        {PAGE_SIZES.map((n) => (
          <option key={n} value={n}>
            {n}개씩 보기
          </option>
        ))}
      </select>
    </div>
  )
}
