import { Button, Tag } from '@/shared/ui'
import type { PersonaItem } from '@/features/persona/hooks/usePersonaPage'

// 오른쪽 '페르소나' 탭 — 칸을 누르면 그 페르소나의 프롬프트. 고른 칸 = 옅은 남색 바탕
// 통화에 쓰는 페르소나는 '통화에 사용 중' 태그, 나머지는 [사용하기]. 아래 [+ 페르소나 추가]
// [사용하기] → 확인 창 → 그 페르소나 적용 대기('v3 적용 대기') → AI 확인 후 통화에 사용. [+ 페르소나 추가] → 추가 창
export function PersonaList({
  items,
  onSelect,
  onUse,
  onAdd,
}: {
  items: PersonaItem[]
  onSelect: (personaSeq: number) => void
  onUse?: (personaSeq: number) => void // 없으면 [사용하기]를 안 그림 (수정 화면 패널)
  onAdd?: () => void // 없으면 [+ 페르소나 추가]를 그리지 않음 (OPERATOR)
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
            ) : p.applying ? (
              <Tag kind="outline">{p.applying}</Tag>
            ) : (
              p.canUse &&
              onUse && (
                <Button small onClick={() => onUse(p.personaSeq)}>
                  사용하기
                </Button>
              )
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
      {onAdd && (
        <Button className="mt-4 self-start" onClick={onAdd}>
          + 페르소나 추가
        </Button>
      )}
    </div>
  )
}
