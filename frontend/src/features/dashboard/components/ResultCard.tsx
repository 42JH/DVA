// 통화 결과 카드 (02 날짜별 왼쪽 위, 와이어프레임 02 A안 10/30)
// 왼쪽 반원 게이지 = 접수 성공 · 접수 실패 · 상담원 이관, 가운데 접수 성공률 + 'n건 중'
// 오른쪽 = 게이지의 세 줄(이름 › · 건수 | 비율) → 진한 선 → 게이지 밖 통화 한 줄(□ 주문 취소 › · □ 문의 ›). 오른쪽 위 '총 n건' (= 다섯 합)
// 줄을 누르면 04 통화 내역을 그 결과 · 같은 기간으로

const SEG = ['stroke-brand', 'stroke-danger', 'stroke-muted'] // 성공 · 실패 · 이관 (04 태그 색)
const MARK = ['bg-brand', 'bg-danger', 'bg-muted']
const CAP = ['fill-brand', 'fill-danger', 'fill-muted'] // 클래스 이름은 글자 그대로 있어야 Tailwind가 만듦 (조립 금지)

interface Row {
  key: string
  label: string
  count: string
  onClick: () => void
}

export function ResultCard({
  className = '',
  scope,
  total,
  rate,
  base,
  gauge,
  rows,
  others,
}: {
  className?: string
  scope: string
  total: string
  rate: string
  base: string
  gauge: { key: string; value: number }[]
  rows: (Row & { pct: string })[]
  others: Row[]
}) {
  return (
    <section className={`rounded-xl bg-surface p-8 ring-1 ring-line ring-inset ${className}`}>
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-card font-bold">통화 결과</h2>
          <p className="mt-1 text-label text-sub">{scope}</p>
        </div>
        <p className="flex items-baseline gap-1.5">
          <span className="text-label font-semibold text-sub">총</span>
          <span className="text-title font-bold">{total}</span>
          <span className="text-label font-semibold text-sub">건</span>
        </p>
      </div>

      <div className="mt-4 flex items-center gap-10">
        <Gauge parts={gauge} rate={rate} base={base} />

        <div className="min-w-0 flex-1">
          <ul>
            {rows.map((r, i) => (
              <li key={r.key} className={i ? 'border-t border-bg' : ''}>
                <button
                  type="button"
                  onClick={r.onClick}
                  className="group flex h-[42px] w-full items-center text-left"
                >
                  <span className={`mr-2 size-2.5 shrink-0 rounded-sm ${MARK[i]}`} />
                  <span className="w-[120px] text-label font-semibold group-hover:text-action">
                    {r.label} <span className="text-muted">›</span>
                  </span>
                  <span className="w-16 text-right text-strong font-semibold">{r.count}</span>
                  <span className="ml-1 text-label font-semibold text-sub">건</span>
                  <span className="mx-2 h-4 w-px bg-line" />
                  <span className="text-label font-semibold text-sub">{r.pct}</span>
                </button>
              </li>
            ))}
          </ul>
          {/* 진한 선 아래 = 게이지에 안 들어가는 통화 (빈 네모) */}
          <div className="mt-1.5 flex h-[42px] items-center gap-10 border-t border-line pt-1.5">
            {others.map((o) => (
              <button
                key={o.key}
                type="button"
                onClick={o.onClick}
                className="group flex items-center text-left"
              >
                <span className="mr-2 size-2.5 shrink-0 rounded-sm bg-surface ring-[1.5px] ring-muted ring-inset" />
                <span className="text-label font-semibold group-hover:text-action">
                  {o.label} <span className="text-muted">›</span>
                </span>
                <span className="ml-3 text-strong font-semibold">{o.count}</span>
                <span className="ml-1 text-label font-semibold text-sub">건</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

/** 반원 게이지 (그래프 라이브러리 없이 SVG). 왼쪽 끝 = 0, 오른쪽 끝 = 전체. 조각 사이 1.6° 틈, 양 끝은 둥근 마개 */
function Gauge({
  parts,
  rate,
  base,
}: {
  parts: { key: string; value: number }[]
  rate: string
  base: string
}) {
  const r = 112
  const sw = 26
  const cx = r + sw / 2
  const cy = r + sw / 2
  const sum = parts.reduce((a, p) => a + p.value, 0)
  const pt = (deg: number) => {
    const a = (deg * Math.PI) / 180
    return `${(cx + r * Math.cos(a)).toFixed(2)} ${(cy - r * Math.sin(a)).toFixed(2)}`
  }
  // 조각 경계 각도 (180° → 0°): 앞 조각들의 합까지
  const edge = (i: number) =>
    180 - (sum ? (180 * parts.slice(0, i).reduce((s, p) => s + p.value, 0)) / sum : 0)
  const arcs = parts.map((p, i) => {
    const d = `M ${pt(edge(i) - (i ? 0.8 : 0))} A ${r} ${r} 0 0 1 ${pt(edge(i + 1) + (i < parts.length - 1 ? 0.8 : 0))}`
    return p.value > 0 ? (
      <path key={p.key} d={d} className={SEG[i]} strokeWidth={sw} fill="none" />
    ) : null
  })
  return (
    <div className="relative shrink-0" style={{ width: cx * 2, height: cy + sw / 2 + 4 }}>
      <svg width={cx * 2} height={cy + sw / 2} aria-hidden>
        {sum === 0 ? (
          <path
            d={`M ${pt(180)} A ${r} ${r} 0 0 1 ${pt(0)}`}
            className="stroke-bg"
            strokeWidth={sw}
            fill="none"
          />
        ) : (
          <>
            {arcs}
            <circle cx={cx - r} cy={cy} r={sw / 2} className={CAP[0]} />
            <circle cx={cx + r} cy={cy} r={sw / 2} className={CAP[parts.length - 1]} />
          </>
        )}
      </svg>
      <div className="absolute inset-x-0 bottom-0 flex flex-col items-center">
        <span className="text-title font-bold">{rate}</span>
        <span className="text-label font-semibold text-sub">접수 성공률</span>
        <span className="mt-1 text-caption text-muted">{base}</span>
      </div>
    </div>
  )
}
