import { useAddPersona } from '@/features/persona/hooks/useAddPersona'
import { PersonaForm } from './PersonaForm'

// 07 상담가 등록 (11/11 — 창 대신 수정과 같은 넓은 화면, 음성 칸 없음)
// 이름 · 시스템 프롬프트(고정 제목 여섯 칸) → [등록] = v1 저장됨 (통화엔 아직 안 씀). API의 code는 자동 (useAddPersona)
export function AddPersona({
  onDone,
  onClose,
}: {
  onDone: (personaSeq: number) => void
  onClose: () => void
}) {
  const vm = useAddPersona(onDone, onClose)
  return <PersonaForm vm={vm} />
}
