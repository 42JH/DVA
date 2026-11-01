import { Button, Tag } from '@/shared/ui'
import type { PromptView } from '@/features/persona/hooks/usePersonaPage'

// 왼쪽 '시스템 프롬프트' 카드 — 제목 줄 [음성 세부 조절] [v6과 비교] [수정] → 버전 태그 · 한 줄 설명 → 줄 번호 붙은 프롬프트(읽기 전용)
// [비교] → 버전 비교 카드. [음성 세부 조절] → 수정 화면으로 들어가며 음성 창 (음성만 바꿔도 새 버전)
// 지난 버전을 볼 땐 [수정] · [음성 세부 조절] 없음 — 수정은 늘 최신 저장본에서 (11/02 결정)
export function PromptCard({
  prompt,
  onEdit,
  onCompare,
  onVoice,
}: {
  prompt: PromptView
  onEdit: () => void
  onCompare: () => void
  onVoice: () => void
}) {
  return (
    <section className="flex h-full min-h-0 flex-col gap-4 rounded-xl bg-surface p-7 ring-1 ring-line ring-inset">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-card font-bold">시스템 프롬프트</h2>
        <div className="flex gap-2">
          {prompt.canEdit && <Button onClick={onVoice}>음성 세부 조절</Button>}
          {prompt.compareLabel && <Button onClick={onCompare}>{prompt.compareLabel}</Button>}
          {prompt.canEdit && (
            <Button kind="primary" onClick={onEdit}>
              수정
            </Button>
          )}
        </div>
      </div>
      <p className="-mt-2 flex items-center gap-3">
        <Tag kind="gray">{prompt.tag}</Tag>
        <span className="text-label text-sub">{prompt.subtitle}</span>
      </p>
      {/* 줄 번호 칸 + 본문. 길면 이 칸만 스크롤 */}
      <ol className="min-h-0 flex-1 overflow-auto rounded-lg py-3 text-label ring-1 ring-line ring-inset">
        {prompt.lines.map((l) => (
          <li key={l.no} className="flex min-h-[27px] leading-[1.5]">
            <span className="w-12 shrink-0 border-r border-line pr-3 text-right text-caption text-sub select-none">
              {l.no}
            </span>
            <span className={`pl-3 whitespace-pre-wrap ${l.heading ? 'font-bold' : ''}`}>
              {l.text}
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}
