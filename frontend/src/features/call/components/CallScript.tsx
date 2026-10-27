import { Switch, Tag } from '@/shared/ui'
import type { ScriptSegment } from '@/features/call/hooks/useCallDetail'

// 통화 스크립트 카드 (06 왼쪽) — 제목 + 'AI 동작 표시' 토글 / 재생 바 / 줄 형식 스크립트
// 말 줄: [AI·고객] 말 ……… 시각.  AI 동작 줄: [저장] 태그는 회색 줄 밖 왼쪽, 줄 안에 내용 · 시각만 (상자 속 상자 금지 10/14)
// 불만 구간: 옅은 빨강 바탕 + 빨간 선으로 묶고 머리에 '불만 · 유형' (10/21). 말풍선 · 근거 메모는 쓰지 않음
export function CallScript({
  className = '',
  showActions,
  onToggleActions,
  player,
  segments,
}: {
  className?: string
  showActions: boolean
  onToggleActions: (on: boolean) => void
  player: { now: string; length: string; hasRecording: boolean }
  segments: ScriptSegment[]
}) {
  return (
    <section
      className={`flex flex-col rounded-xl bg-surface p-8 ring-1 ring-line ring-inset ${className}`}
    >
      <div className="flex h-10 items-center justify-between">
        <h2 className="text-card font-bold">통화 스크립트</h2>
        <Switch on={showActions} onChange={onToggleActions} label="AI 동작 표시" />
      </div>

      {/* 재생: ▶ + 진행 바 / 아래 왼쪽 시간, 오른쪽 속도. ponytail: 녹취 재생(CALL-10)은 통합 때 — 지금은 자리만 */}
      <div className="mt-[18px]">
        <div className="flex items-center gap-4">
          <button
            type="button"
            disabled={!player.hasRecording}
            title={player.hasRecording ? '재생' : '녹취 없음'}
            aria-label="재생"
            className="grid size-10 shrink-0 place-items-center rounded-full bg-action text-white disabled:bg-bg disabled:text-muted"
          >
            <svg viewBox="0 0 20 20" className="ml-0.5 size-4" fill="currentColor" aria-hidden>
              <path d="M6 4l10 6-10 6z" />
            </svg>
          </button>
          <div className="relative h-1.5 flex-1 rounded-full bg-line">
            <span className="absolute top-1/2 left-0 size-[18px] -translate-y-1/2 rounded-full bg-surface ring-2 ring-action ring-inset" />
          </div>
        </div>
        <div className="mt-2 flex items-center justify-between pl-14 text-label">
          <span className="text-sub">
            {player.now} / {player.length}
          </span>
          <span className="flex gap-5 text-sub">
            {['1.0x', '2.0x', '3.0x'].map((s, i) => (
              <span
                key={s}
                className={`flex items-center gap-2 ${i === 0 ? 'font-semibold text-ink' : ''}`}
              >
                <span
                  className={`grid size-[18px] place-items-center rounded-full bg-surface ring-[1.5px] ring-inset ${i === 0 ? 'ring-action' : 'ring-muted'}`}
                >
                  {i === 0 && <span className="size-[9px] rounded-full bg-action" />}
                </span>
                {s}
              </span>
            ))}
          </span>
        </div>
      </div>

      <div className="mt-[18px] border-t border-line" />

      {/* 줄: 화자 칸 64 · 글자 · 시각 오른쪽 끝. 카드 안에서만 스크롤 (오른쪽 카드 높이까지 늘어나고, 560을 넘으면 스크롤) */}
      <ul className="mt-2.5 flex max-h-[560px] min-h-0 flex-1 flex-col overflow-y-auto">
        {segments.length === 0 && (
          <li className="py-10 text-center text-body text-muted">발화가 없습니다.</li>
        )}
        {segments.map((seg, si) =>
          seg.complaint ? (
            <li
              key={si}
              className="my-2 rounded-lg bg-danger-soft px-0 py-1 ring-1 ring-danger/40 ring-inset"
            >
              <p className="h-7 px-2.5 text-caption leading-7 font-bold text-danger">
                불만 · {seg.complaint.kind}
              </p>
              <ul>
                {seg.lines.map((l) => (
                  <Line key={l.order} line={l} />
                ))}
              </ul>
            </li>
          ) : (
            <li key={si}>
              <ul>
                {seg.lines.map((l) => (
                  <Line key={l.order} line={l} />
                ))}
              </ul>
            </li>
          ),
        )}
      </ul>
    </section>
  )
}

function Line({ line }: { line: ScriptSegment['lines'][number] }) {
  if (line.isAction) {
    return (
      <li className="flex items-center py-1">
        <span className="w-16 shrink-0">
          <Tag kind="gray">{line.who}</Tag>
        </span>
        <span className="flex min-h-[34px] min-w-0 flex-1 items-center justify-between gap-4 rounded-md bg-bg px-3 py-1.5 text-caption">
          <span className="break-all text-sub">{line.text}</span>
          <span className="shrink-0 text-muted">{line.time}</span>
        </span>
      </li>
    )
  }
  return (
    <li className="flex items-start py-2">
      <span
        className={`w-16 shrink-0 pl-2.5 text-caption leading-[28px] ${line.who === 'AI' ? 'font-bold text-action' : 'font-semibold text-sub'}`}
      >
        {line.who}
      </span>
      <span className="min-w-0 flex-1 pl-3 text-body">{line.text}</span>
      <span className="shrink-0 pr-3 pl-4 text-caption leading-[28px] text-muted">{line.time}</span>
    </li>
  )
}
