import { usePromptEditor, type EditTarget } from '@/features/persona/hooks/usePromptEditor'
import { PersonaForm } from './PersonaForm'
import { VoiceFields } from './VoiceFields'

// 07 프롬프트 수정 (와이어프레임 07_페르소나관리_수정, 10/31) — 화면은 등록과 같은 PersonaForm (11/11)
// 수정만의 것: 초안 저장 훅
export function PromptEditor({
  target,
  onDone,
}: {
  target: EditTarget
  onDone: (savedVersion?: number) => void
}) {
  const vm = usePromptEditor(target, onDone)

  return <PersonaForm vm={vm} voiceFields={<VoiceFields vm={vm} />} />
}
