import { useEffect, useState } from 'react'
import type { VoiceSettings } from '@/features/persona/api/personaApi'
import { useVoiceOptions } from '@/features/persona/hooks/useVoiceOptions'

const SAMPLE = '받는 분 번호 공일공, 이삼사오, 육칠팔구 맞으실까요?' // 미리 듣기 문장 (와이어프레임 그대로)
// shortcut: 미리 듣기는 브라우저 음성(speechSynthesis)으로 속도만 흉내 — 실제 목소리(marin 등) · 기다리기는 BE TTS 음성 파일로 바꿀 것
const RATE: Record<VoiceSettings['speed'], number> = { SLOW: 0.85, NORMAL: 1, FAST: 1.2 }

/** 음성 세부 조절 창의 값 — 상담가 등록 · 수정 화면 공용 (11/11)
 * 저장 버튼 없이 고르는 즉시 작성 중 값에 반영 → 화면 [저장] · [등록]으로 같이 보냄 */
export function useVoiceDraft(initial: VoiceSettings) {
  const options = useVoiceOptions()
  const [voice, setVoice] = useState(initial)
  const [voiceOpen, setVoiceOpen] = useState(false)
  useEffect(() => () => window.speechSynthesis?.cancel(), []) // 화면을 떠나면 미리 듣기 멈춤

  return {
    voice,
    voiceChanged:
      voice.voice !== initial.voice ||
      voice.speed !== initial.speed ||
      voice.waitTime !== initial.waitTime, // '음성 설정 바뀜' 태그
    rateRange: options.rateRange, // 속도를 AI 지원 범위로 맞춰 보낼 때
    optionsPending: options.isPending, // 받기 전엔 저장 · 등록을 꺼 둠

    voiceOpen,
    openVoice: () => setVoiceOpen(true),
    closeVoice: () => {
      window.speechSynthesis?.cancel()
      setVoiceOpen(false)
    },
    voiceOptions: options.voiceOptions(voice.voice),
    setVoiceName: (x: string) => setVoice((v) => ({ ...v, voice: x })),
    speedOptions: options.speedOptions(voice.speed),
    setSpeed: (speed: VoiceSettings['speed']) => setVoice((v) => ({ ...v, speed })),
    waitOptions: options.waitOptions(voice.waitTime),
    setWaitTime: (waitTime: VoiceSettings['waitTime']) => setVoice((v) => ({ ...v, waitTime })),
    sample: SAMPLE,
    canPreview: typeof window !== 'undefined' && 'speechSynthesis' in window,
    preview: () => {
      window.speechSynthesis.cancel()
      const u = new SpeechSynthesisUtterance(SAMPLE)
      u.lang = 'ko-KR'
      u.rate = RATE[voice.speed]
      window.speechSynthesis.speak(u)
    },
  }
}
