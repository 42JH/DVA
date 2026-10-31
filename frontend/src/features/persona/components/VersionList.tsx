import { Button, Tag } from '@/shared/ui'
import type { VersionItem } from '@/features/persona/hooks/usePersonaPage'

// 오른쪽 '버전 히스토리' 탭 — 최신부터. 칸을 누르면 그 버전의 프롬프트. 작성 중 칸엔 [시험 통화] [적용]
// 6개 넘으면 '이전 버전 n개 더 보기 ›'
// shortcut: [시험 통화] · [적용]은 다음 단계(시험 통화 · 적용 화면)에서 켬
export function VersionList({
  items,
  more,
  onSelect,
  onShowMore,
}: {
  items: VersionItem[]
  more: number
  onSelect: (version: number) => void
  onShowMore: () => void
}) {
  return (
    <div className="flex flex-col">
      {items.map((v) => (
        <div
          key={v.version}
          role="button"
          tabIndex={0}
          onClick={() => onSelect(v.version)}
          onKeyDown={(e) => e.key === 'Enter' && onSelect(v.version)}
          className={`-mx-5 flex cursor-pointer flex-col gap-1 border-b border-line px-5 py-4 ${
            v.selected ? 'bg-action-soft' : 'hover:bg-bg'
          }`}
        >
          <p className="flex items-center gap-2">
            <span className="text-strong font-bold">v{v.version}</span>
            {v.tags.map((t) => (
              <Tag key={t.label} kind={t.kind} onTinted={v.selected}>
                {t.label}
              </Tag>
            ))}
            <span className="ml-auto text-caption text-sub">{v.date}</span>
          </p>
          <p className="text-label">{v.summary}</p>
          {v.author && <p className="text-caption text-sub">{v.author}</p>}
          {v.isDraft && (
            <div className="mt-2 flex justify-between" onClick={(e) => e.stopPropagation()}>
              <Button small disabled className="flex items-center gap-1.5">
                <svg
                  viewBox="0 0 20 20"
                  className="size-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.6}
                  strokeLinecap="round"
                  aria-hidden
                >
                  <rect x="7" y="2.5" width="6" height="10" rx="3" />
                  <path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5" />
                </svg>
                시험 통화
              </Button>
              <Button small disabled>
                적용
              </Button>
            </div>
          )}
        </div>
      ))}
      {more > 0 && (
        <button
          type="button"
          onClick={onShowMore}
          className="mt-4 self-start text-label font-bold text-action hover:underline"
        >
          이전 버전 {more}개 더 보기 ›
        </button>
      )}
    </div>
  )
}
