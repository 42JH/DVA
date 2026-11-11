import { SelectField } from '@/shared/ui'
import type { useVoiceDraft } from '@/features/persona/hooks/useVoiceDraft'

// 07 음성 설정 — 이름 아래 목소리 드롭다운 (11/11). 고르는 즉시 작성 중 값에 반영 → 화면 [저장] · [등록]으로 같이 저장
export function VoiceFields({ vm }: { vm: ReturnType<typeof useVoiceDraft> }) {
  return (
    <SelectField
      label="목소리"
      value={vm.voice.voice}
      onChange={vm.setVoiceName}
      options={vm.voiceOptions}
    />
  )
}
