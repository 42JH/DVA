// 통계 '그래프 보기' — 위 줄은 다른 상세처럼 ‹ 제목 (‹ = 통계로). 그래프 상자는 기존 화면과 같은 GraphChart
import { Navigate, useParams } from 'react-router'
import { GraphChart } from './GraphPage'
import { useDashboardGraph, type GraphKind } from '@/features/stats/hooks/useDashboardGraph'
import { PageHead } from '@/shared/ui'

const KINDS: GraphKind[] = ['response-wait', 'stage-dropoffs']

export function StatsGraphPage() {
  const kind = useParams().kind as GraphKind
  if (!KINDS.includes(kind)) return <Navigate to="/stats" replace />
  return <Graph kind={kind} />
}

function Graph({ kind }: { kind: GraphKind }) {
  const vm = useDashboardGraph(kind)
  return (
    <>
      <PageHead title={vm.title} back={{ to: '/stats', label: '통계로' }}>
        <span className="text-[13px] text-ops-sub">
          신규 · 기존 고객을 함께 보거나, 한 유형만 골라 비교하세요.
        </span>
      </PageHead>
      <div className="flex min-h-0 flex-1 flex-col px-6 py-4">
        <GraphChart kind={kind} />
      </div>
    </>
  )
}
