import { TopBar } from '@/shared/ui'
import { useDashboard } from '@/features/dashboard/hooks/useDashboard'
import { DashboardSearch } from './DashboardSearch'
import { ComplaintCard, DropOffCard, RegistrationCard, WaitCard } from './MetricCards'

// 02 통계 'AI 상담 성능' (Figma 디자인/목업 '통계' 11/05 · 숫자는 대시보드 연동 명세) — 로그인하면 처음 보는 화면 (홈 화면은 없앰, 11/05 사용자)
// 상단바(상태 · 가운데 검색칸 · AI 미답변 알림) · 제목 · 설명 → 카드 네 장: 접수 1건당 소요 시간 · 응답 대기 / 고객 불편 표현 · 단계별 이탈률
// 고객 탭 없이 전체 고객. 응답 대기 · 단계별 이탈률은 [그래프 보기]로 신규 · 기존 비교 화면(GraphPage)
// 스크롤 없이 한 화면: 카드 높이 = 남는 높이의 반씩
export function DashboardPage() {
  const vm = useDashboard()
  return (
    <div className="flex min-h-0 flex-[1_1_0px] flex-col">
      <TopBar search={<DashboardSearch />} />
      <div className="shrink-0 pt-v24">
        <h1 className="text-v24 font-bold">AI 상담 성능</h1>
        <p className="mt-[3px] text-[12px] text-muted">
          어디서 끊기고, 얼마나 오래 걸리는지 한눈에 확인하세요.
        </p>
      </div>
      <div className="mt-v16 grid min-h-0 flex-1 grid-cols-2 grid-rows-2 gap-x-[18px] gap-y-v16">
        <RegistrationCard c={vm.registration} />
        <WaitCard c={vm.wait} />
        <ComplaintCard c={vm.complaint} />
        <DropOffCard c={vm.dropOff} />
      </div>
    </div>
  )
}
