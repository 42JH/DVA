import { useEffect, useRef } from 'react'
import type { ScriptLine, ScriptSegment } from '@/features/call/hooks/useCallDetail'

// 06 대본 (11/05 새 디자인) — 줄 = 화자(AI 파랑 · 고객 회색) | 말 | 통화 안 시각(오른쪽). 이 목록만 스크롤
// 하이라이트(focusKey): 재생 중인 말 또는 AI 동작 · 이전 · 다음으로 고른 말 = 옅은 하늘색 줄. jump가 바뀌면 그 줄로 스크롤 (11/01)
// 시각을 아는 줄은 누를 수 있음 — 그 말부터 듣기. 불만 구간은 옅은 빨강으로 묶고 머리에 '불만 · 유형' (10/21)
export function CallScript({
  className = '',
  segments,
  focusKey,
  jump,
  emptyText,
}: {
  className?: string
  segments: ScriptSegment[]
  focusKey: number | null
  jump: { key: number; n: number } | null
  emptyText: string // 말이 없을 때 (받는 중 · 못 받음 · 없음)
}) {
  const list = useRef<HTMLUListElement>(null)
  useEffect(() => {
    if (!jump) return
    list.current
      ?.querySelector(`[data-key="${jump.key}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [jump])
  return (
    <ul
      ref={list}
      aria-label="통화 대본"
      className={`flex min-h-0 [scrollbar-width:thin] [scrollbar-color:var(--color-line)_transparent] flex-col overflow-y-auto pr-3 ${className}`}
    >
      {segments.length === 0 && (
        <li className="py-10 text-center text-body text-muted">{emptyText}</li>
      )}
      {segments.map((seg, si) =>
        seg.complaint ? (
          <li key={si} className="my-1 rounded-xl bg-danger-soft pt-2 pb-1">
            <p className="px-4 text-label font-bold text-danger">불만 · {seg.complaint.label}</p>
            <ul>
              {seg.lines.map((l) => (
                <Line key={l.key} line={l} active={l.key === focusKey} />
              ))}
            </ul>
          </li>
        ) : (
          seg.lines.map((l) => <Line key={l.key} line={l} active={l.key === focusKey} />)
        ),
      )}
    </ul>
  )
}

/** 한 줄 — 화자 · 말 · 시각. 하이라이트 = 옅은 하늘색 바탕 */
function Line({ line, active }: { line: ScriptLine; active: boolean }) {
  const ai = line.who === 'AI'
  const cells = (
    <>
      <span className={`font-bold ${ai ? 'text-brand' : 'text-sub'}`}>{line.who}</span>
      <span className="min-w-0 break-words whitespace-pre-line">{line.text}</span>
      <span className="text-sub tabular-nums">{line.time}</span>
    </>
  )
  const row = `grid w-full grid-cols-[52px_minmax(0,1fr)_auto] items-baseline gap-x-4 rounded-xl px-4 py-3.5 text-left text-strong ${
    active ? 'bg-frame' : ''
  }`
  return (
    <li data-key={line.key}>
      {line.onClick ? (
        <button
          type="button"
          onClick={line.onClick}
          title="이 말부터 듣기"
          aria-current={active || undefined}
          className={`${row} ${active ? '' : 'hover:bg-bg'}`}
        >
          {cells}
        </button>
      ) : (
        <div className={row}>{cells}</div>
      )}
    </li>
  )
}
