import { Button, ChipGroup, Dialog, SelectField, Tag } from '@/shared/ui'
import type { usePromptEditor } from '@/features/persona/hooks/usePromptEditor'

// 07 음성 세부 조절 창 (와이어프레임 07_페르소나관리_음성세부조절, 10/31) — 수정 화면 위에
// 'v8 작성 중' (+ 바꾸면 '음성 설정 바뀜') → 음성: 목소리 ▾ · 발화 속도 · 말 끝 기다리기 · 미리 듣기 ▶
// 저장 버튼 없음: 고르는 즉시 작성 중 버전에 반영, 수정 화면 [저장]으로 프롬프트와 같이 저장
// 11/05 새 디자인: 새 창(Dialog). 새 창은 버튼 줄이 늘 있어 빈 줄 대신 [닫기](✕ · Esc와 같음) · 미리 듣기 파랑
export function VoiceModal({
  vm,
  subtitle,
}: {
  vm: ReturnType<typeof usePromptEditor>
  subtitle: string
}) {
  return (
    <Dialog
      label="음성 세부 조절"
      title={vm.voiceTitle}
      extra={vm.voiceChanged ? <Tag kind="blue">음성 설정 바뀜</Tag> : undefined}
      sub={subtitle}
      width={720}
      onClose={vm.closeVoice}
      footer={
        <Button big className="ml-auto" onClick={vm.closeVoice}>
          닫기
        </Button>
      }
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
        <div className="grid grid-cols-[var(--field-label,120px)_1fr] items-center gap-x-4">
          <span className="text-body text-sub">미리 듣기</span>
          <span className="flex items-center gap-3">
            <Button
              kind="brand"
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
    </Dialog>
  )
}
