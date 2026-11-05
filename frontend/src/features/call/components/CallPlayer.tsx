import { useEffect, type AudioHTMLAttributes, type RefObject } from 'react'
import type { PlayerState } from '@/features/call/hooks/useRecordingPlayer'

// 06 녹취 재생 줄 (11/05 새 디자인 맨 아래, 카드 폭 전체 · 위 구분선)
// 왼쪽 '[ 빠른 접수형 ]'(받은 상담가) | 가운데 ⏮ 이전 발화 · ▶ 재생 · ⏭ 다음 발화 + 아래 지금 · 진행 막대 · 길이 | 오른쪽 🔈 음량
// 막대 두 개(진행 · 음량) 같은 모양 (11/05 사용자): 평소 채운 부분 검정 · 손잡이 없음 → 올리면(·키보드 초점) 파랑 + 파랑 동그라미 손잡이
// 스피커를 누르면 음소거(✕ 스피커) · 다시 누르면 소리. 녹취가 없거나 못 들으면 버튼 · 막대를 끄고 그 사정 한 줄
// 방향키 (11/05 사용자): ← 이전 발화 · → 다음 발화 · ↑ 음량 +10% · ↓ 음량 -10% — 글 칸 · 막대(range)에 초점이 있으면 그쪽 동작 그대로
export interface PlayerView {
  state: PlayerState
  playing: boolean
  now: string
  length: string
  progress: number // 0 ~ 1
  toggle: () => void
  scrub: (ratio: number) => void
  prev: () => void // 이전 발화
  next: () => void // 다음 발화
  volume: number // 0 ~ 1 (음소거면 0)
  muted: boolean
  setVolume: (v: number) => void
  toggleMute: () => void
  src?: string
  handlers: AudioHTMLAttributes<HTMLAudioElement>
  text: string | null // 녹취 사정 한 줄 (없으면 null)
}

export function CallPlayer({
  player,
  audioRef,
  persona,
  className = '',
}: {
  player: PlayerView
  audioRef: RefObject<HTMLAudioElement | null>
  persona: string
  className?: string
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
      e.preventDefault() // 목록 · 화면이 같이 스크롤되지 않게
      act()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [player, canPlay])
  const step =
    'grid size-8 place-items-center rounded-full text-sub hover:bg-bg hover:text-ink disabled:text-line disabled:hover:bg-transparent'
  return (
    <div
      className={`grid grid-cols-[minmax(0,1fr)_minmax(0,600px)_minmax(0,1fr)] items-end gap-6 ${className}`}
    >
      <audio ref={audioRef} src={player.src} preload="metadata" {...player.handlers} />
      <span className="mb-0.5 truncate text-body text-sub">{persona && `[ ${persona} ]`}</span>

      <div className="flex min-w-0 flex-col items-center gap-2">
        <div className="flex items-center gap-10">
          {/* 이전 · 다음 발화는 녹취가 없어도 대본 하이라이트를 옮김 */}
          <button type="button" aria-label="이전 발화" onClick={player.prev} className={step}>
            <svg
              viewBox="0 0 20 20"
              className="size-5"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.6}
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M5 4v12M15 4.5v11L7 10z" />
            </svg>
          </button>
          <button
            type="button"
            aria-label={player.playing ? '일시정지' : '재생'}
            disabled={!canPlay}
            onClick={player.toggle}
            className="grid size-12 place-items-center rounded-full bg-brand text-white hover:bg-brand/90 disabled:bg-line disabled:text-muted"
          >
            {player.playing ? (
              <svg viewBox="0 0 20 20" className="size-5" fill="currentColor" aria-hidden>
                <path d="M5 4h3.5v12H5zM11.5 4H15v12h-3.5z" />
              </svg>
            ) : (
              <svg viewBox="0 0 20 20" className="ml-0.5 size-5" fill="currentColor" aria-hidden>
                <path d="M6 3.5l11 6.5-11 6.5z" />
              </svg>
            )}
          </button>
          <button type="button" aria-label="다음 발화" onClick={player.next} className={step}>
            <svg
              viewBox="0 0 20 20"
              className="size-5"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.6}
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M15 4v12M5 4.5v11l8-5.5z" />
            </svg>
          </button>
        </div>
        {player.text ? (
          <p className="h-5 text-label text-muted">{player.text}</p>
        ) : (
          <div className="flex w-full items-center gap-5 text-body text-sub tabular-nums">
            <span className="w-11 shrink-0 text-right">{player.now}</span>
            <Bar
              label="재생 위치"
              value={player.progress}
              onChange={player.scrub}
              disabled={!canPlay}
              className="flex-1"
            />
            <span className="w-11 shrink-0">{player.length}</span>
          </div>
        )}
      </div>

      <div className="mb-0.5 flex items-center justify-end gap-3">
        <button
          type="button"
          aria-label={player.muted ? '소리 켜기' : '음소거'}
          onClick={player.toggleMute}
          disabled={!canPlay}
          className="grid size-8 place-items-center rounded-lg text-ink hover:bg-bg disabled:text-line"
        >
          <svg
            viewBox="0 0 24 24"
            className="size-6"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
            {player.muted ? (
              <path d="M16 9.5l5 5M21 9.5l-5 5" />
            ) : (
              <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />
            )}
          </svg>
        </button>
        <Bar
          label="음량"
          value={player.volume}
          onChange={player.setVolume}
          disabled={!canPlay}
          className="w-[120px]"
        />
      </div>
    </div>
  )
}

/** 막대 (진행 · 음량 같은 모양) — 그림은 span 셋, 조작은 그 위 투명한 range (드래그 · 클릭 · 방향키)
 *  평소: 회색 길 + 검정 채움. 올리거나 키보드 초점: 파랑 채움 + 파랑 동그라미 손잡이 (11/05 사용자 이미지) */
function Bar({
  label,
  value,
  onChange,
  disabled,
  className = '',
}: {
  label: string
  value: number // 0 ~ 1
  onChange: (v: number) => void
  disabled: boolean
  className?: string
}) {
  const pct = `${Math.max(0, Math.min(1, value)) * 100}%`
  return (
    // 꺼져 있으면(녹취 없음) 올려도 파랗게 안 바뀜
    <div className={`relative h-1 rounded-full bg-line ${disabled ? '' : 'group'} ${className}`}>
      <span
        className="absolute inset-y-0 left-0 rounded-full bg-ink group-focus-within:bg-brand group-hover:bg-brand"
        style={{ width: pct }}
      />
      <span
        aria-hidden
        className="absolute top-1/2 hidden size-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand group-focus-within:block group-hover:block"
        style={{ left: pct }}
      />
      <input
        type="range"
        min={0}
        max={1000}
        value={Math.round(value * 1000)}
        onChange={(e) => onChange(Number(e.target.value) / 1000)}
        disabled={disabled}
        aria-label={label}
        className="absolute inset-x-0 top-1/2 h-5 w-full -translate-y-1/2 cursor-pointer opacity-0 disabled:cursor-default"
      />
    </div>
  )
}
