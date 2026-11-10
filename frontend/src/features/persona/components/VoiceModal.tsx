import { Badge, Btn, SelectField } from '@/shared/ui'
import { Choice, Label } from '@/shared/ui/Field'
import { Modal } from '@/shared/ui/Modal'
import type { usePromptEditor } from '@/features/persona/hooks/usePromptEditor'

// 07 음성 세부 조절 창 (와이어프레임 07_페르소나관리_음성세부조절, 10/31) — 수정 화면 위에
// 'v8 작성 중' (+ 바꾸면 '음성 설정 바뀜') → 목소리 ▾ · 발화 속도 · 말 끝 기다리기 · 미리 듣기 ▶
// 저장 버튼 없음: 고르는 즉시 작성 중 버전에 반영, 수정 화면 [저장]으로 프롬프트와 같이 저장
// 11/10 다른 화면과 같은 창(Modal) · 칸(Field) · 버튼(Btn). 아래 줄은 [닫기](✕ · Esc와 같음)만
// 11/11 보기 화면에서 열면(standalone) 수정 화면이 없으니 창에 [저장]을 두고, 닫기 = 수정 화면 [취소]와 같음
export function VoiceModal({
  vm,
  subtitle,
  standalone = false,
}: {
  vm: ReturnType<typeof usePromptEditor>
  subtitle: string
  standalone?: boolean
}) {
  const close = standalone ? vm.cancel : vm.closeVoice
  return (
    <Modal
      title={vm.voiceTitle}
      extra={vm.voiceChanged ? <Badge tone="route">음성 설정 바뀜</Badge> : undefined}
      sub={subtitle}
      width={560}
      onClose={close}
      footer={
        <>
          {standalone && (vm.emptyNotice ?? vm.saveError) && (
            <p role="alert" className="min-w-0 flex-1 text-[12px] text-ops-stop">
              {vm.emptyNotice ?? vm.saveError}
            </p>
          )}
          <Btn className="ml-auto" onClick={close}>
            닫기
          </Btn>
          {standalone && (
            <Btn kind="primary" disabled={!vm.canSave} onClick={vm.save}>
              {vm.saveLabel}
            </Btn>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
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
        <div className="flex flex-col gap-1">
          <Label>미리 듣기</Label>
          <span className="flex items-center gap-3">
            <Btn
              kind="primary"
              aria-label="미리 듣기"
              disabled={!vm.canPreview}
              onClick={vm.preview}
              className="size-8 rounded-full! px-0!"
            >
              <svg viewBox="0 0 20 20" className="size-3.5 fill-current" aria-hidden>
                <path d="M6 4l10 6-10 6z" />
              </svg>
            </Btn>
            <span className="text-[14px]">{vm.sample}</span>
          </span>
        </div>
      </div>
    </Modal>
  )
}
