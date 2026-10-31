import { Button, Tag } from '@/shared/ui'
import type { PromptView } from '@/features/persona/hooks/usePersonaPage'

// 왼쪽 '시스템 프롬프트' 카드 — 제목 줄 [음성 세부 조절] [v6과 비교] [수정] → 버전 태그 · 한 줄 설명 → 줄 번호 붙은 프롬프트(읽기 전용)
// shortcut: [음성 세부 조절] · [비교]는 다음 단계에서 켬
export function PromptCard({ prompt, onEdit }: { prompt: PromptView; onEdit: () => void }) {
  return (
    <section className="flex h-full min-h-0 flex-col gap-4 rounded-xl bg-surface p-7 ring-1 ring-line ring-inset">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-card font-bold">시스템 프롬프트</h2>
        <div className="flex gap-2">
          <Button disabled>음성 세부 조절</Button>
          {prompt.compareLabel && <Button disabled>{prompt.compareLabel}</Button>}
          <Button kind="primary" onClick={onEdit}>
            수정
          </Button>
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
