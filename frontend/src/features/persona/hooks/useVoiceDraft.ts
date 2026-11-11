import { useState } from 'react'
import type { VoiceSettings } from '@/features/persona/api/personaApi'
import { useVoiceOptions } from '@/features/persona/hooks/useVoiceOptions'

/** 음성 드롭다운 값 — 상담가 등록 · 수정 화면 공용 (11/11)
 * 저장 버튼 없이 고르는 즉시 작성 중 값에 반영 → 화면 [저장] · [등록]으로 같이 보냄 */
export function useVoiceDraft(initial: VoiceSettings) {
  const options = useVoiceOptions()
  const [voice, setVoice] = useState(initial)

  return {
    voice,
    voiceChanged: voice.voice !== initial.voice, // 저장 안 한 내용 확인에 씀
    rateRange: options.rateRange, // 속도를 AI 지원 범위로 맞춰 보낼 때
    optionsPending: options.isPending, // 받기 전엔 저장 · 등록을 꺼 둠

    voiceOptions: options.voiceOptions(voice.voice),
    setVoiceName: (x: string) => setVoice((v) => ({ ...v, voice: x })),
  }
}
