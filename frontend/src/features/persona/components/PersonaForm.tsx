import type { ReactNode } from 'react'
import { Btn } from '@/shared/ui'
import { TextAreaInput, TextInput } from '@/shared/ui/Field'
import { Confirm } from '@/shared/ui/Modal'
import type { useAddPersona } from '@/features/persona/hooks/useAddPersona'

// 등록 · 수정 훅이 같은 모양으로 돌려주는 값 — usePromptEditor도 이 모양을 그대로 만족함
type FormVm = Pick<
  ReturnType<typeof useAddPersona>,
  | 'tag'
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

// 07 상담가 등록 · 프롬프트 수정 공용 화면 (11/11 — 등록도 창 대신 수정과 같은 넓은 화면)
// 보기 화면 카드(Prompt)와 같은 틀 — 위 줄(버전 · 부제) · 이름 + 고정 제목 입력칸 여섯 개 · 아래 줄([취소] [저장])
// 제목 크기도 보기 화면과 같게: 발화 스타일 · 역할 등 18, 발화 스타일 아래(톤 · 속도) 15
// 와이어프레임의 [v6과 비교]는 뺌 (10/31 결정): 비교는 저장 후 보기 화면에서
// 칸은 글만큼 늘고(field-sizing, Chrome · Edge) 칸 묶음 전체가 한 번에 스크롤
export function PersonaForm({
  vm,
  voiceFields,
}: {
  vm: FormVm
  voiceFields: ReactNode // 이름 아래 음성 드롭다운 (VoiceFields)
}) {
  return (
    <article className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-ops-line bg-white">
      <header className="flex flex-wrap items-center gap-3 border-b border-ops-line px-5 py-3">
        <span className="text-[15px] font-bold">{vm.tag}</span>
        <span className="text-[13px] text-ops-sub">{vm.subtitle}</span>
      </header>

      <div className="flex min-h-0 flex-1 [scrollbar-width:thin] flex-col gap-7 overflow-y-auto px-8 py-6">
        <TextInput
          label="이름"
          labelClassName="text-[18px] font-bold"
          placeholder="예: 꼼꼼 확인형"
          value={vm.name}
          onChange={vm.setName}
        />
        {voiceFields}
        {vm.sections.map((s) => (
          <section key={s.key} className="flex flex-col gap-4">
            {s.group && <h3 className="text-[18px] font-bold">{s.group}</h3>}
            <TextAreaInput
              label={s.title}
              labelClassName={s.sub ? 'text-[15px] font-bold' : 'text-[18px] font-bold'}
              value={s.value}
              onChange={(v) => vm.setField(s.key, v)}
              className="[field-sizing:content]"
            />
          </section>
        ))}
      </div>

      <footer className="flex items-center gap-2 border-t border-ops-line px-5 py-3">
        {(vm.emptyNotice ?? vm.saveError) && (
          <p role="alert" className="min-w-0 flex-1 text-[12px] text-ops-stop">
            {vm.emptyNotice ?? vm.saveError}
          </p>
        )}
        <Btn className="ml-auto" onClick={vm.cancel}>
          취소
        </Btn>
        <Btn kind="primary" disabled={!vm.canSave} onClick={vm.save}>
          {vm.saveLabel}
        </Btn>
      </footer>

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
    </article>
  )
}
