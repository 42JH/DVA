import { Button, Tag } from '@/shared/ui'
import type { VersionItem } from '@/features/persona/hooks/usePersonaPage'

// 오른쪽 '버전 히스토리' 탭 — 최신부터. 칸을 누르면 그 버전의 프롬프트 + 그 칸에만 [시험 통화] [적용] (10/31)
// [적용]은 적용 안 한 최신 저장본에만. 지난 버전은 [시험 통화]만 (11/02 결정 — 옛 버전으로 되돌리기 없음)
// 6개 넘으면 '이전 버전 n개 더 보기 ›'
// [시험 통화] → 시험 통화 창, 끝나면 '시험 통화 완료 · 01:12' + [적용] 남색 (07_적용가능). [적용]은 시험 통화를 끝낸 버전만 → 확인 창 (10/31)
export function VersionList({
  items,
  more,
  onSelect,
  onShowMore,
  onTestCall,
  onApply,
}: {
  items: VersionItem[]
  more: number
  onSelect: (version: number) => void
  onShowMore: () => void
  onTestCall?: (version: number) => void // 없으면 고른 칸의 버튼 줄을 안 그림 (수정 화면 패널)
  onApply?: (version: number) => void
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
          <p className="text-caption text-sub">{v.author}</p>
          {v.testResult && (
            <p className="mt-1 flex justify-between text-caption">
              <span className="text-sub">시험 통화</span>
              <span className="font-bold">{v.testResult}</span>
            </p>
          )}
          {v.selected && onTestCall && (
            <div className="mt-2 flex justify-between" onClick={(e) => e.stopPropagation()}>
              <Button
                small
                className="flex items-center gap-1.5"
                onClick={() => onTestCall(v.version)}
              >
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
              {v.canApply && onApply && (
                <Button
                  small
                  kind={v.canApplyNow ? 'primary' : 'normal'}
                  disabled={!v.canApplyNow}
                  title={v.canApplyNow ? undefined : '시험 통화를 끝내면 적용할 수 있습니다'}
                  onClick={() => onApply(v.version)}
                >
                  적용
                </Button>
              )}
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
