import { useRef, useState, type AudioHTMLAttributes, type SyntheticEvent } from 'react'
import type { Recording } from '@/shared/call/callApi'

export type PlayerState = 'ok' | 'none' | 'failed' // 재생 가능 · 녹취 없음 · 발급 실패 또는 재생 오류

/** <audio>에 실제로 꽂혀 있는 소리 — 어느 녹취의 어느 URL인지 (재조회로 받은 최신 Recording과 다를 수 있음) */
interface AudioSource {
  recordingSeq: number
  url: string
  expiresAt: string | null
}

/** 다음에 <audio>에 꽂을 소리 (순수 함수, recordingSource.test.ts)
 * 상세를 10초마다 다시 받으면 서명 URL 글자가 매번 바뀜 → 같은 녹취면 쓰던 URL을 그대로 둬야 듣던 소리가 안 끊김 (11/02 연동 명세)
 * 바꾸는 때: 다른 녹취 · 쓰던 URL이 만료됐거나 재생 오류가 나서(needFresh) 새 URL이 옴. 새 URL이 없으면(발급 실패) 쓰던 걸 유지 */
export function pickSource(
  prev: AudioSource | null,
  rec: Recording | null,
  needFresh: boolean,
): AudioSource | null {
  if (!rec) return null
  const same = prev !== null && prev.recordingSeq === rec.recordingSeq
  if (same && (prev.url === rec.url || !needFresh)) return prev
  if (!rec.url) return same ? prev : null
  return { recordingSeq: rec.recordingSeq, url: rec.url, expiresAt: rec.expiresAt }
}

type Resume = { at: number; play: boolean }

/** 녹취 재생 (06 왼쪽 ▶ · 진행 바, 11/01 배속 뺌) — <audio>는 CallScript가 그리고, 여기는 상태 · 조작만
 * 서명 URL은 최대 5분(명세 §5.3): 만료 뒤 재생을 누르면 onExpired(상세 재조회) → 새 URL이 오면 듣던 위치에서 이어 감
 * 재생 오류도 상세를 다시 받아 새 URL로 바꾸고 같은 위치부터 */
export function useRecordingPlayer(recording: Recording | null, onExpired: () => void) {
  const ref = useRef<HTMLAudioElement>(null)
  const [source, setSource] = useState<AudioSource | null>(null)
  const [needFresh, setNeedFresh] = useState(false) // 쓰던 URL이 만료 · 오류 → 다음에 오는 새 URL로 바꿈
  const [resume, setResume] = useState<Resume | null>(null) // 새 소리가 준비되면 이 위치로 (play면 이어서 재생)
  const [playing, setPlaying] = useState(false)
  const [now, setNow] = useState(0)
  const [length, setLength] = useState(0)
  const [failed, setFailed] = useState(false)
  const [volume, setVolumeState] = useState(1) // 0 ~ 1 (<audio> 기본 1)
  const [muted, setMuted] = useState(false)
  const errorFetchAt = useRef(0) // 재생 오류로 다시 받은 때 — 파일이 정말 없으면 오류 → 재조회가 끝없이 돌지 않게 10초에 한 번까지

  // 최신 Recording(재조회마다 옴)을 <audio> 소리로 — 렌더 중에 바꿈(React 문서 '이전 렌더 정보 저장' 방식, effect로 하면 한 박자 늦고 린트가 막음)
  const next = pickSource(source, recording, needFresh)
  if (next !== source) {
    if (!next || !source || next.recordingSeq !== source.recordingSeq) {
      // 다른 녹취(또는 없음): 이전 파일의 재생 상태를 넘기지 않음
      setResume(null)
      setNow(0)
      setLength(0)
    }
    setSource(next)
    setNeedFresh(false)
    setFailed(false)
  }

  const url = source?.url ?? null
  const state: PlayerState = !recording ? 'none' : !url || failed ? 'failed' : 'ok'
  const expired = () => !!source?.expiresAt && Date.parse(source.expiresAt) <= Date.now()
  /** 쓰던 URL로는 더는 못 들음 → 이 위치를 기억하고 새 URL을 받음 */
  const refresh = (at: number, play: boolean) => {
    setResume({ at, play })
    setNeedFresh(true)
    onExpired()
  }

  /** 그 시각(초)부터 재생 — URL이 만료됐거나 아직 메타데이터 전이면 받은 뒤 이어서 */
  const seek = (sec: number) => {
    const a = ref.current
    if (!a || state !== 'ok') return
    if (expired()) return refresh(sec, true)
    if (a.readyState < 1) {
      setResume({ at: sec, play: true })
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
    if (expired()) return refresh(sec, playing)
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
    if (expired()) return refresh(a.currentTime, true)
    void a.play().catch(() => setFailed(true))
  }

  /** 음량 막대 (11/05 새 디자인) — 0으로 끌면 음소거 아이콘, 다시 올리면 소리 */
  const setVolume = (v: number) => {
    const a = ref.current
    if (!a) return
    a.volume = Math.max(0, Math.min(1, v))
    a.muted = v === 0
  }
  /** 스피커 아이콘 — 음소거 켜고 끄기 (끌 때 음량이 0이었으면 반쯤으로) */
  const toggleMute = () => {
    const a = ref.current
    if (!a) return
    if (a.muted && a.volume === 0) a.volume = 0.5
    a.muted = !a.muted
  }

  const handlers: AudioHTMLAttributes<HTMLAudioElement> = {
    onVolumeChange: (e: SyntheticEvent<HTMLAudioElement>) => {
      setVolumeState(e.currentTarget.volume)
      setMuted(e.currentTarget.muted)
    },
    onPlay: () => setPlaying(true),
    onPause: () => setPlaying(false),
    onEnded: () => setPlaying(false),
    onTimeUpdate: (e: SyntheticEvent<HTMLAudioElement>) => setNow(e.currentTarget.currentTime),
    onLoadedMetadata: (e: SyntheticEvent<HTMLAudioElement>) => {
      const a = e.currentTarget
      setLength(Number.isFinite(a.duration) ? a.duration : 0)
      setFailed(false)
      if (resume) {
        setResume(null)
        a.currentTime = resume.at
        setNow(resume.at)
        if (resume.play) void a.play().catch(() => setFailed(true))
      }
    },
    // 재생 오류(만료된 서명 URL · S3 403 등): 오류 표시 + 상세를 다시 받아 새 URL이 오면 같은 위치 · 재생 여부로 (명세). 403을 '파일 없음'으로 단정하지 않음
    onError: (e: SyntheticEvent<HTMLAudioElement>) => {
      setFailed(true)
      setResume({ at: e.currentTarget.currentTime, play: playing })
      setNeedFresh(true)
      if (Date.now() - errorFetchAt.current > 10_000) {
        errorFetchAt.current = Date.now()
        onExpired()
      }
    },
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
    volume: muted ? 0 : volume, // 막대에 보이는 음량 (음소거면 0)
    muted: muted || volume === 0,
    setVolume,
    toggleMute,
    audioRef: ref,
    src: url ?? undefined,
    handlers,
  }
}
