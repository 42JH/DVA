import type { ReactNode } from 'react'
import { Button, ConfirmDialog, Tag, TextArea } from '@/shared/ui'
import { usePromptEditor, type EditTarget } from '@/features/persona/hooks/usePromptEditor'
import { VoiceModal } from './VoiceModal'

// 07 프롬프트 수정 (와이어프레임 07_페르소나관리_수정, 10/31) — 오른쪽에 페르소나 · 버전 히스토리 패널(aside, 접을 수 있음, 11/02)
// 제목 줄 [음성 세부 조절] → 고정 제목 + 입력칸 여섯 개(11/10, 줄 번호 없음) → [취소] [저장 → v7]
// 11/05 새 디자인 (구성 그대로 모양만): 버튼 big · 저장 파랑 · 글 칸 테두리 파랑 · 새 확인 창
// 와이어프레임의 [v6과 비교]는 뺌 (10/31 결정): 비교는 저장 후 보기 화면에서
// 칸은 글만큼 늘고(field-sizing, Chrome · Edge) 칸 묶음 전체가 한 번에 스크롤
export function PromptEditor({
  target,
  onDone,
  aside,
}: {
  target: EditTarget
  onDone: (savedVersion?: number) => void
  aside?: (leave: (then: () => void) => void) => ReactNode // 오른쪽 패널 — 고르면 leave(보기로 갈 일): 저장 안 한 내용이 있으면 확인 창부터
}) {
  const vm = usePromptEditor(target, onDone)

  return (
    <div className="flex h-full gap-6">
      <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col gap-4 rounded-xl bg-surface p-7 ring-1 ring-line ring-inset">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-card font-semibold">시스템 프롬프트</h2>
          <Button big kind="brandLine" onClick={vm.openVoice}>
            음성 세부 조절
          </Button>
        </div>
        <p className="-mt-2 flex items-center gap-3">
          <Tag kind="gray">{vm.tag}</Tag>
          <span className="text-label text-sub">{vm.subtitle}</span>
        </p>

        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto pr-2">
          {vm.sections.map((s) => (
            <div key={s.key} className="flex flex-col gap-3">
              {s.group && <h3 className="text-body font-bold">{s.group}</h3>}
              <TextArea
                label={s.title}
                value={s.value}
                spellCheck={false}
                onChange={(e) => vm.setField(s.key, e.target.value)}
                className="[field-sizing:content] min-h-20! resize-none"
              />
            </div>
          ))}
        </div>

        <div className="flex items-center justify-end gap-3">
          {(vm.emptyNotice ?? vm.saveError) && (
            <p role="alert" className="mr-auto text-body text-danger">
              {vm.emptyNotice ?? vm.saveError}
            </p>
          )}
          <Button big onClick={vm.cancel}>
            취소
          </Button>
          <Button big kind="brand" disabled={!vm.canSave} onClick={vm.save}>
            {vm.saveLabel}
          </Button>
        </div>

        {vm.voiceOpen && <VoiceModal vm={vm} subtitle={vm.subtitle} />}
        {vm.confirmingDiscard && (
          <ConfirmDialog
            big
            title="저장하지 않고 나갈까요?"
            note="고친 내용이 사라집니다."
            okLabel="나가기"
            onOk={vm.discard}
            onClose={vm.keepEditing}
          />
        )}
      </section>
      {aside?.(vm.leave)}
    </div>
  )
}
