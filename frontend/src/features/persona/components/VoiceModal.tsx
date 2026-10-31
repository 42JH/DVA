import { Button, ChipGroup, FormModal, SelectField, Tag } from '@/shared/ui'
import type { usePromptEditor } from '@/features/persona/hooks/usePromptEditor'

// 07 음성 세부 조절 창 (와이어프레임 07_페르소나관리_음성세부조절, 10/31) — 수정 화면 위에
// 'v8 작성 중' (+ 바꾸면 '음성 설정 바뀜') → 음성: 목소리 ▾ · 발화 속도 · 말 끝 기다리기 · 미리 듣기 ▶
// 저장 버튼 없음: 고르는 즉시 작성 중 버전에 반영, 수정 화면 [저장]으로 프롬프트와 같이 저장
export function VoiceModal({
  vm,
  subtitle,
}: {
  vm: ReturnType<typeof usePromptEditor>
  subtitle: string
}) {
  return (
    <FormModal
      title={vm.voiceTitle}
      titleExtra={vm.voiceChanged ? <Tag kind="blue">음성 설정 바뀜</Tag> : undefined}
      description={subtitle}
      width={720}
      onClose={vm.closeVoice}
      footer={null}
    >
      <section className="flex flex-col gap-3">
        <h3 className="mb-1 text-body font-bold">음성</h3>
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
        <div className="grid grid-cols-[120px_1fr] items-center gap-x-4">
          <span className="text-label text-sub">미리 듣기</span>
          <span className="flex items-center gap-3">
            <Button
              kind="primary"
              aria-label="미리 듣기"
              disabled={!vm.canPreview}
              onClick={vm.preview}
              className="grid size-10 place-items-center rounded-full! px-0!"
            >
              <svg viewBox="0 0 20 20" className="size-4 fill-white" aria-hidden>
                <path d="M6 4l10 6-10 6z" />
              </svg>
            </Button>
            <span className="text-body">{vm.sample}</span>
          </span>
        </div>
      </section>
    </FormModal>
  )
}
