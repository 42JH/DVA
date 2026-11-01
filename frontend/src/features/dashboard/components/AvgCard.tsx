// 평균 카드 (02 날짜별 오른쪽 위) — 위 평균 통화 시간 · 아래 평균 되묻기, 가로선으로 나눔
// 값이 있으면 큰 값 + 오른쪽 작은 두 줄(접수 성공 · 실패 평균). 통계 API가 없는 동안(명세 §10)은 '—'와 안내 한 줄 (성공하는 척 금지)

const ICON = {
  clock: (
    <>
      <circle cx="10" cy="10" r="7.5" />
      <path d="M10 6v4l2.5 2.5" />
    </>
  ),
  repeat: (
    <path d="M4 8a6 6 0 0 1 10.5-3.5L16 6M16 2.5V6h-3.5M16 12a6 6 0 0 1-10.5 3.5L4 14M4 17.5V14h3.5" />
  ),
}

export function AvgCard({
  className = '',
  items,
}: {
  className?: string
  items: {
    key: string
    icon: keyof typeof ICON
    label: string
    value?: [string, string][] // [['2', '분'], ['51', '초']]. 없으면 '—'
    split?: [string, string][] // [['접수 성공', '3분 12초'], ['접수 실패', '1분 25초']]
    note?: string // 값 대신 보여 줄 안내 ('집계 API 없음')
  }[]
}) {
  return (
    <section
      className={`flex flex-col rounded-xl bg-surface ring-1 ring-line ring-inset ${className}`}
    >
      {items.map((it, i) => (
        <div
          key={it.key}
          className={`flex flex-1 flex-col justify-center px-6 ${i ? 'border-t border-line' : ''}`}
        >
          <p className="flex items-center gap-2 text-label font-semibold text-sub">
            <svg
              viewBox="0 0 20 20"
              className="size-4 stroke-muted"
              fill="none"
              strokeWidth={1.8}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              {ICON[it.icon]}
            </svg>
            {it.label}
          </p>
          <div className="mt-2 flex items-center justify-between gap-4">
            <p className="flex items-baseline gap-1 whitespace-nowrap">
              {it.value ? (
                it.value.map(([v, u]) => (
                  <span key={u} className="mr-1.5">
                    <span className="text-title font-bold">{v}</span>
                    <span className="ml-0.5 text-label font-semibold text-sub">{u}</span>
                  </span>
                ))
              ) : (
                <span className="text-title font-bold text-muted">—</span>
              )}
            </p>
            {it.split && (
              // 두 칸의 작은 줄 = 같은 세로선 (이름 칸 폭 고정)
              <dl className="grid grid-cols-[auto_auto] gap-x-3 text-label">
                {it.split.map(([name, val]) => (
                  <div key={name} className="contents">
                    <dt className="text-sub">{name}</dt>
                    <dd className="text-right font-semibold">{val}</dd>
                  </div>
                ))}
              </dl>
            )}
            {it.note && <span className="text-caption text-muted">{it.note}</span>}
          </div>
        </div>
      ))}
    </section>
  )
}
