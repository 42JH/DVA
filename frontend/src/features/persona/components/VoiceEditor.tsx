import { Confirm } from '@/shared/ui/Modal'
import { usePromptEditor, type EditTarget } from '@/features/persona/hooks/usePromptEditor'
import { VoiceModal } from './VoiceModal'

// 07 보기 화면의 [음성 세부 조절] (11/11) — 화면 이동 없이 음성 창만 띄움
// 수정 화면과 같은 훅이라 저장(바뀐 음성만 PATCH → 초안) · 저장 안 하고 나가기 확인이 그대로 같음
export function VoiceEditor({
  target,
  onDone,
}: {
  target: EditTarget
  onDone: (savedVersion?: number) => void
}) {
  const vm = usePromptEditor(target, onDone)

  return (
    <>
      <VoiceModal vm={vm} subtitle={vm.subtitle} standalone />
      {vm.confirmingDiscard && (
        <Confirm
          title="저장하지 않고 나갈까요?"
          ok="나가기"
          onOk={vm.discard}
          onClose={vm.keepEditing}
        >
          바꾼 음성 설정이 사라집니다.
        </Confirm>
      )}
    </>
  )
}
