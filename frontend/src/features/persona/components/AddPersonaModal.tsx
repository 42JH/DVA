import { Button, ChipGroup, FormModal, SelectField, TextArea, TextField } from '@/shared/ui'
import { useAddPersona } from '@/features/persona/hooks/useAddPersona'

// 07 페르소나 추가 창 — Figma에 화면이 없어 주문 추가 · 음성 세부 조절 창과 같은 모양 (라벨 왼쪽 120)
// 이름 · 시스템 프롬프트 · 음성 → [추가] = v1 저장됨 (통화엔 아직 안 씀). API의 code는 자동 (useAddPersona)
export function AddPersonaModal({
  onDone,
  onClose,
}: {
  onDone: (personaSeq: number) => void
  onClose: () => void
}) {
  const vm = useAddPersona(onDone)

  return (
    <FormModal
      title="페르소나 추가"
      description="v1로 저장됩니다. 통화에 쓰려면 시험 통화 뒤 적용하세요."
      width={800}
      onClose={onClose}
      footer={
        <>
          {vm.submitError && (
            <p role="alert" className="mr-auto self-center text-label text-danger">
              {vm.submitError}
            </p>
          )}
          <Button onClick={onClose}>취소</Button>
          <Button kind="primary" disabled={!vm.canSubmit} onClick={vm.submit}>
            {vm.isSubmitting ? '추가 중…' : '추가'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <TextField
          label="이름"
          inline
          placeholder="예: 꼼꼼 확인형"
          value={vm.name}
          onChange={(e) => vm.setName(e.target.value)}
        />
        <TextArea
          label="시스템 프롬프트"
          placeholder={'# 역할\n너는 디버 택배 전화 접수 AI다.'}
          value={vm.prompt}
          onChange={(e) => vm.setPrompt(e.target.value)}
        />
        <h3 className="mt-2 text-body font-bold">음성</h3>
        <div className="w-[360px]">
          <SelectField
            label="목소리"
            inline
            value={vm.voice.voice}
            onChange={vm.setVoiceName}
            options={vm.voiceOptions}
          />
        </div>
        <ChipGroup
          name="발화 속도"
          compact
          options={vm.speedOptions}
          value={vm.voice.speed}
          onChange={vm.setSpeed}
        />
        <ChipGroup
          name="말 끝 기다리기"
          compact
          options={vm.waitOptions}
          value={vm.voice.waitTime}
          onChange={vm.setWaitTime}
        />
      </div>
    </FormModal>
  )
}
