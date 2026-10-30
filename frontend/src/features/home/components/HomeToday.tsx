import { Button, SearchBox } from '@/shared/ui'
import { useHome } from '@/features/home/hooks/useHome'
import { TodayStatCard } from './TodayStatCard'

// 01 홈 위쪽 (와이어프레임 01_홈, 10/30) — 검색칸 → 오늘 숫자(카드 4 + 평균 2). 아래 AI 미답변은 app/routes/HomePage가 붙임
export function HomeToday() {
  const vm = useHome()

  return (
    <>
      <form
        className="flex gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          vm.search()
        }}
      >
        <SearchBox
          value={vm.q}
          onChange={vm.setQ}
          placeholder="디버 접수번호 · 주문 번호 · 이름 · 전화번호 · 주소"
          className="flex-1"
        />
        <Button kind="primary" type="submit" className="h-12!">
          검색
        </Button>
      </form>

      <section className="flex flex-col gap-4">
        <h2 className="flex items-baseline gap-3.5 text-card font-bold">
          오늘
          <span className="text-label font-normal text-sub">
            {vm.todayLabel} 0시부터 지금까지 · 통화 시작 시각 기준
          </span>
        </h2>
        <div className="flex items-center gap-7">
          {vm.cards.map((c) => (
            <TodayStatCard key={c.kind} card={c} />
          ))}
          <div className="flex shrink-0 gap-10 pl-5">
            {vm.averages.map((a) => (
              <div key={a.label} className="flex flex-col gap-2">
                <span className="text-label font-bold text-sub">{a.label}</span>
                <span className="flex items-baseline gap-1">
                  <span className="text-[32px] leading-[1.4] font-bold text-ink">{a.value}</span>
                  <span className="text-label font-bold text-sub">{a.unit}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
        {vm.todayError && <p className="text-label text-danger">{vm.todayError}</p>}
      </section>
    </>
  )
}
