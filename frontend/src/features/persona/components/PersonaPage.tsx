import { ConfirmDialog } from '@/shared/ui'
import { usePersonaPage } from '@/features/persona/hooks/usePersonaPage'
import { AddPersonaModal } from './AddPersonaModal'
import { PersonaPanel } from './PersonaPanel'
import { PromptCard } from './PromptCard'
import { PromptEditor } from './PromptEditor'
import { TestCallModal } from './TestCallModal'
import { VersionDiffCard } from './VersionDiffCard'

// 07 페르소나 관리 (와이어프레임 07_페르소나관리 · _버전히스토리, 10/31)
// 왼쪽 시스템 프롬프트 카드 | 오른쪽 346 카드 [페르소나 | 버전 히스토리] 탭(PersonaPanel). 두 카드 모두 화면 높이에 맞추고 안쪽만 스크롤
// [수정] → 왼쪽이 수정 화면, 오른쪽 패널은 버튼 없이 · 접기 가능 (11/02). 패널에서 고르면 저장 안 한 내용 확인 후 그 보기로. [v4와 비교] → 왼쪽 카드가 버전 비교로
export function PersonaPage() {
  const vm = usePersonaPage()
  const panel = {
    tab: vm.tab,
    onTab: vm.setTab,
    personas: vm.personas,
    versions: vm.versions,
    moreVersions: vm.moreVersions,
    onShowMore: vm.showAllVersions,
  }

  if (vm.error || vm.isLoading || !vm.prompt || !vm.editTarget)
    return (
      <p className="py-16 text-center text-body text-muted">
        {vm.error ?? (vm.isLoading ? '불러오는 중…' : '페르소나가 없습니다.')}
      </p>
    )

  if (vm.editing)
    return (
      <div className="h-full min-h-[600px]">
        <PromptEditor
          target={vm.editTarget}
          onDone={vm.finishEdit}
          aside={(leave) => (
            <PersonaPanel
              {...panel}
              onSelectPersona={(seq) => leave(() => vm.selectPersona(seq))}
              onSelectVersion={(v) => leave(() => vm.selectVersion(v))}
              open={vm.panelOpen}
              onToggle={vm.togglePanel}
            />
          )}
        />
      </div>
    )

  return (
    <div className="flex h-full min-h-[600px] gap-6">
      <div className="min-w-0 flex-1">
        {vm.compare ? (
          <VersionDiffCard view={vm.compare} onClose={vm.closeCompare} />
        ) : (
          <PromptCard
            prompt={vm.prompt}
            onEdit={vm.startEdit}
            onCompare={vm.startCompare}
            onVoice={vm.startVoice}
          />
        )}
      </div>
      <PersonaPanel
        {...panel}
        onSelectPersona={vm.selectPersona}
        onSelectVersion={vm.selectVersion}
        onUse={vm.askUse}
        onAdd={vm.canAdd ? vm.openAdd : undefined}
        onTestCall={vm.startTestCall}
        onApply={vm.askApply}
      />
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
