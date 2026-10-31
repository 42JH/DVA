import { Button, Tag } from '@/shared/ui'
import type { PersonaItem } from '@/features/persona/hooks/usePersonaPage'

// 오른쪽 '페르소나' 탭 — 칸을 누르면 그 페르소나의 프롬프트. 고른 칸 = 옅은 남색 바탕
// 통화에 쓰는 페르소나는 '통화에 사용 중' 태그, 나머지는 [사용하기]. 아래 [+ 페르소나 추가]
// shortcut: [사용하기] · [+ 페르소나 추가]는 다음 단계에서 켬
export function PersonaList({
  items,
  onSelect,
}: {
  items: PersonaItem[]
  onSelect: (personaSeq: number) => void
}) {
  return (
    <div className="flex flex-col">
      {items.map((p) => (
        <div
          key={p.personaSeq}
          role="button"
          tabIndex={0}
          onClick={() => onSelect(p.personaSeq)}
          onKeyDown={(e) => e.key === 'Enter' && onSelect(p.personaSeq)}
          className={`-mx-5 flex cursor-pointer flex-col gap-1.5 border-b border-line px-5 py-4 ${
            p.selected ? 'bg-action-soft' : 'hover:bg-bg'
          }`}
        >
          <p className={`text-body font-bold ${p.selected ? 'text-action' : ''}`}>{p.name}</p>
          <div onClick={(e) => e.stopPropagation()}>
            {p.inUse ? (
              <Tag kind="live">통화에 사용 중</Tag>
            ) : (
              <Button small disabled>
                사용하기
              </Button>
            )}
          </div>
          {p.lines.map((line) => (
            <p key={line} className="text-label text-sub">
              {line}
            </p>
          ))}
          <p className="text-caption text-sub">{p.versionLine}</p>
        </div>
      ))}
      <Button className="mt-4 self-start" disabled>
        + 페르소나 추가
      </Button>
    </div>
  )
}
