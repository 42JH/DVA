import { slideClass, useSlideDir } from '@/shared/lib/useSlideDir'
import { DateField, Tabs } from '@/shared/ui'
import { useDashboard } from '@/features/dashboard/hooks/useDashboard'
import { AvgCard } from './AvgCard'
import { ComplaintCard, UnansweredCard } from './BottomCards'
import { ResultCard } from './ResultCard'
import { VersionTable } from './VersionTable'

// 02 대시보드 (와이어프레임 02, 10/30 최종) — 1줄 탭 [날짜별 | 페르소나별(최고 관리자만)] + 오른쪽 끝(날짜별 = 날짜 칸, 페르소나별 = 고른 버전의 운영 기간)
// 날짜별: 통화 결과(8칸) · 평균(4칸) / AI 미답변 · 불만 내역(6칸씩). 페르소나별: 버전별 기록 / 고른 버전의 두 카드
export function DashboardPage() {
  const vm = useDashboard()
  const slide = slideClass(useSlideDir(vm.tabs.findIndex((t) => t.key === vm.tab))) // 탭을 바꾸면 카드들이 그 방향에서 미끄러져 들어옴 (11/01)

  const right =
    vm.tab === 'date' ? (
      <DateField compact value={vm.range} onChange={vm.setRange} />
    ) : (
      vm.persona && <span className="text-label text-sub">{vm.persona.header}</span>
    )

  return (
    <div className="flex flex-col gap-6">
      <Tabs items={vm.tabs} value={vm.tab} onChange={vm.setTab} right={right} />

      <div
        key={vm.tab}
        className={`flex flex-col gap-6 transition-opacity ${slide} ${vm.isFetching ? 'opacity-50' : ''}`}
      >
        {vm.error ? (
          <p className="py-16 text-center text-body text-muted">{vm.error}</p>
        ) : vm.isLoading ? (
          <p className="py-16 text-center text-body text-muted">불러오는 중…</p>
        ) : vm.tab === 'date' && vm.date ? (
          <>
            <div className="grid grid-cols-12 gap-6">
              <ResultCard
                className="col-span-8"
                scope={vm.date.scope}
                total={vm.date.total}
                rate={vm.date.rate}
                base={vm.date.base}
                gauge={vm.date.gauge}
                rows={vm.date.rows}
                unanalysed={vm.date.unanalysed}
              />
              <AvgCard className="col-span-4" items={vm.date.avgs} />
            </div>
            <div className="grid grid-cols-2 gap-6">
              <UnansweredCard {...vm.date.unanswered} />
              <ComplaintCard {...vm.date.complaints} />
            </div>
          </>
        ) : vm.tab === 'persona' && vm.persona ? (
          <>
            <VersionTable rows={vm.persona.rows} note={vm.persona.note} />
            {vm.persona.cards && (
              <div className="grid grid-cols-2 gap-6">
                <UnansweredCard {...vm.persona.cards.unanswered} />
                <ComplaintCard {...vm.persona.cards.complaints} />
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  )
}
