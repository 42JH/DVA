import { useId, type ReactNode } from 'react'
import { axisTicks } from '../format'

// 02 대시보드 그래프 — 라이브러리 없이 (Figma 'AI 상담 성능' · '통계 · 그래프 보기' 11/04)
// 크기는 남는 높이를 따라감 (780 높이 노트북 ~ 1920 PC 한 화면)
// 뜰 때 움직임: 막대 자람 · 도넛 채워짐 · 값 글자 뒤따라 나타남 (global.css animate-*, 움직임 줄이기 설정이면 안 움직임)
// 막대 모양: 위 두 모서리만 둥글게(6px) · 아래(0 선에 닿는 쪽)는 각지게 (이미지)

const at = (v: number, top: number) => `${(v / top) * 100}%`

/** 그래프 틀 — 가로선 + 왼쪽 눈금 글자(아래 끝 0 · 위 끝 맨 위 눈금). children은 같은 칸에 겹쳐 그림
 *  낮은 화면(1366×768 노트북 등)에선 칸이 낮아 눈금 글자가 겹침 → 한 칸 걸러 하나만 */
function Plot({
  ticks,
  tick,
  className,
  children,
}: {
  ticks: number[]
  tick: string // 눈금 글자 크기
  className: string // 바깥 여백 (왼쪽 = 눈금 글자 자리, 위 = 가장 긴 막대의 값 글자 자리)
  children: ReactNode
}) {
  const top = ticks[ticks.length - 1]
  return (
    <div className={`relative min-h-0 flex-1 ${className}`}>
      {ticks.map((t, i) => (
        <div
          key={t}
          className={`absolute inset-x-0 border-t border-ops-line ${i % 2 ? '[@media(max-height:720px)]:hidden' : ''}`}
          style={{ bottom: at(t, top) }}
        >
          <span
            className={`absolute top-0 right-full mr-[9px] -translate-y-1/2 text-ops-faint ${tick}`}
          >
            {t}
          </span>
        </div>
      ))}
      {children}
    </div>
  )
}

/** 막대 색 — 첫 막대(현재 운영 버전) 파랑 · 둘째(직전 버전) 회색. 클래스 이름은 글자 그대로 */
const BAR = [
  { bar: 'bg-ops-route', text: 'text-ops-route' },
  { bar: 'bg-ops-faint', text: 'text-ops-sub' },
]

/** 버전별 막대 (Figma 'AI 상담 성능' 접수 소요 시간 · 페르소나 막대그래프) — 막대 폭 112 · 모서리 4
 *  막대 위 값(첫 막대는 파랑 글자) · 아래 이름 · 구분 · 접수 건수. 값이 null(그 표본 없음)이면 막대 없이 '—' (0초로 안 그림, 명세 §3) */
export function BarChart({
  bars,
}: {
  bars: { key: string; name: string; value: number | null; label: string; sub: string }[]
}) {
  const ticks = axisTicks(Math.max(0, ...bars.map((b) => b.value ?? 0)))
  const top = ticks[ticks.length - 1]
  const cols = { gridTemplateColumns: `repeat(${bars.length}, minmax(0, 1fr))` }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Plot ticks={ticks} tick="text-[12px]" className="mt-4 mr-5 ml-11">
        <div className="absolute inset-0 grid px-[8%]" style={cols}>
          {bars.map((b, i) => (
            <div key={b.key} className="relative flex items-end justify-center">
              {b.value !== null && (
                <div
                  className={`w-[min(112px,80%)] origin-bottom rounded-t-md motion-safe:animate-bar-grow ${BAR[i % 2].bar}`}
                  style={{ height: at(b.value, top) }}
                />
              )}
              <span
                className={`absolute left-1/2 mb-0.5 -translate-x-1/2 text-[16px] font-bold whitespace-nowrap tabular-nums motion-safe:animate-label-in ${b.value === null ? 'text-ops-ink' : BAR[i % 2].text}`}
                style={{ bottom: at(b.value ?? 0, top) }}
              >
                {b.label}
              </span>
            </div>
          ))}
        </div>
      </Plot>
      <div className="mr-5 ml-11 grid shrink-0 px-[8%] pt-2 text-center text-ops-sub" style={cols}>
        {bars.map((b) => (
          <p key={b.key} className="flex min-w-0 flex-col">
            <span className="truncate text-[12px]">{b.name}</span>
            <span className="text-[12px] text-ops-faint">{b.sub}</span>
          </p>
        ))}
      </div>
    </div>
  )
}

/** 고객군 묶음 막대 (Figma '통계 · 그래프 보기' 큰 그래프) — 항목마다 고객군 막대를 나란히(폭 36~40 · 사이 10 · 모서리 4)
 *  막대 위 값 14/700(고객군 색) · 아래 항목 이름 13/700. 값이 null이면 막대 없이 '—' */
export function GroupedBars({
  groups,
  series,
  barWidth,
}: {
  groups: { key: string; label: string }[]
  series: { key: string; bar: string; text: string; values: (number | null)[]; labels: string[] }[]
  barWidth: number
}) {
  const ticks = axisTicks(Math.max(0, ...series.flatMap((s) => s.values.map((v) => v ?? 0))))
  const top = ticks[ticks.length - 1]
  const cols = { gridTemplateColumns: `repeat(${groups.length}, minmax(0, 1fr))` }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Plot ticks={ticks} tick="text-[12px]" className="mt-4 mr-5 ml-14">
        <div className="absolute inset-0 grid" style={cols}>
          {groups.map((g, gi) => (
            <div key={g.key} className="flex items-end justify-center gap-2.5">
              {series.map((s) => {
                const v = s.values[gi]
                return (
                  <div
                    key={s.key}
                    className="relative flex h-full max-w-[30%] items-end"
                    style={{ width: barWidth }}
                  >
                    {v !== null && (
                      <div
                        className={`w-full origin-bottom rounded-t-md motion-safe:animate-bar-grow ${s.bar}`}
                        style={{ height: at(v, top) }}
                      />
                    )}
                    <span
                      className={`absolute left-1/2 mb-1 -translate-x-1/2 text-[14px] font-bold whitespace-nowrap tabular-nums motion-safe:animate-label-in ${s.text}`}
                      style={{ bottom: at(v ?? 0, top) }}
                    >
                      {s.labels[gi]}
                    </span>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </Plot>
      <div
        className="mr-5 ml-14 grid shrink-0 pt-5 text-center text-[13px] font-semibold text-ops-ink"
        style={cols}
      >
        {groups.map((g) => (
          <span key={g.key} className="px-1 break-keep">
            {g.label}
          </span>
        ))}
      </div>
    </div>
  )
}

const R = 66 // 도넛 가운데 원 반지름 (그림 166 기준)
const SW = 34 // 고리 두께
const C = 2 * Math.PI * R
const GAP = 1.2 // 조각 사이 흰 틈

/** 판정 도넛 (Figma 166 · 12시부터 시계 방향) — 가운데 'n 건'(한 통화의 여러 유형은 각각, 11/11 설명 줄임). 합이 0이면 회색 고리만 */
export function Donut({
  slices,
  total,
}: {
  slices: { key: string; value: number; stroke: string }[]
  total: string // 가운데 숫자 (num 형식)
}) {
  const sum = slices.reduce((a, s) => a + s.value, 0)
  const start = slices.map((_, i) => slices.slice(0, i).reduce((a, s) => a + s.value, 0))
  const mask = useId() // 도넛이 여러 개여도 가림막 id가 겹치지 않게
  return (
    <div className="@container relative aspect-square h-full max-h-[166px]">
      <svg viewBox="0 0 166 166" className="absolute inset-0 size-full -rotate-90" aria-hidden>
        {sum === 0 ? (
          <circle
            cx={83}
            cy={83}
            r={R}
            fill="none"
            strokeWidth={SW}
            className="stroke-ops-idle-soft"
          />
        ) : (
          // 11/13 사용자: 조각마다 따로 채우지 말고 12시부터 한 바퀴 한 번에 — 흰 고리 가림막 하나가 시계 방향으로 열림
          <g mask={`url(#${CSS.escape(mask)})`}>
            {/* 가림막 영역을 그림 전체로 — 기본값(선 굵기 뺀 크기 +10%)이면 고리 바깥 4px가 잘려 각져 보임 */}
            <mask id={mask} maskUnits="userSpaceOnUse" x={0} y={0} width={166} height={166}>
              <circle
                cx={83}
                cy={83}
                r={R}
                fill="none"
                stroke="white"
                strokeWidth={SW + 2}
                strokeDasharray={`${C} ${C}`}
                className="motion-safe:animate-donut-in"
              />
            </mask>
            {slices.map((s, i) =>
              s.value > 0 ? (
                <circle
                  key={s.key}
                  cx={83}
                  cy={83}
                  r={R}
                  fill="none"
                  strokeWidth={SW}
                  className={s.stroke}
                  strokeDasharray={`${Math.max((s.value / sum) * C - GAP, 0.5)} ${C}`}
                  strokeDashoffset={-(start[i] / sum) * C}
                />
              ) : null,
            )}
          </g>
        )}
      </svg>
      {/* 도넛이 작아지면(낮은 화면) 작은 글자는 고리에 걸려서 숫자만 */}
      <div className="absolute inset-0 flex flex-col items-center justify-center text-[12px] text-ops-faint">
        <b className="text-[25px] leading-[33px] tracking-[-0.7px] text-ops-ink">{total}</b>
        <span>건</span>
      </div>
    </div>
  )
}
