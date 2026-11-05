import type { ReactNode } from 'react'
import { Button, ConfirmDialog, Tag } from '@/shared/ui'
import { usePromptEditor, type EditTarget } from '@/features/persona/hooks/usePromptEditor'
import { VoiceModal } from './VoiceModal'

const LINE = 27 // 줄 높이 px — 줄 번호 칸과 글 칸이 같은 높이여야 번호가 맞음

// 07 프롬프트 수정 (와이어프레임 07_페르소나관리_수정, 10/31) — 오른쪽에 페르소나 · 버전 히스토리 패널(aside, 접을 수 있음, 11/02)
// 제목 줄 [음성 세부 조절] → 줄 번호 + 글 칸(커서 줄 번호 파랑) → [취소] [저장 → v7]
// 11/05 새 디자인 (구성 그대로 모양만): 버튼 big · 저장 파랑 · 글 칸 테두리 파랑 · 새 확인 창
// 와이어프레임의 [v6과 비교]는 뺌 (10/31 결정): 비교는 저장 후 보기 화면에서
// 줄은 접지 않음(wrap off): 접으면 한 줄이 여러 줄로 보여 줄 번호가 어긋남
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

        {/* 줄 번호 칸 + 글 칸을 한 스크롤 안에 → 위아래로 같이 움직임 */}
        <div className="flex min-h-0 flex-1 overflow-auto rounded-lg ring-[1.5px] ring-brand ring-inset">
          <ol
            aria-hidden
            className="w-12 shrink-0 border-r border-line py-3 text-right select-none"
          >
            {Array.from({ length: vm.lineCount }, (_, i) => (
              <li
                key={i}
                style={{ height: LINE }}
                className={`pr-3 text-caption leading-[27px] ${vm.caretLine === i + 1 ? 'font-bold text-brand' : 'text-sub'}`}
              >
                {i + 1}
              </li>
            ))}
          </ol>
          <textarea
            aria-label="시스템 프롬프트"
            value={vm.text}
            wrap="off"
            spellCheck={false}
            rows={vm.lineCount}
            onChange={(e) => {
              vm.setText(e.target.value)
              vm.onCaret(e.target.value, e.target.selectionStart)
            }}
            onSelect={(e) => vm.onCaret(e.currentTarget.value, e.currentTarget.selectionStart)}
            onBlur={vm.clearCaret}
            style={{ lineHeight: `${LINE}px` }}
            className="min-w-0 flex-1 resize-none overflow-x-auto overflow-y-hidden bg-transparent px-3 py-3 text-label outline-none"
          />
        </div>

        <div className="flex items-center justify-end gap-3">
          {vm.saveError && (
            <p role="alert" className="mr-auto text-body text-danger">
              {vm.saveError}
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
