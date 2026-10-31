import { Button, Select, Tag } from '@/shared/ui'
import type { CompareView } from '@/features/persona/hooks/usePersonaPage'

// 07 버전 비교 (와이어프레임 07_페르소나관리_버전비교, 10/31) — 프롬프트 카드 자리에. 오른쪽 패널은 그대로
// 제목 줄 v6 [적용 중] → [v8 ▾] · [비교 닫기] → 머리줄 v6 | v8 | 프롬프트 · '빠진 줄 n' '더한 줄 n'
// 앞(적용 버전)은 고정, 드롭다운은 비교할 버전 (10/31 결정 — 와이어프레임은 앞쪽이 드롭다운)
// 줄 = 앞 번호 | 뒤 번호 | −/+ | 글. 빠진 줄 빨간 바탕, 더한 줄 옅은 남색 바탕
const ROW = {
  same: '',
  del: 'bg-danger-soft',
  add: 'bg-action-soft',
} as const

export function VersionDiffCard({
  view,
  onTarget,
  onClose,
}: {
  view: CompareView
  onTarget: (version: string) => void
  onClose: () => void
}) {
  const targetLabel = `v${view.target}`
  return (
    <section className="flex h-full min-h-0 flex-col gap-4 rounded-xl bg-surface p-7 ring-1 ring-line ring-inset">
      <div className="flex items-center gap-4">
        <h2 className="text-card font-bold">버전 비교</h2>
        <span className="flex items-center gap-2 text-body font-bold">
          {view.base}
          <Tag kind="blue">{view.baseTag}</Tag>
        </span>
        <span className="text-body text-sub">→</span>
        <Select name="비교할 버전" options={view.options} value={view.target} onChange={onTarget} />
        <Button className="ml-auto" onClick={onClose}>
          비교 닫기
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-10 items-center border-b border-line text-label font-semibold text-sub">
          <span className="w-12 text-right">{view.base}</span>
          <span className="w-12 text-right">{targetLabel}</span>
          <span className="ml-14">프롬프트</span>
          <span className="ml-auto flex gap-2">
            <Tag kind="red">{`빠진 줄 ${view.removed}`}</Tag>
            <Tag kind="blue">{`더한 줄 ${view.added}`}</Tag>
          </span>
        </div>
        <ol className="min-h-0 flex-1 overflow-auto py-1">
          {view.rows.map((r) => (
            <li key={r.key} className={`flex min-h-[35px] items-center ${ROW[r.kind]}`}>
              <span className="w-12 shrink-0 text-right text-caption text-sub">{r.from}</span>
              <span className="w-12 shrink-0 text-right text-caption text-sub">{r.to}</span>
              <span
                aria-label={r.kind === 'del' ? '빠진 줄' : r.kind === 'add' ? '더한 줄' : undefined}
                className={`w-14 shrink-0 text-center text-body font-bold ${r.kind === 'del' ? 'text-danger' : 'text-action'}`}
              >
                {r.kind === 'del' ? '−' : r.kind === 'add' ? '+' : ''}
              </span>
              <span
                className={`pr-4 text-body whitespace-pre-wrap ${r.heading ? 'font-bold' : ''}`}
              >
                {r.text}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}
