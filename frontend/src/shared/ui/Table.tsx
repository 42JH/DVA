import type { ReactNode } from 'react'
import { Checkbox } from './Checkbox'

// 목록 표 — 03 · 04 · 05 · 08 · 09 · 10 공통 (와이어프레임 build_calls.table)
// 카드(흰 바탕 · 선 · 모서리 12 · 안쪽 32) 안에: 머리줄(18/600 회색) → 구분선 → 줄들 → 페이지 번호(바깥에서 children으로)
// 줄: 높이는 내용에 맞춤(최소 66 — 고객 두 줄 칸) · 호버 = 옅은 바탕 + 이름 남색 · 선택 = 옅은 남색 바탕
// 줄 끝 › · ▾ 없음 (10/29 목록 줄 끝 꺽쇠 뺌 · 10/30 09 펼침 꺽쇠 뺌) — 누를 수 있는 줄은 호버 바탕과 손가락 커서로 보임
// 선택 · 호버 줄 위의 태그는 Tag onTinted로 흰 바탕 (줄 바탕과 겹쳐 사라지지 않게)

export interface Column<Row> {
  key: string
  header: string
  width?: number | string // px 또는 '1fr'. 마지막 열은 보통 나머지
  align?: 'left' | 'right'
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
}) {
  // 열 폭은 와이어프레임 값 그대로 = 다음 열까지의 거리(사이 여백 포함) → grid gap 없이 깐다.
  // 폭 없는 열(나머지)은 minmax로 바닥을 둬서 글자가 눌려 잘리지 않게
  const gridCols = [
    selectable ? '44px' : null,
    ...columns.map((c) =>
      typeof c.width === 'number' ? `${c.width}px` : (c.width ?? 'minmax(120px, 1fr)'),
    ),
  ]
    .filter(Boolean)
    .join(' ')
  const allState = !selected?.size ? 'off' : selected.size === rows.length ? 'on' : 'some'

  return (
    <section className="rounded-xl bg-surface px-8 pt-8 pb-7 ring-1 ring-line ring-inset">
      {head && <div className="mb-5 flex h-10 items-center justify-between">{head}</div>}
      {/* 머리줄은 높이 24 고정(가운데 = 카드 위 44) + 아래 16 → 구분선이 카드 위 72. 글꼴에 안 흔들리게 */}
      <div
        className="mb-4 grid h-6 items-center text-label font-semibold text-sub"
        style={{ gridTemplateColumns: gridCols }}
      >
        {selectable &&
          (onSelectAll ? (
            <Checkbox state={allState} onChange={onSelectAll} label="전체 선택" />
          ) : (
            <span />
          ))}
        {columns.map((c) => (
          <span key={c.key} className={`pr-4 ${c.align === 'right' ? 'text-right' : ''}`}>
            {c.header}
          </span>
        ))}
      </div>
      <div className="border-t border-line" />

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
              <li key={key} className={i < rows.length - 1 ? 'border-b border-line' : ''}>
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
                  className={`group -mx-4 grid min-h-[66px] items-center rounded-lg px-4 outline-none focus-visible:ring-[1.5px] focus-visible:ring-action focus-visible:ring-inset ${
                    isSelected
                      ? 'bg-action-soft'
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
                    />
                  )}
                  {columns.map((c) => (
                    <div
                      key={c.key}
                      className={`min-w-0 pr-4 ${c.align === 'right' ? 'text-right' : ''}`}
                    >
                      {c.cell(row, { tinted })}
                    </div>
                  ))}
                </div>
                {subRows?.(row, { tinted, gridCols })}
              </li>
            )
          })}
        </ul>
      )}
      {footer && <div className="pt-4">{footer}</div>}
    </section>
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
