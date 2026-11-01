// 통화 결과 카드 (02 날짜별 왼쪽 위, 와이어프레임 02 A안 10/30 → 11/01 사용자: 분석된 통화 전부를 링에)
// 왼쪽 반원 게이지 = 분석된 통화 전부 다섯 조각(접수 성공 · 접수 실패 · 문의 · 상담원 이관 · 주문 취소), 가운데 접수 성공률(= 성공 줄 비율, 분모 같음) + 'n건 중 m건 접수 성공'
// 오른쪽 = 다섯 줄(이름 › · 건수 | 비율, 분모 = 분석된 통화 → 합 100%). 오른쪽 위 '총 n건'(분석 전 포함) + '분석 전 n건'
// 줄을 누르면 04 통화 내역을 그 결과 · 같은 기간으로

const SEG = ['stroke-brand', 'stroke-danger', 'stroke-action', 'stroke-muted', 'stroke-line'] // 성공 · 실패 · 문의 · 이관 · 취소 (useDashboard all 순서)
const MARK = ['bg-brand', 'bg-danger', 'bg-action', 'bg-muted', 'bg-line']
const CAP = ['fill-brand', 'fill-danger', 'fill-action', 'fill-muted', 'fill-line'] // 클래스 이름은 글자 그대로 있어야 Tailwind가 만듦 (조립 금지)

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
  unanalysed,
}: {
  className?: string
  scope: string
  total: string
  rate: string
  base: string
  gauge: { key: string; value: number }[]
  rows: (Row & { pct: string })[]
  unanalysed: string | null // '분석 전 5건' (없으면 null)
}) {
  return (
    <section className={`rounded-xl bg-surface p-8 ring-1 ring-line ring-inset ${className}`}>
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-card font-bold">통화 결과</h2>
          <p className="mt-1 text-label text-sub">{scope}</p>
        </div>
        <div className="text-right">
          <p className="flex items-baseline justify-end gap-1.5">
            <span className="text-label font-semibold text-sub">총</span>
            <span className="text-title font-bold">{total}</span>
            <span className="text-label font-semibold text-sub">건</span>
          </p>
          {unanalysed && <p className="text-caption text-muted">{unanalysed}</p>}
        </div>
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
  // 양 끝 마개는 실제로 그린 첫 · 마지막 조각 색 (0건 조각은 호가 없음)
  const drawn = parts.map((p, i) => (p.value > 0 ? i : -1)).filter((i) => i >= 0)
  const first = drawn[0] ?? 0
  const last = drawn[drawn.length - 1] ?? parts.length - 1
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
            <circle cx={cx - r} cy={cy} r={sw / 2} className={CAP[first]} />
            <circle cx={cx + r} cy={cy} r={sw / 2} className={CAP[last]} />
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
