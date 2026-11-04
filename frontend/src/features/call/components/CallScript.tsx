import { useEffect, useRef, type AudioHTMLAttributes, type RefObject } from 'react'
import type { ScriptLine, ScriptSegment } from '@/features/call/hooks/useCallDetail'
import type { PlayerState } from '@/features/call/hooks/useRecordingPlayer'

// 통화 스크립트 (06 왼쪽, 11/05 새 디자인) — 제목 / 녹취 재생 줄 / 말풍선 (Figma 'chat-log' 11/04: AI 왼쪽 회색 · 고객 오른쪽 파랑, 모서리 16 · 말하는 쪽 아래 4)
// 말풍선 아래 작은 글 'AI · 00:31'. AI 동작(저장 · 검색 · 전송)은 오른쪽 '처리 내용'의 AI 동작으로 (10/30)
// 불만 구간: 옅은 빨강 바탕으로 묶고 머리에 '불만 · 유형' (10/21). 말풍선 목록만 스크롤
// 녹취: 서명 URL을 <audio>로 (명세 §5.3). 없거나 발급 실패면 ▶를 끄고 한 줄로 알림
// 짚는 말(focusKey): 재생 중인 말 또는 오른쪽 AI 동작을 눌러 고른 말 = 파랑 테두리. jump가 바뀌면 그 말로 스크롤 (11/01)
// 시각을 아는 말은 누를 수 있음 — 그 말부터 듣기
export function CallScript({
  className = '',
  player,
  audioRef,
  segments,
  focusKey,
  jump,
  emptyText,
}: {
  className?: string
  player: {
    state: PlayerState
    playing: boolean
    now: string
    length: string
    progress: number // 0 ~ 1
    toggle: () => void
    scrub: (ratio: number) => void // 진행 바를 끌어 위치 옮김
    src?: string
    handlers: AudioHTMLAttributes<HTMLAudioElement>
    text: string | null // 녹취 상태 한 줄 (없으면 '지금 / 길이')
  }
  audioRef: RefObject<HTMLAudioElement | null>
  segments: ScriptSegment[]
  focusKey: number | null
  jump: { key: number; n: number } | null
  emptyText: string // 말이 없을 때 (받는 중 · 못 받음 · 없음)
}) {
  const canPlay = player.state === 'ok'
  const list = useRef<HTMLUListElement>(null)
  useEffect(() => {
    if (!jump) return
    list.current
      ?.querySelector(`[data-key="${jump.key}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [jump])
  return (
    <section className={`flex min-h-0 flex-col ${className}`}>
      <h2 className="shrink-0 text-card font-semibold">통화 스크립트</h2>

      {/* 재생: ▶ + 진행 바(파랑) + 지금 / 길이. 녹취가 없거나 못 받으면 그 한 줄 */}
      <audio ref={audioRef} src={player.src} preload="metadata" {...player.handlers} />
      <div className="mt-3 flex shrink-0 items-center gap-4">
        <button
          type="button"
          aria-label={player.playing ? '일시정지' : '재생'}
          disabled={!canPlay}
          onClick={player.toggle}
          className="grid size-9 shrink-0 place-items-center rounded-full bg-brand text-white disabled:bg-line disabled:text-muted"
        >
          {player.playing ? (
            <svg viewBox="0 0 20 20" className="size-4" fill="currentColor" aria-hidden>
              <path d="M5 4h4v12H5zM11 4h4v12h-4z" />
            </svg>
          ) : (
            <svg viewBox="0 0 20 20" className="ml-0.5 size-4" fill="currentColor" aria-hidden>
              <path d="M6 4l10 6-10 6z" />
            </svg>
          )}
        </button>
        {/* 진행 바: 그림은 두 span, 조작은 그 위에 투명한 range (드래그 · 클릭 · 방향키, 11/01) */}
        <div className="relative h-1.5 flex-1 rounded-full bg-line">
          <span
            className="absolute inset-y-0 left-0 rounded-full bg-brand"
            style={{ width: `${player.progress * 100}%` }}
          />
          <span
            className="absolute top-1/2 size-[18px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-surface ring-2 ring-brand ring-inset"
            style={{ left: `${player.progress * 100}%` }}
          />
          <input
            type="range"
            min={0}
            max={1000}
            value={Math.round(player.progress * 1000)}
            onChange={(e) => player.scrub(Number(e.target.value) / 1000)}
            disabled={!canPlay}
            aria-label="재생 위치"
            className="absolute inset-x-0 top-1/2 h-6 w-full -translate-y-1/2 cursor-pointer opacity-0 disabled:cursor-default"
          />
        </div>
        {!player.text && (
          <span className="shrink-0 text-label text-sub tabular-nums">
            {player.now} / {player.length}
          </span>
        )}
      </div>
      {player.text && <p className="mt-1.5 shrink-0 pl-13 text-label text-muted">{player.text}</p>}

      <ul
        ref={list}
        className="mt-4 flex min-h-0 flex-1 [scrollbar-width:thin] [scrollbar-color:var(--color-line)_transparent] flex-col gap-4 overflow-y-auto pt-1 pr-3 pb-4"
      >
        {segments.length === 0 && (
          <li className="py-10 text-center text-body text-muted">{emptyText}</li>
        )}
        {segments.map((seg, si) =>
          seg.complaint ? (
            <li key={si} className="rounded-2xl bg-danger-soft px-4 pt-3 pb-4">
              <p className="text-label font-bold text-danger">불만 · {seg.complaint.label}</p>
              <ul className="mt-2 flex flex-col gap-4">
                {seg.lines.map((l) => (
                  <Bubble key={l.key} line={l} active={l.key === focusKey} tinted />
                ))}
              </ul>
            </li>
          ) : (
            seg.lines.map((l) => <Bubble key={l.key} line={l} active={l.key === focusKey} />)
          ),
        )}
      </ul>
    </section>
  )
}

/** 말풍선 하나 — AI 왼쪽 회색(빨간 묶음 안에선 흰색) · 고객 오른쪽 파랑. 짚은 말은 파랑 테두리 */
function Bubble({ line, active, tinted }: { line: ScriptLine; active: boolean; tinted?: boolean }) {
  const ai = line.who === 'AI'
  const box = `max-w-[85%] rounded-2xl px-4 py-3 text-left text-body break-words whitespace-pre-line ${
    ai
      ? `rounded-bl-sm text-ink ${tinted ? 'bg-surface' : 'bg-bg'}`
      : 'rounded-br-sm bg-brand text-white'
  } ${active ? 'ring-2 ring-brand/60 ring-offset-2' : ''}`
  return (
    <li data-key={line.key} className={`flex flex-col gap-1 ${ai ? 'items-start' : 'items-end'}`}>
      {line.onClick ? (
        <button
          type="button"
          onClick={line.onClick}
          title="이 말부터 듣기"
          className={`${box} ${ai ? 'hover:bg-line' : 'hover:bg-brand/85'}`}
        >
          {line.text}
        </button>
      ) : (
        <div className={box}>{line.text}</div>
      )}
      <span className="px-1 text-caption text-muted tabular-nums">
        {line.who}
        {line.time && ` · ${line.time}`}
      </span>
    </li>
  )
}
