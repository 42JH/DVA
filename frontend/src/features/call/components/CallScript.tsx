import type { ScriptSegment } from '@/features/call/hooks/useCallDetail'

// 통화 스크립트 카드 (06 왼쪽, 와이어프레임 06_통화상세 10/30) — 제목 + '페르소나 빠른 접수형 v6' / 재생 바 + 속도 [1.0x|2.0x|3.0x] / 말 줄
// 말 줄: [AI·고객] 말 ……… 시각. AI 동작(저장 · 검색 · 전송)은 오른쪽 '처리 내용'의 AI 동작 기록으로 (10/30 'AI 동작 표시' 토글 없음)
// 불만 구간: 옅은 빨강 바탕 + 빨간 선으로 묶고 머리에 '불만 · 유형' (10/21). 카드 안에서만 스크롤
export function CallScript<S extends string>({
  className = '',
  persona,
  player,
  speeds,
  speed,
  onSpeed,
  segments,
}: {
  className?: string
  persona: string
  player: { now: string; length: string }
  speeds: readonly S[]
  speed: S
  onSpeed: (s: S) => void
  segments: ScriptSegment[]
}) {
  return (
    <section
      className={`flex min-h-0 flex-col rounded-xl bg-surface p-8 ring-1 ring-line ring-inset ${className}`}
    >
      <div className="flex h-10 items-baseline gap-4">
        <h2 className="text-card font-bold">통화 스크립트</h2>
        <span className="text-label text-sub">페르소나</span>
        <span className="-ml-2 text-label font-bold">{persona}</span>
      </div>

      {/* 재생: ▶ + 진행 바 / 아래 왼쪽 시간, 오른쪽 속도. ponytail: 녹취 재생은 명세가 정해지면 — 지금은 자리 · 속도 고르기만 */}
      <div className="mt-[18px]">
        <div className="flex items-center gap-4">
          <button
            type="button"
            aria-label="재생"
            className="grid size-10 shrink-0 place-items-center rounded-full bg-action text-white"
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
          {/* 속도 = 붙은 칸 세 개 (고른 칸 = 남색 선 + 옅은 남색 바탕) */}
          <span className="flex" role="radiogroup" aria-label="재생 속도">
            {speeds.map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={s === speed}
                onClick={() => onSpeed(s)}
                className={`-ml-px h-8 px-3 first:ml-0 first:rounded-l-md last:rounded-r-md ${
                  s === speed
                    ? 'relative z-10 bg-action-soft font-semibold text-action ring-1 ring-action ring-inset'
                    : 'text-sub ring-1 ring-line ring-inset hover:bg-bg'
                }`}
              >
                {s}
              </button>
            ))}
          </span>
        </div>
      </div>

      <div className="mt-[18px] border-t border-line" />

      {/* 줄: 화자 칸 64 · 글자 · 시각 오른쪽 끝. 카드 안에서만 스크롤 */}
      <ul className="mt-2.5 flex min-h-0 flex-1 flex-col overflow-y-auto">
        {segments.length === 0 && (
          <li className="py-10 text-center text-body text-muted">발화가 없습니다.</li>
        )}
        {segments.map((seg, si) =>
          seg.complaint ? (
            <li
              key={si}
              className="my-2 rounded-lg bg-danger-soft py-1 ring-1 ring-danger/40 ring-inset"
            >
              <p className="h-7 px-2.5 text-caption leading-7 font-bold text-danger">
                불만 · {seg.complaint.kind}
              </p>
              <ul>
                {seg.lines.map((l) => (
                  <Line key={l.key} line={l} />
                ))}
              </ul>
            </li>
          ) : (
            <li key={si}>
              <ul>
                {seg.lines.map((l) => (
                  <Line key={l.key} line={l} />
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
