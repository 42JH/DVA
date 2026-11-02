import { FilterBar, SearchBox } from '@/shared/ui'
import { useHome } from '@/features/home/hooks/useHome'
import { TodayStatCard } from './TodayStatCard'

// 01 홈 위쪽 (와이어프레임 01_홈, 10/30) — 검색칸 → 오늘 숫자(카드 4 + 평균 2). 아래 AI 미답변은 app/routes/HomePage가 붙임
export function HomeToday() {
  const vm = useHome()

  return (
    <>
      {/* 다른 목록의 검색칸과 같은 모양 (11/02 사용자): FilterBar · 버튼 없이 Enter로 검색 · 최근 검색어 · 칠 때 추천. 검색은 03 주문 내역으로 */}
      <FilterBar>
        <SearchBox
          value={vm.q}
          onChange={vm.setQ}
          onSubmit={vm.search}
          recentKey="home"
          suggestions={vm.suggestions}
          onPick={vm.searchFor}
          placeholder="이름 · 전화번호 · 주소" // 가는 곳(03 주문 내역) 검색과 같은 범위 — 주문 번호 · 디버 접수번호는 03 검색이 못 찾음
          className="min-w-0 flex-1"
        />
      </FilterBar>

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
                {/* 값이 있으면 큰 숫자 + 작은 단위 (위 카드의 '건'과 같게), 없으면 '—' + 이유 */}
                {a.value ? (
                  <span className="flex items-baseline gap-1">
                    {a.value.map(([v, u]) => (
                      <span key={u} className="mr-1">
                        <span className="text-[32px] leading-[1.4] font-bold text-ink">{v}</span>
                        <span className="ml-0.5 text-label font-bold text-sub">{u}</span>
                      </span>
                    ))}
                  </span>
                ) : (
                  <span className="flex items-baseline gap-2">
                    <span className="text-[32px] leading-[1.4] font-bold text-muted">—</span>
                    {a.note && <span className="text-caption text-muted">{a.note}</span>}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
        {vm.todayError && <p className="text-label text-danger">{vm.todayError}</p>}
      </section>
    </>
  )
}
