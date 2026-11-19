// 통계 — AI 상담 성능 카드 네 장(접수 소요 · 응답 대기 · 고객 불편 · 단계별 이탈). 숫자 · 그래프는 기존 카드 그대로
// 기업 피드백: 통계는 운영 정보 다음 — 그래서 메뉴 '관리' 쪽에 두고, 오늘 화면엔 요약 숫자만. 검색칸은 없음 (통계에 주문 검색은 필요 없다는 검토)
import { useDashboard } from '@/features/stats/hooks/useDashboard'
import { ComplaintCard, DropOffCard, RegistrationCard, WaitCard } from './MetricCards'
import { useRef } from 'react'
import { PageHead } from '@/shared/ui'
import { useKeepScroll } from '@/shared/lib/keepScroll'

export function StatsPage() {
  const vm = useDashboard()
  const box = useRef<HTMLDivElement>(null)
  useKeepScroll(box, 'page')
  return (
    <>
      <PageHead title="통계">
        <span className="text-[13px] text-ops-sub">AI 상담이 어디서 끊기고, 얼마나 걸리는지</span>
      </PageHead>
      <div
        ref={box}
        className="grid min-h-0 flex-1 grid-cols-2 grid-rows-2 gap-4 overflow-y-auto px-6 py-4 max-xl:grid-cols-1 max-xl:grid-rows-none"
      >
        <RegistrationCard c={vm.registration} />
        <WaitCard c={vm.wait} />
        <ComplaintCard c={vm.complaint} />
        <DropOffCard c={vm.dropOff} />
      </div>
    </>
  )
}
