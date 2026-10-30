import { Tag } from '@/shared/ui'
import type { ActionView, ResultView } from '@/features/call/hooks/useCallDetail'

// 처리 내용 카드 (06 오른쪽, 와이어프레임 06_통화상세 10/30) — 이 통화가 한 일
// 위: 결과 블록 (굵은 종류 · 회색 통화 안 시각 · 오른쪽 링크). 접수 · 주문 취소 → '주문 보기 ›'(팝업), AI 미답변 → 질문 + 'AI 미답변 보기 ›'(09)
// 아래: 'AI 동작 n' 읽기 쉬운 기록 (시각 · 회색 태그 · 내용). 길면 이 목록만 스크롤 — 결과 블록은 그대로
export function CallActions({
  className = '',
  results,
  actions,
}: {
  className?: string
  results: ResultView[]
  actions: ActionView[]
}) {
  return (
    <section
      className={`flex min-h-0 flex-col rounded-xl bg-surface p-8 ring-1 ring-line ring-inset ${className}`}
    >
      <h2 className="flex h-10 items-center text-card font-bold">처리 내용</h2>

      <ul className="shrink-0">
        {results.map((r) => (
          <li key={r.key} className="border-b border-line py-4">
            <div className="flex items-baseline gap-3">
              <span className="text-body font-bold">{r.label}</span>
              <span className="text-label text-sub">{r.time}</span>
              <button
                type="button"
                onClick={r.link.onClick}
                className="ml-auto text-label font-semibold text-action hover:underline"
              >
                {r.link.label} ›
              </button>
            </div>
            {r.question && (
              <p className="mt-3 flex gap-6 text-body">
                <span className="shrink-0 text-label leading-7 text-sub">질문</span>
                <span className="min-w-0">{r.question}</span>
              </p>
            )}
          </li>
        ))}
      </ul>

      <h3 className="mt-6 flex items-baseline gap-2.5 text-body font-bold">
        AI 동작 <span className="text-label font-normal text-sub">{actions.length}</span>
      </h3>
      <ul className="mt-3 min-h-0 flex-1 overflow-y-auto">
        {actions.length === 0 && <li className="py-6 text-body text-muted">기록이 없습니다.</li>}
        {actions.map((a) => (
          <li key={a.key} className="flex items-start gap-3 py-1">
            <span className="w-12 shrink-0 text-label leading-7 text-sub">{a.time}</span>
            <span className="w-14 shrink-0">
              <Tag kind="gray">{a.tag}</Tag>
            </span>
            <span className="min-w-0 text-label leading-7 break-words">{a.text}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
