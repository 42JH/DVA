import { slideClass, useSlideDir } from '@/shared/lib/useSlideDir'
import { Tabs } from '@/shared/ui'
import type { PanelTab, PersonaItem, VersionItem } from '@/features/persona/hooks/usePersonaPage'
import { PersonaList } from './PersonaList'
import { VersionList } from './VersionList'

// 오른쪽 346 카드 [페르소나 | 버전 히스토리] — 보기 화면 · 수정 화면 공용 (11/02)
// 수정 화면: 버튼 없이(onUse · onAdd · onTestCall · onApply를 안 줌) + 접기 · 펼치기(onToggle)
const TABS: { key: PanelTab; label: string }[] = [
  { key: 'persona', label: '페르소나' },
  { key: 'history', label: '버전 히스토리' },
]

const Chevron = ({ d }: { d: string }) => (
  <svg
    viewBox="0 0 20 20"
    className="size-5"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d={d} />
  </svg>
)

export function PersonaPanel({
  tab,
  onTab,
  personas,
  versions,
  moreVersions,
  onShowMore,
  onSelectPersona,
  onSelectVersion,
  onUse,
  onAdd,
  onTestCall,
  onApply,
  open = true,
  onToggle,
}: {
  tab: PanelTab
  onTab: (t: PanelTab) => void
  personas: PersonaItem[]
  versions: VersionItem[]
  moreVersions: number
  onShowMore: () => void
  onSelectPersona: (personaSeq: number) => void
  onSelectVersion: (version: number) => void
  onUse?: (personaSeq: number) => void
  onAdd?: () => void
  onTestCall?: (version: number) => void
  onApply?: (version: number) => void
  open?: boolean
  onToggle?: () => void // 있으면 접기 · 펼치기 버튼
}) {
  // 탭을 바꾸면 내용이 그 방향에서 미끄러져 들어옴 (다른 화면 탭과 같은 전환, 11/01)
  const slide = slideClass(useSlideDir(TABS.findIndex((t) => t.key === tab)))

  if (!open)
    return (
      <aside className="flex w-12 shrink-0 flex-col items-center rounded-xl bg-surface pt-4 ring-1 ring-line ring-inset">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={false}
          aria-label="페르소나 · 버전 히스토리 펼치기"
          title="페르소나 · 버전 히스토리 펼치기"
          className="rounded-md p-1 text-sub hover:bg-bg hover:text-ink"
        >
          <Chevron d="M12.5 5l-5 5 5 5" />
        </button>
      </aside>
    )

  return (
    <aside className="flex w-[346px] shrink-0 flex-col rounded-xl bg-surface px-5 pt-3 pb-5 ring-1 ring-line ring-inset">
      <div className="flex items-start gap-2">
        <Tabs items={TABS} value={tab} onChange={onTab} />
        {onToggle && (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded
            aria-label="페르소나 · 버전 히스토리 접기"
            title="접기"
            className="mt-2 ml-auto rounded-md p-1 text-sub hover:bg-bg hover:text-ink"
          >
            <Chevron d="M7.5 5l5 5-5 5" />
          </button>
        )}
      </div>
      <div key={tab} className={`min-h-0 flex-1 overflow-auto ${slide}`}>
        {tab === 'persona' ? (
          <PersonaList items={personas} onSelect={onSelectPersona} onUse={onUse} onAdd={onAdd} />
        ) : (
          <VersionList
            items={versions}
            more={moreVersions}
            onSelect={onSelectVersion}
            onShowMore={onShowMore}
            onTestCall={onTestCall}
            onApply={onApply}
          />
        )}
      </div>
    </aside>
  )
}
