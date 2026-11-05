import { ConfirmDialog, TopBar } from '@/shared/ui'
import { usePersonaPage } from '@/features/persona/hooks/usePersonaPage'
import { AddPersonaModal } from './AddPersonaModal'
import { PersonaPanel } from './PersonaPanel'
import { PromptCard } from './PromptCard'
import { PromptEditor } from './PromptEditor'
import { TestCallModal } from './TestCallModal'
import { VersionDiffCard } from './VersionDiffCard'

// 07 페르소나 관리 (와이어프레임 07_페르소나관리 · _버전히스토리, 10/31)
// 왼쪽 시스템 프롬프트 카드 | 오른쪽 346 카드 [페르소나 | 버전 히스토리] 탭(PersonaPanel). 두 카드 모두 화면 높이에 맞추고 안쪽만 스크롤
// 11/05 새 디자인 (구성 그대로 모양만): 화면이 상단바를 그림(router handle 없음) · 본문 좌우 54는 10 관리자 화면과 같은 자리
// 오른쪽 패널은 보기 · 수정 화면 모두 접기 가능, 접힘 상태도 둘이 같이 씀 (11/02). [수정] → 왼쪽이 수정 화면, 패널은 버튼 없이. 패널에서 고르면 저장 안 한 내용 확인 후 그 보기로. [v4와 비교] → 왼쪽 카드가 버전 비교로
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

  let body
  if (vm.error || vm.isLoading || !vm.prompt || !vm.editTarget)
    body = (
      <p className="py-16 text-center text-body text-muted">
        {vm.error ?? (vm.isLoading ? '불러오는 중…' : '페르소나가 없습니다.')}
      </p>
    )
  else if (vm.editing)
    body = (
      <div className="min-h-[600px] flex-1">
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
  else
    body = (
      <div className="flex min-h-[600px] flex-1 gap-6">
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
          open={vm.panelOpen}
          onToggle={vm.togglePanel}
        />
        {vm.applyConfirm && (
          <ConfirmDialog
            big
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

  return (
    <div className="flex min-h-0 flex-[1_1_0px] flex-col">
      <TopBar />
      <div className="mt-2 flex min-h-0 flex-1 flex-col px-[54px]">{body}</div>
    </div>
  )
}
