import { Button, ChipGroup, Dialog, SelectField, TextArea, TextField } from '@/shared/ui'
import { useAddPersona } from '@/features/persona/hooks/useAddPersona'

// 07 페르소나 추가 창 — Figma에 화면이 없어 주문 추가 · 음성 세부 조절 창과 같은 모양 (라벨 왼쪽 120)
// 11/05 새 디자인: 새 창(Dialog — 칸도 새 모양) · 버튼 big · [추가] 파랑
// 이름 · 시스템 프롬프트(고정 제목 여섯 칸, 11/10) · 음성 → [추가] = v1 저장됨 (통화엔 아직 안 씀). API의 code는 자동 (useAddPersona)
export function AddPersonaModal({
  onDone,
  onClose,
}: {
  onDone: (personaSeq: number) => void
  onClose: () => void
}) {
  const vm = useAddPersona(onDone)

  return (
    <Dialog
      label="페르소나 추가"
      title="페르소나 추가"
      sub="v1로 저장됩니다. 통화에 쓰려면 시험 통화 뒤 적용하세요."
      width={800}
      onClose={onClose}
      footer={
        <>
          {(vm.emptyNotice ?? vm.submitError) && (
            <p role="alert" className="min-w-0 text-body text-danger">
              {vm.emptyNotice ?? vm.submitError}
            </p>
          )}
          <Button big className="ml-auto" onClick={onClose}>
            취소
          </Button>
          <Button big kind="brand" disabled={!vm.canSubmit} onClick={vm.submit}>
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
        <h3 className="mt-2 text-body font-bold">시스템 프롬프트</h3>
        {vm.sections.map((s) => (
          <TextArea
            key={s.key}
            label={s.group ? `${s.group} · ${s.title}` : s.title}
            value={s.value}
            onChange={(e) => vm.setField(s.key, e.target.value)}
            className="[field-sizing:content] min-h-20!" // 글만큼 늘어남 (Chrome · Edge)
          />
        ))}
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
    </Dialog>
  )
}
