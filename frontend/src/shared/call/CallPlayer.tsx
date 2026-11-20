import { type AudioHTMLAttributes } from 'react'
import type { PlayerState } from './useRecordingPlayer'

// 06 녹취 재생 줄 (새 디자인 맨 아래, 카드 폭 전체 · 위 구분선)
// 왼쪽 '[ 빠른 접수형 ]'(받은 상담가) | 가운데 ⏮ 이전 발화 · ▶ 재생 · ⏭ 다음 발화 + 아래 지금 · 진행 막대 · 길이 | 오른쪽 🔈 음량
// 막대 두 개(진행 · 음량) 같은 모양: 평소 채운 부분 검정 · 손잡이 없음 → 올리면(·키보드 초점) 파랑 + 파랑 동그라미 손잡이
// 스피커를 누르면 음소거(✕ 스피커) · 다시 누르면 소리. 녹취가 없거나 못 들으면 버튼 · 막대를 끄고 그 사정 한 줄
// 방향키: ← 이전 발화 · → 다음 발화 · ↑ 음량 +10% · ↓ 음량 -10% — 글 칸 · 막대(range)에 초점이 있으면 그쪽 동작 그대로
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
  // 진행 막대 위 판정 눈금 (at 0 ~ 1, 빨강 = 고객 불만 · 주황 = AI 응대 오류). 누르면 그 말로
  marks?: { key: number; at: number; tone: 'stop' | 'wait'; title: string; onClick: () => void }[]
}
