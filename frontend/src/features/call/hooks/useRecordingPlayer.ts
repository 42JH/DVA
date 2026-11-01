import { useRef, useState, type AudioHTMLAttributes, type SyntheticEvent } from 'react'
import type { Recording } from '@/features/call/api/callApi'

export type PlayerState = 'ok' | 'none' | 'failed' // 재생 가능 · 녹취 없음 · 발급 실패 또는 재생 오류

/** 녹취 재생 (06 왼쪽 ▶ · 진행 바, 11/01 배속 뺌) — <audio>는 CallScript가 그리고, 여기는 상태 · 조작만
 * 서명 URL은 최대 5분(명세 §5.3): 만료 뒤 재생을 누르면 onExpired(상세 재조회) → 새 URL이 오면 듣던 위치에서 이어 감 */
export function useRecordingPlayer(recording: Recording | null, onExpired: () => void) {
  const ref = useRef<HTMLAudioElement>(null)
  const resumeAt = useRef<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [now, setNow] = useState(0)
  const [length, setLength] = useState(0)
  const [failed, setFailed] = useState(false)

  const url = recording?.url ?? null
  const state: PlayerState = !recording ? 'none' : !url || failed ? 'failed' : 'ok'
  const expired = () => !!recording?.expiresAt && Date.parse(recording.expiresAt) <= Date.now()

  /** 그 시각(초)부터 재생 — URL이 만료됐거나 아직 메타데이터 전이면 받은 뒤 이어서 */
  const seek = (sec: number) => {
    const a = ref.current
    if (!a || state !== 'ok') return
    if (expired()) {
      resumeAt.current = sec
      onExpired()
      return
    }
    if (a.readyState < 1) {
      resumeAt.current = sec
      a.load()
      return
    }
    a.currentTime = sec
    void a.play().catch(() => setFailed(true))
  }

  /** 진행 바 드래그 — 비율(0~1)로 위치만 옮김. 재생 중이면 계속 재생, 멈춰 있으면 멈춘 채 (듣던 상태 유지) */
  const scrub = (ratio: number) => {
    const a = ref.current
    if (!a || state !== 'ok' || !length) return
    const sec = Math.max(0, Math.min(length, ratio * length))
    if (expired()) {
      resumeAt.current = sec
      onExpired()
      return
    }
    a.currentTime = sec
    setNow(sec) // timeupdate가 오기 전에도 손잡이가 바로 따라오게
  }

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
    seek,
    scrub,
    audioRef: ref,
    src: url ?? undefined,
    handlers,
  }
}
