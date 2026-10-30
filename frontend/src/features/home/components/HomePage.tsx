import { Link } from 'react-router'
import { Button, SearchBox, Table, TwoLines, type Column } from '@/shared/ui'
import { useHome, type UnansweredRow } from '@/features/home/hooks/useHome'
import { TodayStatCard } from './TodayStatCard'

// 01 홈 (와이어프레임 01_홈, 10/30) — 검색칸 → 오늘 숫자(카드 4 + 평균 2) → 처리할 AI 미답변 6줄
export function HomePage() {
  const vm = useHome()

  const columns: Column<UnansweredRow>[] = [
    {
      key: 'time',
      header: '통화 시작 시각',
      width: 180,
      cell: (r) => <span className="text-sub">{r.time}</span>,
    },
    {
      key: 'customer',
      header: '고객 · 발신번호',
      width: 170,
      cell: (r) => <TwoLines top={r.name} bottom={r.phone} />,
    },
    { key: 'question', header: '질문', cell: (r) => <p className="truncate">{r.question}</p> },
  ]

  return (
    <div className="flex flex-col gap-8">
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

      <Table
        head={
          <>
            <h2 className="flex items-baseline gap-3.5 text-card font-bold">
              처리할 AI 미답변
              {vm.unansweredCount !== undefined && (
                <span className="text-label font-normal text-sub">{vm.unansweredCount}개</span>
              )}
            </h2>
            <Link to={vm.unansweredAllLink} className="text-label font-bold text-action">
              자세히 보기 ›
            </Link>
          </>
        }
        columns={columns}
        rows={vm.rows}
        rowKey={(r) => r.callSeq}
        onRowClick={vm.openUnanswered}
        loading={vm.isUnansweredLoading}
        empty={vm.unansweredError ?? '처리할 AI 미답변이 없습니다.'}
      />
    </div>
  )
}

