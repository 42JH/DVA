import { Tabs } from '@/shared/ui'
import { usePersonaPage, type PanelTab } from '@/features/persona/hooks/usePersonaPage'
import { PersonaList } from './PersonaList'
import { PromptCard } from './PromptCard'
import { VersionList } from './VersionList'

// 07 페르소나 관리 (와이어프레임 07_페르소나관리 · _버전히스토리, 10/31)
// 왼쪽 시스템 프롬프트 카드 | 오른쪽 346 카드 [페르소나 | 버전 히스토리] 탭. 두 카드 모두 화면 높이에 맞추고 안쪽만 스크롤
const TABS: { key: PanelTab; label: string }[] = [
  { key: 'persona', label: '페르소나' },
  { key: 'history', label: '버전 히스토리' },
]

export function PersonaPage() {
  const vm = usePersonaPage()

  if (vm.error || vm.isLoading || !vm.prompt)
    return (
      <p className="py-16 text-center text-body text-muted">
        {vm.error ?? (vm.isLoading ? '불러오는 중…' : '페르소나가 없습니다.')}
      </p>
    )

  return (
    <div className="flex h-full min-h-[600px] gap-6">
      <div className="min-w-0 flex-1">
        <PromptCard prompt={vm.prompt} />
      </div>
      <aside className="flex w-[346px] shrink-0 flex-col rounded-xl bg-surface px-5 pt-3 pb-5 ring-1 ring-line ring-inset">
        <Tabs items={TABS} value={vm.tab} onChange={vm.setTab} />
        <div className="min-h-0 flex-1 overflow-auto">
          {vm.tab === 'persona' ? (
            <PersonaList items={vm.personas} onSelect={vm.selectPersona} />
          ) : (
            <VersionList
              items={vm.versions}
              more={vm.moreVersions}
              onSelect={vm.selectVersion}
              onShowMore={vm.showAllVersions}
            />
          )}
        </div>
      </aside>
    </div>
  )
}
