import { useEffect, useRef, type AudioHTMLAttributes, type RefObject } from 'react'
import type { ScriptSegment } from '@/features/call/hooks/useCallDetail'
import type { PlayerState } from '@/features/call/hooks/useRecordingPlayer'

// 통화 스크립트 카드 (06 왼쪽, 와이어프레임 06_통화상세 10/30) — 제목 + '페르소나 빠른 접수형 v6' / 재생 바 (11/01 배속 뺌) / 말 줄
// 말 줄: [AI·고객] 말 ……… 시각. AI 동작(저장 · 검색 · 전송)은 오른쪽 '처리 내용'의 AI 동작 기록으로 (10/30 'AI 동작 표시' 토글 없음)
// 불만 구간: 옅은 빨강 바탕 + 빨간 선으로 묶고 머리에 '불만 · 유형' (10/21). 카드 안에서만 스크롤
// 녹취: 서명 URL을 <audio>로 (명세 §5.3). 없거나 발급 실패면 ▶를 끄고 한 줄로 알림
// 짚는 줄(focusKey): 재생 중인 말 또는 오른쪽 AI 동작을 눌러 고른 말 = 옅은 남색. jump가 바뀌면 그 줄로 스크롤 (11/01)
const STATE_TEXT: Record<PlayerState, string | null> = {
  ok: null,
  none: '녹취 없음',
  failed: '녹취를 불러오지 못했습니다',
}

export function CallScript({
  className = '',
  persona,
  player,
  audioRef,
  segments,
  focusKey,
  jump,
}: {
  className?: string
  persona: string // '' 이면 표시 안 함 (분석 전 · 페르소나 미기록)
  player: {
    state: PlayerState
    playing: boolean
    now: string
    length: string
    progress: number // 0 ~ 1
    toggle: () => void
    src?: string
    handlers: AudioHTMLAttributes<HTMLAudioElement>
  }
  audioRef: RefObject<HTMLAudioElement | null>
  segments: ScriptSegment[]
  focusKey: number | null
  jump: { key: number; n: number } | null
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
    <section
      className={`flex min-h-0 flex-col rounded-xl bg-surface p-8 ring-1 ring-line ring-inset ${className}`}
    >
      <div className="flex h-10 items-baseline gap-4">
        <h2 className="text-card font-bold">통화 스크립트</h2>
        {persona && (
          <>
            <span className="text-label text-sub">페르소나</span>
            <span className="-ml-2 text-label font-bold">{persona}</span>
          </>
        )}
      </div>

      {/* 재생: ▶ + 진행 바 / 아래 왼쪽 시간, 오른쪽 속도 */}
      <audio ref={audioRef} src={player.src} preload="metadata" {...player.handlers} />
      <div className="mt-[18px]">
        <div className="flex items-center gap-4">
          <button
            type="button"
            aria-label={player.playing ? '일시정지' : '재생'}
            disabled={!canPlay}
            onClick={player.toggle}
            className="grid size-10 shrink-0 place-items-center rounded-full bg-action text-white disabled:bg-line disabled:text-muted"
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
          <div className="relative h-1.5 flex-1 rounded-full bg-line">
            <span
              className="absolute inset-y-0 left-0 rounded-full bg-action"
              style={{ width: `${player.progress * 100}%` }}
            />
            <span
              className="absolute top-1/2 size-[18px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-surface ring-2 ring-action ring-inset"
              style={{ left: `${player.progress * 100}%` }}
            />
          </div>
        </div>
        <div className="mt-2 flex h-8 items-center pl-14 text-label">
          <span className={canPlay ? 'text-sub' : 'text-muted'}>
            {STATE_TEXT[player.state] ?? `${player.now} / ${player.length}`}
          </span>
        </div>
      </div>

      <div className="mt-[18px] border-t border-line" />

      {/* 줄: 화자 칸 64 · 글자 · 시각 오른쪽 끝. 카드 안에서만 스크롤 */}
      <ul ref={list} className="mt-2.5 flex min-h-0 flex-1 flex-col overflow-y-auto">
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
                불만 · {seg.complaint.label}
              </p>
              <ul>
                {seg.lines.map((l) => (
                  <Line key={l.key} line={l} active={l.key === focusKey} />
                ))}
              </ul>
            </li>
          ) : (
            <li key={si}>
              <ul>
                {seg.lines.map((l) => (
                  <Line key={l.key} line={l} active={l.key === focusKey} />
                ))}
              </ul>
            </li>
          ),
        )}
      </ul>
    </section>
  )
}

function Line({ line, active }: { line: ScriptSegment['lines'][number]; active: boolean }) {
  return (
    <li
      data-key={line.key}
      className={`flex items-start rounded-md py-2 ${active ? 'bg-action-soft' : ''}`}
    >
      <span
        className={`w-16 shrink-0 pl-2.5 text-caption leading-[28px] ${line.who === 'AI' ? 'font-bold text-action' : 'font-semibold text-sub'}`}
      >
        {line.who}
      </span>
      <span className="min-w-0 flex-1 pl-3 text-body whitespace-pre-line">{line.text}</span>
      <span className="shrink-0 pr-3 pl-4 text-caption leading-[28px] text-muted">{line.time}</span>
    </li>
  )
}
