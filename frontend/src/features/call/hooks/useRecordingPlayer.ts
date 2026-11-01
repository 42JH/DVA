import { useEffect, useRef, useState, type AudioHTMLAttributes, type SyntheticEvent } from 'react'
import type { Recording } from '@/features/call/api/callApi'

export type PlayerState = 'ok' | 'none' | 'failed' // 재생 가능 · 녹취 없음 · 발급 실패 또는 재생 오류

/** 녹취 재생 (06 왼쪽 ▶ · 진행 바 · 속도) — <audio>는 CallScript가 그리고, 여기는 상태 · 조작만
 * 서명 URL은 최대 5분(명세 §5.3): 만료 뒤 재생을 누르면 onExpired(상세 재조회) → 새 URL이 오면 듣던 위치에서 이어 감 */
export function useRecordingPlayer(
  recording: Recording | null,
  speed: number,
  onExpired: () => void,
) {
  const ref = useRef<HTMLAudioElement>(null)
  const resumeAt = useRef<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [now, setNow] = useState(0)
  const [length, setLength] = useState(0)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (ref.current) ref.current.playbackRate = speed
  }, [speed])

  const url = recording?.url ?? null
  const state: PlayerState = !recording ? 'none' : !url || failed ? 'failed' : 'ok'
  const expired = () => !!recording?.expiresAt && Date.parse(recording.expiresAt) <= Date.now()

  const toggle = () => {
    const a = ref.current
    if (!a || state !== 'ok') return
    if (playing) {
      a.pause()
      return
    }
    if (expired()) {
      resumeAt.current = a.currentTime
      onExpired()
      return
    }
    void a.play().catch(() => setFailed(true))
  }

  const handlers: AudioHTMLAttributes<HTMLAudioElement> = {
    onPlay: () => setPlaying(true),
    onPause: () => setPlaying(false),
    onEnded: () => setPlaying(false),
    onTimeUpdate: (e: SyntheticEvent<HTMLAudioElement>) => setNow(e.currentTarget.currentTime),
    onLoadedMetadata: (e: SyntheticEvent<HTMLAudioElement>) => {
      const a = e.currentTarget
      setLength(Number.isFinite(a.duration) ? a.duration : 0)
      setFailed(false)
      a.playbackRate = speed
      if (resumeAt.current !== null) {
        a.currentTime = resumeAt.current
        resumeAt.current = null
        void a.play().catch(() => setFailed(true))
      }
    },
    onError: () => setFailed(true),
  }

  return {
    state,
    playing,
    now,
    length,
    progress: length > 0 ? Math.min(1, now / length) : 0,
    toggle,
    audioRef: ref,
    src: url ?? undefined,
    handlers,
  }
}
