import { useAddPersona } from '../hooks/useAddPersona'
import type { usePersonaPage } from '../hooks/usePersonaPage'
import { PersonaForm } from './PersonaForm'
import { PersonaTabs } from './PersonaTabs'
import { VoiceFields } from './VoiceFields'

// 07 상담가 등록 — 위 탭은 그대로, 아래 카드가 '새 상담가' 폼
// 이름 · 시스템 프롬프트(고정 제목 여섯 칸) · 음성 → [등록] = v1 저장됨 (통화엔 아직 안 씀). API의 code는 자동 (useAddPersona)
export function AddPersona({ vm }: { vm: ReturnType<typeof usePersonaPage> }) {
  const f = useAddPersona(vm.added, vm.closeAdd)
  return (
    <>
      {/* 쓰던 게 있으면 탭을 눌러도 먼저 물음 */}
      <PersonaTabs vm={vm} adding go={f.leave} />
      <PersonaForm vm={f} voiceFields={<VoiceFields vm={f} form />} />
    </>
  )
}
