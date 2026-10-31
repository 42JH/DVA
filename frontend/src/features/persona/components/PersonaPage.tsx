import { ConfirmDialog, Tabs } from '@/shared/ui'
import { usePersonaPage, type PanelTab } from '@/features/persona/hooks/usePersonaPage'
import { AddPersonaModal } from './AddPersonaModal'
import { PersonaList } from './PersonaList'
import { PromptCard } from './PromptCard'
import { PromptEditor } from './PromptEditor'
import { TestCallModal } from './TestCallModal'
import { VersionDiffCard } from './VersionDiffCard'
import { VersionList } from './VersionList'

// 07 페르소나 관리 (와이어프레임 07_페르소나관리 · _버전히스토리, 10/31)
// 왼쪽 시스템 프롬프트 카드 | 오른쪽 346 카드 [페르소나 | 버전 히스토리] 탭. 두 카드 모두 화면 높이에 맞추고 안쪽만 스크롤
// [수정] → 오른쪽 패널 없이 넓은 수정 화면 (저장 · 취소하면 돌아옴). [v6과 비교] → 왼쪽 카드가 버전 비교로
const TABS: { key: PanelTab; label: string }[] = [
  { key: 'persona', label: '페르소나' },
  { key: 'history', label: '버전 히스토리' },
]

export function PersonaPage() {
  const vm = usePersonaPage()

  if (vm.error || vm.isLoading || !vm.prompt || !vm.editTarget)
    return (
      <p className="py-16 text-center text-body text-muted">
        {vm.error ?? (vm.isLoading ? '불러오는 중…' : '페르소나가 없습니다.')}
      </p>
    )

  if (vm.editing)
    return (
      <div className="h-full min-h-[600px]">
        <PromptEditor target={vm.editTarget} onDone={vm.finishEdit} />
      </div>
    )

  return (
    <div className="flex h-full min-h-[600px] gap-6">
      <div className="min-w-0 flex-1">
        {vm.compare ? (
          <VersionDiffCard
            view={vm.compare}
            onTarget={vm.setCompareTarget}
            onClose={vm.closeCompare}
          />
        ) : (
          <PromptCard
            prompt={vm.prompt}
            onEdit={vm.startEdit}
            onCompare={vm.startCompare}
            onVoice={vm.startVoice}
          />
        )}
      </div>
      <aside className="flex w-[346px] shrink-0 flex-col rounded-xl bg-surface px-5 pt-3 pb-5 ring-1 ring-line ring-inset">
        <Tabs items={TABS} value={vm.tab} onChange={vm.setTab} />
        <div className="min-h-0 flex-1 overflow-auto">
          {vm.tab === 'persona' ? (
            <PersonaList
              items={vm.personas}
              onSelect={vm.selectPersona}
              onUse={vm.askUse}
              onAdd={vm.openAdd}
            />
          ) : (
            <VersionList
              items={vm.versions}
              more={vm.moreVersions}
              onSelect={vm.selectVersion}
              onShowMore={vm.showAllVersions}
              onTestCall={vm.startTestCall}
              onApply={vm.askApply}
            />
          )}
        </div>
      </aside>
      {vm.applyConfirm && (
        <ConfirmDialog
          title={vm.applyConfirm.title}
          target={vm.applyConfirm.target}
          note={vm.applyConfirm.note}
          warn={vm.applyError ?? undefined}
          okLabel={vm.applyConfirm.okLabel}
          okKind="primary"
          pending={vm.isApplying}
          onOk={vm.confirmApply}
          onClose={vm.cancelApply}
        />
      )}
      {vm.adding && <AddPersonaModal onDone={vm.added} onClose={vm.closeAdd} />}
      {vm.testCall && (
        <TestCallModal
          key={`${vm.testCall.personaSeq}-${vm.testCall.version}`}
          target={vm.testCall}
          onEnd={vm.endTestCall}
        />
      )}
    </div>
  )
}
