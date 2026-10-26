import type { ReactNode } from 'react'
import { Checkbox } from './Checkbox'

// 목록 표 — 03 · 04 · 05 · 08 · 09 · 10 공통 (와이어프레임 build_calls.table)
// 카드(흰 바탕 · 선 · 모서리 12 · 안쪽 32) 안에: 머리줄(18/600 회색) → 구분선 → 줄들 → 페이지 번호(바깥에서 children으로)
// 줄: 높이는 내용에 맞춤(최소 66 — 고객 두 줄 칸) · 호버 = 옅은 바탕 + 이름 · › 남색 · 선택 = 옅은 남색 바탕
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
  selectable,
  selected,
  onSelect,
  onSelectAll,
  subRows,
  empty = '내역이 없습니다.',
  loading,
  footer,
}: {
  columns: Column<Row>[]
  rows: Row[]
  rowKey: (row: Row) => string | number
  onRowClick?: (row: Row) => void // 있으면 줄 끝 › + 호버
  selectable?: boolean // 맨 앞 체크박스 열
  selected?: Set<string | number>
  onSelect?: (key: string | number) => void
  onSelectAll?: () => void
  subRows?: (row: Row, ctx: { tinted: boolean }) => ReactNode // 05 AI 미답변: 통화 줄 아래 질문 줄들
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
    onRowClick ? '24px' : null,
  ]
    .filter(Boolean)
    .join(' ')
  const allState = !selected?.size ? 'off' : selected.size === rows.length ? 'on' : 'some'

  return (
    <section className="rounded-xl bg-surface px-8 pt-8 pb-7 ring-1 ring-line ring-inset">
      {/* 머리줄은 높이 24 고정(가운데 = 카드 위 44) + 아래 16 → 구분선이 카드 위 72. 글꼴에 안 흔들리게 */}
      <div
        className="mb-4 grid h-6 items-center text-label font-semibold text-sub"
        style={{ gridTemplateColumns: gridCols }}
      >
        {selectable && (
          <Checkbox state={allState} onChange={() => onSelectAll?.()} label="전체 선택" />
        )}
        {columns.map((c) => (
          <span key={c.key} className={`pr-4 ${c.align === 'right' ? 'text-right' : ''}`}>
            {c.header}
          </span>
        ))}
        {onRowClick && <span />}
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
            return (
              <li key={key} className={i < rows.length - 1 ? 'border-b border-line' : ''}>
                <div
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={`group -mx-4 grid min-h-[66px] items-center rounded-lg px-4 ${
                    isSelected ? 'bg-action-soft' : onRowClick ? 'cursor-pointer hover:bg-bg' : ''
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
                  {onRowClick && (
                    <svg
                      viewBox="0 0 20 20"
                      className="size-4 justify-self-end stroke-sub group-hover:stroke-action"
                      fill="none"
                      strokeWidth={1.8}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M8 5l5 5-5 5" />
                    </svg>
                  )}
                </div>
                {subRows?.(row, { tinted })}
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
