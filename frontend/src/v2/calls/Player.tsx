// v2 녹취 재생 줄 — 화면 맨 아래 한 줄: ⏮ ▶ ⏭ · 지금 · 진행 막대 · 길이 · 음량. 막대는 브라우저 range (색만 ops-route)
// 방향키: ← 이전 말 · → 다음 말 · ↑ ↓ 음량 (글 칸 · 막대 · 창 안에서는 그쪽 동작). 상태 · 조작은 기존 useRecordingPlayer 그대로
import { useEffect, type RefObject } from 'react'
import type { PlayerView } from '@/features/call/components/CallPlayer'

export function Player({
  player,
  audioRef,
}: {
  player: PlayerView
  audioRef: RefObject<HTMLAudioElement | null>
}) {
  const canPlay = player.state === 'ok'
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing) return
      const t = e.target as HTMLElement | null
      if (t?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return
      const act = {
        ArrowLeft: player.prev,
        ArrowRight: player.next,
        ArrowUp: () => canPlay && player.setVolume(Math.min(1, player.volume + 0.1)),
        ArrowDown: () => canPlay && player.setVolume(Math.max(0, player.volume - 0.1)),
      }[e.key]
      if (!act) return
      e.preventDefault()
      act()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [player, canPlay])

  const step =
    'grid size-8 place-items-center rounded-md text-ops-sub hover:bg-ops-paper hover:text-ops-ink'
  const range = 'h-1 cursor-pointer accent-ops-route disabled:cursor-default disabled:opacity-40'
  return (
    <div className="flex h-14 shrink-0 items-center gap-3 border-t border-ops-line bg-white px-6">
      <audio ref={audioRef} src={player.src} preload="metadata" {...player.handlers} />
      {/* 이전 · 다음 말은 녹취가 없어도 대화 표시를 옮김 */}
      <button
        type="button"
        aria-label="이전 말"
        title="이전 말 (←)"
        onClick={player.prev}
        className={step}
      >
        <svg viewBox="0 0 20 20" className="size-4" fill="currentColor" aria-hidden>
          <path d="M5 4h1.6v12H5zM16 4.5v11L8 10z" />
        </svg>
      </button>
      <button
        type="button"
        aria-label={player.playing ? '일시정지' : '재생'}
        disabled={!canPlay}
        onClick={player.toggle}
        className="grid size-9 place-items-center rounded-full bg-ops-route text-white hover:bg-[#1a5fcc] disabled:bg-ops-idle-soft disabled:text-ops-faint"
      >
        <svg viewBox="0 0 20 20" className="size-4" fill="currentColor" aria-hidden>
          <path
            d={player.playing ? 'M5 4h3.5v12H5zM11.5 4H15v12h-3.5z' : 'M6.5 3.5l10 6.5-10 6.5z'}
          />
        </svg>
      </button>
      <button
        type="button"
        aria-label="다음 말"
        title="다음 말 (→)"
        onClick={player.next}
        className={step}
      >
        <svg viewBox="0 0 20 20" className="size-4" fill="currentColor" aria-hidden>
          <path d="M15 4h-1.6v12H15zM4 4.5v11l8-5.5z" />
        </svg>
      </button>

      {player.text ? (
        <p className="ml-2 flex-1 text-[13px] text-ops-sub">{player.text}</p>
      ) : (
        <div className="ml-2 flex flex-1 items-center gap-3 text-[12px] text-ops-sub tabular-nums">
          <span className="w-10 text-right">{player.now}</span>
          <input
            type="range"
            min={0}
            max={1000}
            value={Math.round(player.progress * 1000)}
            onChange={(e) => player.scrub(Number(e.target.value) / 1000)}
            disabled={!canPlay}
            aria-label="재생 위치"
            className={`flex-1 ${range}`}
          />
          <span className="w-10">{player.length}</span>
        </div>
      )}

      <button
        type="button"
        aria-label={player.muted ? '소리 켜기' : '음소거'}
        onClick={player.toggleMute}
        disabled={!canPlay}
        className={`${step} ml-3 disabled:opacity-40`}
      >
        <svg
          viewBox="0 0 24 24"
          className="size-[18px]"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
          <path
            d={
              player.muted
                ? 'M16 9.5l5 5M21 9.5l-5 5'
                : 'M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11'
            }
          />
        </svg>
      </button>
      <input
        type="range"
        min={0}
        max={100}
        value={Math.round(player.volume * 100)}
        onChange={(e) => player.setVolume(Number(e.target.value) / 100)}
        disabled={!canPlay}
        aria-label="음량"
        className={`w-24 ${range}`}
      />
    </div>
  )
}
