import { Crumbs, TopBar } from '@/shared/ui'
import type { CustomerType } from '@/features/dashboard/api/dashboardApi'
import { useDashboardGraph, type GraphKind } from '@/features/dashboard/hooks/useDashboardGraph'
import { CUSTOMER_LABEL } from '@/features/dashboard/labels'
import { GroupedBars } from './Charts'

// 02 대시보드 '그래프 보기' (Figma '통계 · 응답 대기에 쓰인 통화시간' · '통계 · 단계별 이탈률' 11/05)
// 경로 '통계 > 그래프 보기' · 제목 24/700 · 설명 12 → 큰 그래프 상자(옅은 바탕 · 모서리 10 · 안쪽 24/28/20)
//   그래프 제목 16/700 · 단위 | 고객군 평균(이름 13/700 · 숫자 34/700 + 단위 · 설명 12) | 묶음 막대 | 집계 기준 · [신규 고객] [기존 고객]
// 오른쪽 아래 [신규 고객] [기존 고객]은 누르는 버튼이 아니라 색 안내(범례) — 어느 색이 어느 고객군 막대인지 (11/05 사용자)
// 신규 = 파랑(brand), 기존 = 회색(sub). 클래스 이름은 글자 그대로 (Tailwind가 찾게)
const SERIES = [
  { key: 'NEW', on: 'bg-brand text-white', bar: 'bg-brand', text: 'text-brand' },
  { key: 'EXISTING', on: 'bg-sub text-white', bar: 'bg-sub', text: 'text-sub' },
] as const satisfies readonly { key: CustomerType; on: string; bar: string; text: string }[]

export function GraphPage({ kind }: { kind: GraphKind }) {
  const vm = useDashboardGraph(kind)
  const data = SERIES.map((s) => ({ ...s, d: vm[s.key] }))
  const ready = data.every((s) => s.d)

  return (
    <div className="flex min-h-0 flex-[1_1_0px] flex-col">
      <TopBar />
      <Crumbs items={[{ label: '통계', to: '/dashboard' }, { label: '그래프 보기' }]} />
      <div className="shrink-0 pt-v44">
        <h1 className="text-v24 font-bold">{vm.title}</h1>
        <p className="mt-[3px] text-[12px] text-muted">
          신규·기존 고객을 함께 보거나, 한 유형만 선택해 비교하세요.
        </p>
      </div>

      <section className="mt-3 flex min-h-0 flex-1 flex-col gap-v16 rounded-[10px] bg-bg px-7 pt-6 pb-5">
        <header className="flex shrink-0 items-center justify-between">
          <h2 className="text-body font-bold">{vm.chart}</h2>
          <span className="text-[12px] text-muted">단위: {vm.unit}</span>
        </header>

        {ready ? (
          <>
            <div className="flex shrink-0 gap-8">
              {data.map(({ key, text, d }) => (
                <div key={key} className="min-w-0 flex-1">
                  <p className={`text-[13px] font-bold ${text}`}>{vm.name(CUSTOMER_LABEL[key])}</p>
                  <p className="flex items-center gap-1.5">
                    <b className={`text-[34px] leading-[38px] tabular-nums ${text}`}>
                      {d!.headline}
                    </b>
                    {d!.headline !== '—' && (
                      <span className="text-label text-muted">{vm.headUnit}</span>
                    )}
                  </p>
                  <p className="text-[12px] text-muted">{d!.sub}</p>
                </div>
              ))}
            </div>
            <GroupedBars
              groups={vm.groups}
              barWidth={vm.barWidth}
              series={data.map(({ key, bar, text, d }) => ({
                key,
                bar,
                text,
                values: d!.values,
                labels: d!.labels,
              }))}
            />
          </>
        ) : (
          <p className="m-auto text-body text-muted">
            {vm.failed ? (
              <>
                불러오지 못했습니다.{' '}
                <button
                  type="button"
                  onClick={vm.retry}
                  className="font-semibold text-brand hover:underline"
                >
                  다시 시도
                </button>
              </>
            ) : (
              '불러오는 중…'
            )}
          </p>
        )}

        <footer className="flex shrink-0 items-center justify-between gap-4">
          <p className="min-w-0 text-[11px] text-muted">{vm.foot}</p>
          <ul aria-label="범례" className="flex shrink-0 gap-2">
            {SERIES.map((s) => (
              <li
                key={s.key}
                className={`grid h-8 w-26 place-items-center rounded text-label font-bold ${s.on}`}
              >
                {CUSTOMER_LABEL[s.key]}
              </li>
            ))}
          </ul>
        </footer>
      </section>
    </div>
  )
}
