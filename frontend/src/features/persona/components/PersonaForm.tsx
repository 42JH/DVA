import type { ReactNode } from 'react'
import { Btn } from '@/shared/ui'
import { TextInput } from '@/shared/ui/Field'
import { Confirm } from '@/shared/ui/Modal'
import type { useAddPersona } from '../hooks/useAddPersona'
import { PromptBody } from './PromptBody'

type FormVm = Pick<
  ReturnType<typeof useAddPersona>,
  | 'subtitle'
  | 'name'
  | 'setName'
  | 'sections'
  | 'setField'
  | 'emptyNotice'
  | 'saveLabel'
  | 'canSave'
  | 'save'
  | 'saveError'
  | 'cancel'
  | 'confirmingDiscard'
  | 'discard'
  | 'keepEditing'
>

// 07 상담가 등록 — 카드 머리 줄 '새 상담가' + [취소] [등록]
// 이름 · 목소리 한 줄, 아래는 보기 카드와 같은 회색 제목 줄 + 빈 칸 (PromptBody)
export function PersonaForm({
  vm,
  voiceFields,
}: {
  vm: FormVm
  voiceFields: ReactNode // 목소리 드롭다운 (VoiceFields)
}) {
  return (
    // 폼: 이름 칸에서 Enter = 등록 (글 칸은 줄바꿈). 등록이 꺼져 있으면 브라우저가 제출 안 함
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (vm.canSave) vm.save()
      }}
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-ops-line bg-white"
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-ops-line px-7 py-5">
        <h2 className="text-[22px] font-bold">{vm.subtitle}</h2>
        {(vm.emptyNotice ?? vm.saveError) && (
          <p role="alert" className="ml-auto text-[12px] text-ops-stop">
            {vm.emptyNotice ?? vm.saveError}
          </p>
        )}
        <Btn className="ml-auto" onClick={vm.cancel}>
          취소
        </Btn>
        <Btn kind="primary" type="submit" disabled={!vm.canSave}>
          {vm.saveLabel}
        </Btn>
      </header>

      {/* 피그마: 이름 898 · 목소리 520, 오른쪽은 비움 */}
      <div className="mx-8 grid grid-cols-[5fr_3fr_2fr] items-start gap-4 border-b border-ops-line pt-5 pb-5">
        <TextInput
          label="이름"
          placeholder="예: 꼼꼼 확인형"
          value={vm.name}
          onChange={vm.setName}
        />
        {voiceFields}
      </div>
      <PromptBody ed={vm} plain />

      {vm.confirmingDiscard && (
        <Confirm
          title="저장하지 않고 나갈까요?"
          ok="나가기"
          onOk={vm.discard}
          onClose={vm.keepEditing}
        >
          고친 내용이 사라집니다.
        </Confirm>
      )}
    </form>
  )
}
