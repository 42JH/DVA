import { Tag } from '@/shared/ui'

// 버전별 기록 (02 페르소나별, 10/29 확정) — 최근 3개 버전, 최신부터, 순위 없음 ('통화 적음' · 보정 점수 없음)
// 열: 페르소나 · 버전 | 운영 기간 | 통화 | 접수 성공 | 접수 실패 | 상담원 이관 (% 위 · 건수 아래) | 평균 통화 시간 | 평균 되묻기
// 줄을 누르면 아래 두 카드가 그 버전 것으로 (고른 줄 = 옅은 남색, 태그는 흰 바탕)

interface Cell {
  pct: string
  count: string
}
export interface VersionRowView {
  id: string
  name: string
  active: boolean
  period: string
  calls: string
  success: Cell
  failed: Cell
  handoff: Cell
  avgTime: string
  avgRepeat: string
  selected: boolean
  onSelect: () => void
}

// 상태(적용 중 · 이전)는 이름 옆이 아니라 따로 한 열 — 이름 옆에 두면 긴 이름이 잘렸음 (11/02 사용자)
const COLS = 'grid-cols-[2fr_1.1fr_0.6fr_0.7fr_0.9fr_0.9fr_0.9fr_1fr_0.8fr]'

export function VersionTable({
  rows,
  note = null,
}: {
  rows: VersionRowView[]
  note?: string | null // '평균은 버전별 최근 2,000건 기준' (목록 상한에 걸린 버전이 있을 때)
}) {
  return (
    <section className="rounded-xl bg-surface p-8 ring-1 ring-line ring-inset">
      <h2 className="text-card font-bold">버전별 기록</h2>
      <p className="mt-1 text-label text-sub">
        최근 {rows.length}개 버전{note ? ` · ${note}` : ''}
      </p>

      <div
        className={`mt-4 grid ${COLS} h-7 items-center border-b border-line text-caption text-muted`}
      >
        <span>페르소나 · 버전</span>
        <span>운영 기간</span>
        <span className="text-center">상태</span>
        <span className="text-right">통화</span>
        <span className="flex items-center justify-end gap-1.5">
          <i className="size-2.5 rounded-sm bg-brand" />
          접수 성공
        </span>
        <span className="flex items-center justify-end gap-1.5">
          <i className="size-2.5 rounded-sm bg-danger" />
          접수 실패
        </span>
        <span className="flex items-center justify-end gap-1.5">
          <i className="size-2.5 rounded-sm bg-muted" />
          상담원 이관
        </span>
        <span className="text-right">평균 통화 시간</span>
        <span className="text-right">평균 되묻기</span>
      </div>
      <ul>
        {rows.map((r) => (
          <li key={r.id} className="border-b border-bg last:border-0">
            <button
              type="button"
              onClick={r.onSelect}
              aria-pressed={r.selected}
              className={`-mx-4 grid w-[calc(100%+32px)] ${COLS} h-[60px] items-center rounded-lg px-4 text-left ${
                r.selected ? 'bg-action-soft' : 'hover:bg-bg'
              }`}
            >
              <span
                className={`min-w-0 truncate pr-4 text-label ${r.selected ? 'font-bold text-action' : 'font-semibold'}`}
                title={r.name}
              >
                {r.name}
              </span>
              <span className="pr-4 text-label text-sub">{r.period}</span>
              <span className="text-center">
                <Tag kind={r.active ? 'blue' : 'outline'} onTinted={r.selected}>
                  {r.active ? '적용 중' : '이전'}
                </Tag>
              </span>
              <span className="text-right text-label font-semibold">{r.calls}</span>
              {[r.success, r.failed, r.handoff].map((c, i) => (
                <span key={i} className="text-right">
                  <span className="block text-label font-semibold">{c.pct}</span>
                  <span className="block text-caption text-sub">{c.count}</span>
                </span>
              ))}
              <span className="text-right text-label font-semibold">{r.avgTime}</span>
              <span className="text-right text-label font-semibold">{r.avgRepeat}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
