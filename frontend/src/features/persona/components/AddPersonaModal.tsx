import { Btn, SelectField } from '@/shared/ui'
import { Choice, TextAreaInput, TextInput } from '@/shared/ui/Field'
import { Modal } from '@/shared/ui/Modal'
import { useAddPersona } from '@/features/persona/hooks/useAddPersona'

// 07 페르소나 추가 창 — Figma에 화면이 없어 다른 입력 창(사원 추가 등)과 같은 모양
// 11/10 다른 화면과 같은 창(Modal) · 칸(Field) · 버튼(Btn)
// 이름 · 시스템 프롬프트(고정 제목 여섯 칸) · 음성 → [추가] = v1 저장됨 (통화엔 아직 안 씀). API의 code는 자동 (useAddPersona)
export function AddPersonaModal({
  onDone,
  onClose,
}: {
  onDone: (personaSeq: number) => void
  onClose: () => void
}) {
  const vm = useAddPersona(onDone)

  return (
    <Modal
      title="상담가 추가"
      sub="v1로 저장됩니다. 통화에 쓰려면 시험 통화 뒤 적용하세요."
      width={640}
      onClose={onClose}
      footer={
        <>
          {(vm.emptyNotice ?? vm.submitError) && (
            <p role="alert" className="min-w-0 flex-1 text-[12px] text-ops-stop">
              {vm.emptyNotice ?? vm.submitError}
            </p>
          )}
          <Btn className="ml-auto" onClick={onClose}>
            취소
          </Btn>
          <Btn kind="primary" disabled={!vm.canSubmit} onClick={vm.submit}>
            {vm.isSubmitting ? '추가 중…' : '추가'}
          </Btn>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <TextInput
          label="이름"
          placeholder="예: 꼼꼼 확인형"
          value={vm.name}
          onChange={vm.setName}
        />
        <h3 className="mt-2 text-[14px] font-bold">시스템 프롬프트</h3>
        {vm.sections.map((s) => (
          <TextAreaInput
            key={s.key}
            label={s.group ? `${s.group} · ${s.title}` : s.title}
            value={s.value}
            onChange={(v) => vm.setField(s.key, v)}
            className="[field-sizing:content]" // 글만큼 늘어남 (Chrome · Edge)
          />
        ))}
        <h3 className="mt-2 text-[14px] font-bold">음성</h3>
        <SelectField
          compact
          label="목소리"
          value={vm.voice.voice}
          onChange={vm.setVoiceName}
          options={vm.voiceOptions}
        />
        <Choice
          label="발화 속도"
          value={vm.voice.speed}
          options={vm.speedOptions}
          onChange={vm.setSpeed}
        />
        <Choice
          label="말 끝 기다리기"
          value={vm.voice.waitTime}
          options={vm.waitOptions}
          onChange={vm.setWaitTime}
        />
      </div>
    </Modal>
  )
}
