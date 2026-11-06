import { useRef, type ReactNode } from 'react'
import { useExitGhost } from '@/shared/lib/useExitGhost'
import { Checkbox } from './Checkbox'

// 목록 표 — 03 · 04 · 05 · 08 · 09 · 10 공통 (와이어프레임 build_calls.table)
// 카드(흰 바탕 · 선 · 모서리 12 · 안쪽 32) 안에: 머리줄(18/600 회색) → 구분선 → 줄들 → 페이지 번호(바깥에서 children으로)
// 줄: 높이는 내용에 맞춤(최소 66 — 고객 두 줄 칸) · 호버 = 옅은 바탕 + 이름 남색 · 선택 = 옅은 남색 바탕
// 줄 끝 › · ▾ 없음 (10/29 목록 줄 끝 꺽쇠 뺌 · 10/30 09 펼침 꺽쇠 뺌) — 누를 수 있는 줄은 호버 바탕과 손가락 커서로 보임
// 선택 · 호버 줄 위의 태그는 Tag onTinted로 흰 바탕 (줄 바탕과 겹쳐 사라지지 않게)

// 열 정렬 규칙 (11/02 사용자) — 글은 왼쪽, 숫자 · 시간은 오른쪽, 알약 열은 고정 폭 상자(96) 안에서 가운데(머리글도 그 상자 가운데). 열 사이 간격은 pr-4 하나
const ALIGN = { left: 'pr-4', right: 'pr-4 text-right' } as const

export interface Column<Row> {
  key: string
  header: string
  width?: number | string // px(좁은 창에선 3/4로 줄어듦 — global.css --col-scale) 또는 글자('170px' 안 줄임 · '1fr'). 마지막 열은 보통 나머지
  align?: 'left' | 'right'
  pill?: boolean // 셀이 고정 폭 알약(<Tag fixed>, 96)인 열 — 폭은 COL.status(112 = 96 + 16), 머리글은 알약 상자 가운데
  cell: (row: Row, ctx: { tinted: boolean }) => ReactNode
}

export function Table<Row>({
  columns,
  rows,
  rowKey,
  onRowClick,
  canClick,
  selectable,
  selected,
  onSelect,
  onSelectAll,
  subRows,
  expanded,
  head,
  empty = '내역이 없습니다.',
  loading,
  footer,
  big,
}: {
  columns: Column<Row>[]
  rows: Row[]
  rowKey: (row: Row) => string | number
  onRowClick?: (row: Row) => void // 있으면 호버 + 손가락 커서
  canClick?: (row: Row) => boolean // 줄마다 누를 수 있는지 (03 '접수 중'은 안 열림). 없으면 전부
  selectable?: boolean // 맨 앞 체크박스 열
  selected?: Set<string | number>
  onSelect?: (key: string | number) => void
  onSelectAll?: () => void // 없으면 머리줄에 전체 선택 체크박스를 안 그림 (09: 실수로 전부 지우는 일 방지)
  subRows?: (row: Row, ctx: { tinted: boolean; gridCols: string }) => ReactNode // 05 질문 줄들 · 09 답변 띠 (같은 열 자리에 맞추도록 gridCols를 줌)
  expanded?: (row: Row) => boolean // 펼치는 목록(09): 펼친 줄은 옅은 바탕
  head?: ReactNode // 카드 제목 줄 (08 · 09: '기업 목록 24곳' + 버튼) — 높이 40, 아래 20
  empty?: string
  loading?: boolean
  footer?: ReactNode // 페이지 번호
  // 새 디자인(11/05~ 08 · 10, 03 주문 · 04 통화 목록 말투): 카드 없이 · 열 머리 20/600 · 구분선 · 줄 글자 20 · 파랑 선택
  // 남는 높이를 채우고 줄만 스크롤(열 머리는 위에 붙음, 쪽 번호는 아래 고정) — 부모가 flex 세로로 높이를 줘야 함
  // 좁은 창(1280 미만)에선 글자 16 — 20이면 전화번호 · 날짜가 두 줄로 꺾임 (11/05 반응형)
  big?: boolean
}) {
  // 열 폭은 와이어프레임 값 그대로 = 다음 열까지의 거리(사이 여백 포함) → grid gap 없이 깐다.
  // 폭 없는 열(나머지)은 minmax로 바닥을 둬서 글자가 눌려 잘리지 않게
  const gridCols = [
    selectable ? '44px' : null,
    ...columns.map((c) =>
      typeof c.width === 'number'
        ? `calc(${c.width}px * var(--col-scale))`
        : (c.width ?? 'minmax(120px, 1fr)'),
    ),
  ]
    .filter(Boolean)
    .join(' ')
  const allState = !selected?.size ? 'off' : selected.size === rows.length ? 'on' : 'some'

  return (
    <section
      className={
        big
          ? 'flex min-h-0 flex-1 flex-col'
          : 'rounded-xl bg-surface px-8 pt-8 pb-7 ring-1 ring-line ring-inset'
      }
    >
      {head && (
        <div className={`flex items-center justify-between ${big ? 'mb-5 shrink-0' : 'mb-4 h-9'}`}>
          {head}
        </div>
      )}
      {/* big: 머리 + 줄을 한 스크롤 상자에 — 머리는 위에 붙고(sticky), 스크롤 막대가 생겨도 열 자리가 같음 */}
      <div
        className={
          big
            ? '-mx-4 min-h-0 flex-1 [scrollbar-width:thin] [scrollbar-color:var(--color-line)_transparent] overflow-y-auto px-4'
            : ''
        }
      >
        <div className={big ? 'sticky top-0 z-10 bg-surface' : ''}>
          {/* 머리줄은 높이 24 고정(가운데 = 카드 위 44) + 아래 16 → 구분선이 카드 위 72. 글꼴에 안 흔들리게 */}
          <div
            className={`mb-4 grid items-center font-semibold ${big ? 'h-7 text-body text-ink xl:text-card' : 'h-6 text-label text-sub'}`}
            style={{ gridTemplateColumns: gridCols }}
          >
            {selectable &&
              (onSelectAll ? (
                <Checkbox state={allState} onChange={onSelectAll} label="전체 선택" brand={big} />
              ) : (
                <span />
              ))}
            {columns.map((c) => (
              <span
                key={c.key}
                className={`${ALIGN[c.align ?? 'left']} ${c.pill ? 'text-center' : ''}`}
              >
                {c.header}
              </span>
            ))}
          </div>
          <div className="border-t border-line" />
        </div>

        {loading ? (
          <p className="py-16 text-center text-body text-muted">불러오는 중…</p>
        ) : rows.length === 0 ? (
          <p className="py-16 text-center text-body text-muted">{empty}</p>
        ) : (
          <ul>
            {rows.map((row, i) => {
              const key = rowKey(row)
              const isSelected = selected?.has(key) ?? false
              const tinted = isSelected // 호버는 CSS(group-hover)라 태그는 선택만 흰 바탕으로
              const isOpen = expanded?.(row) ?? false // 펼친 줄: 옅은 바탕, 아래 모서리는 각지게 → 아래 subRows 띠와 한 덩어리
              const click = canClick?.(row) === false ? undefined : onRowClick
              return (
                <li
                  key={key}
                  className={
                    i < rows.length - 1 ? `border-b ${big ? 'border-bg' : 'border-line'}` : ''
                  }
                >
                  <div
                    onClick={click ? () => click(row) : undefined}
                    // 키보드: Tab으로 줄에 가서 Enter · Space로 열기 (안쪽 체크박스 · [수정]의 키는 줄로 안 번짐)
                    role={click ? 'button' : undefined}
                    tabIndex={click ? 0 : undefined}
                    aria-expanded={click && expanded ? isOpen : undefined}
                    onKeyDown={
                      click
                        ? (e) => {
                            if (e.target !== e.currentTarget) return
                            if (e.key !== 'Enter' && e.key !== ' ') return
                            e.preventDefault() // Space가 화면을 내리지 않게
                            click(row)
                          }
                        : undefined
                    }
                    // 포커스 표시는 바탕색이 아니라 안쪽 선 (선택 · 펼친 줄의 바탕색을 덮지 않게)
                    className={`group -mx-4 grid items-center rounded-lg px-4 outline-none focus-visible:ring-[1.5px] focus-visible:ring-inset ${big ? 'min-h-[72px] text-body focus-visible:ring-brand xl:text-card' : 'min-h-[56px] focus-visible:ring-action'} ${
                      isSelected
                        ? big
                          ? 'bg-brand/10'
                          : 'bg-action-soft'
                        : isOpen
                          ? 'cursor-pointer rounded-b-none bg-bg'
                          : click
                            ? 'cursor-pointer hover:bg-bg'
                            : ''
                    }`}
                    style={{ gridTemplateColumns: gridCols }}
                  >
                    {selectable && (
                      <Checkbox
                        state={isSelected ? 'on' : 'off'}
                        onChange={() => onSelect?.(key)}
                        label="줄 선택"
                        brand={big}
                      />
                    )}
                    {columns.map((c) => (
                      <div key={c.key} className={`min-w-0 ${ALIGN[c.align ?? 'left']}`}>
                        {c.cell(row, { tinted })}
                      </div>
                    ))}
                  </div>
                  {/* 펼침 띠는 내용이 있을 때만 SubRow를 붙이고, 닫히면 떼어 냄 → 퇴장 애니메이션이 돎 */}
                  {(() => {
                    const sub = subRows?.(row, { tinted, gridCols })
                    return sub ? <Fold>{sub}</Fold> : null
                  })()}
                </li>
              )
            })}
          </ul>
        )}
      </div>
      {footer && <div className={big ? 'shrink-0 pt-4' : 'pt-4'}>{footer}</div>}
    </section>
  )
}

const SUB_SWAP = [['motion-safe:animate-expand', 'animate-collapse']] as const
/** 펼침 띠 — 열릴 때 높이가 0 → 내용만큼 자라고(grid 1fr), 닫힐 때 복제본이 접혀 사라짐 (11/01)
 *  표 줄 아래 띠 · 09 FAQ 답변 펼침 · 추가 · 수정 칸이 같이 씀 (11/06 사용자: 눌렀을 때 효과 통일). 조건부로 붙였다 떼면 됨
 *  overflow-y-clip: 세로만 자름 — 띠가 -mx-4 로 좌우로 나오는 건 그대로 */
export function Fold({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useExitGhost(ref, SUB_SWAP, 200)
  return (
    <div ref={ref} className="grid grid-rows-[1fr] motion-safe:animate-expand">
      <div className="min-h-0 overflow-y-clip">{children}</div>
    </div>
  )
}

/** 자주 쓰는 칸: 윗줄 굵게(본문 600) + 아랫줄 회색(18). 고객 · 발신번호, 주문 번호 · 디버 접수번호. 호버 시 윗줄 남색 */
export function TwoLines({
  top,
  bottom,
  topMuted,
}: {
  top: string
  bottom?: string
  topMuted?: boolean
}) {
  return (
    <div className="min-w-0">
      <p
        className={`truncate text-body ${topMuted ? 'text-muted' : 'font-semibold text-ink group-hover:text-action'}`}
      >
        {top}
      </p>
      {bottom !== undefined && (
        <p className={`truncate text-label ${bottom === '—' ? 'text-muted' : 'text-sub'}`}>
          {bottom}
        </p>
      )}
    </div>
  )
}
