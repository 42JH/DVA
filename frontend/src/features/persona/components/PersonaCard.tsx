import { useState } from 'react'
import { useNavigate } from 'react-router'
import type { usePersonaPage } from '@/features/persona/hooks/usePersonaPage'
import { usePromptEditor, type EditTarget } from '@/features/persona/hooks/usePromptEditor'
import { Badge, Btn } from '@/shared/ui'
import { Confirm } from '@/shared/ui/Modal'
import { ApplyBand } from './ApplyBand'
import { HistoryModal } from './HistoryModal'
import { PersonaName } from './PersonaName'
import { PersonaTabs } from './PersonaTabs'
import { PromptBody } from './PromptBody'
import { VoiceFields } from './VoiceFields'

type Vm = ReturnType<typeof usePersonaPage>
type Ed = ReturnType<typeof usePromptEditor>

// 위 탭 + 카드 (11/13 새 안). 현재 버전 · 관리 권한이면 카드가 곧 입력 칸 — 고치기 시작하면 [취소] [저장]
export function PersonaCard({ vm }: { vm: Vm }) {
  const t = vm.prompt?.canEdit ? vm.editTarget : null
  if (!t) return <View vm={vm} ed={null} editing={false} />
  // 상담가 · 버전 · 초안이 바뀌면 작성 중 값을 새로 (저장하면 버전이 바뀌어 저절로 비워짐)
  return <Editable key={`${t.personaSeq}:${t.basedOn}:${t.draftRevision}`} vm={vm} target={t} />
}

// [취소] → 고친 글을 버리고 처음 값으로 — 훅을 새로 띄우려고 한 겹 더 (round가 key)
function Editable({ vm, target }: { vm: Vm; target: EditTarget }) {
  const [round, setRound] = useState(0)
  return <EditRound key={round} vm={vm} target={target} reset={() => setRound((r) => r + 1)} />
}

function EditRound({ vm, target, reset }: { vm: Vm; target: EditTarget; reset: () => void }) {
  const ed = usePromptEditor(target, (saved) => (saved === undefined ? reset() : vm.finishEdit()))
  // 남은 초안은 안 고쳐도 [저장]으로 확정할 수 있게 처음부터 [취소] [저장]
  return <View vm={vm} ed={ed} editing={ed.dirty || target.draftRevision !== null} />
}

function View({ vm, ed, editing }: { vm: Vm; ed: Ed | null; editing: boolean }) {
  // 고친 게 있으면 같은 화면 안 이동(탭 · 등록)도 먼저 물음
  const go = (next: () => void) => (ed ? ed.leave(next) : next())
  return (
    <>
      <PersonaTabs vm={vm} adding={false} go={go} />
      {/* 탭은 그대로 두고 카드만 로딩 */}
      {vm.promptLoading || !vm.prompt || !vm.current ? (
        <p className="flex flex-1 items-center justify-center text-[14px] text-ops-sub">
          불러오는 중…
        </p>
      ) : (
        <Card vm={vm} ed={ed} editing={editing} />
      )}
      {ed?.confirmingDiscard && (
        <Confirm
          title="저장하지 않고 나갈까요?"
          ok="나가기"
          onOk={ed.discard}
          onClose={ed.keepEditing}
        >
          고친 내용이 사라집니다.
        </Confirm>
      )}
    </>
  )
}

// 머리 줄 — 1줄 이름 · 배지 / 2줄 목소리 · 저장 시각 | 오른쪽 버튼 (고치는 중엔 [취소] [저장]만)
// 연필(3단계) · 수정 기록 보기(5단계)는 그 단계에서
function Card({ vm, ed, editing }: { vm: Vm; ed: Ed | null; editing: boolean }) {
  const p = vm.prompt!
  const c = vm.current!
  const navigate = useNavigate()
  return (
    <article className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-ops-line bg-white">
      <header className="flex flex-wrap items-center gap-4 border-b border-ops-line px-7 py-5">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {/* 프롬프트를 고치는 중엔 연필 없음 — 이름 저장이 새 버전을 만들어 고치던 글이 사라지므로 */}
            <PersonaName name={c.name} target={ed && !editing ? vm.editTarget : null} />
            {c.inUse && <Badge tone="done">통화에 사용 중</Badge>}
            {c.applying && <Badge tone="wait">{c.applying}</Badge>}
          </div>
          <div className="flex flex-wrap items-end gap-4 text-[14px] text-ops-sub">
            {ed ? <VoiceFields vm={ed} /> : <span>목소리 {c.voice}</span>}
            <span>
              {p.time} 저장{p.author && ` · ${p.author}`}
            </span>
            {/* 고치는 중엔 막음 — 불러오기가 새 버전을 만들어 고치던 글이 사라지므로 */}
            <button
              type="button"
              disabled={editing}
              onClick={vm.openHistory}
              className="underline outline-none hover:text-ops-ink focus-visible:ring-2 focus-visible:ring-ops-route disabled:text-ops-faint disabled:no-underline"
            >
              수정 기록 보기
            </button>
          </div>
        </div>
        {ed && editing ? (
          <span className="ml-auto flex flex-wrap items-center gap-2">
            {(ed.emptyNotice ?? ed.saveError) && (
              <span role="alert" className="text-[12px] text-ops-stop">
                {ed.emptyNotice ?? ed.saveError}
              </span>
            )}
            <Btn onClick={ed.cancel}>취소</Btn>
            <Btn kind="primary" disabled={!ed.canSave} onClick={ed.save}>
              {ed.saveLabel}
            </Btn>
          </span>
        ) : (
          <span className="ml-auto flex flex-wrap gap-2">
            {c.deletable && (
              <Btn kind="danger" onClick={() => vm.askDelete(c.personaSeq)}>
                삭제
              </Btn>
            )}
            {vm.testTo && (
              <Btn kind="plain" onClick={() => void navigate(vm.testTo!)}>
                시나리오 시험
              </Btn>
            )}
            {c.canUse && (
              <Btn kind="line" onClick={() => vm.askUse(c.personaSeq)}>
                통화에 사용하기
              </Btn>
            )}
          </span>
        )}
      </header>
      {vm.band && (
        <ApplyBand
          band={vm.band}
          showCall={vm.showCall}
          setShowCall={vm.setShowCall}
          onApply={vm.applyHead}
          busy={editing}
        />
      )}
      {/* '통화에 쓰는 내용'은 읽기만 — 고치던 글은 편집 훅에 그대로 남아 '고친 내용'으로 돌아오면 이어짐 */}
      {p.callSections ? (
        <PromptBody p={{ ...p, sections: p.callSections }} ed={null} />
      ) : (
        <PromptBody p={p} ed={ed} />
      )}
      {vm.historyOpen && <HistoryModal vm={vm} />}
    </article>
  )
}
