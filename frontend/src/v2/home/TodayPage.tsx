// v2 홈 (11/06 실험): 운영팀이 출근해서 먼저 여는 화면. 위에서부터 처리할 일, 지금 상황(최근 통화, 미완료, 미답변), AI 상담 성능
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { PageHead } from '@/v2/V2Layout'
import { useToday } from './useToday'

const TONE_TEXT = { idle: 'text-ops-ink', stop: 'text-ops-stop', wait: 'text-ops-wait' }

export function TodayPage() {
  const vm = useToday()
  return (
    <>
      <PageHead title="홈">
        <dl className="flex shrink-0 gap-5 text-[13px] whitespace-nowrap text-ops-sub">
          <div className="flex gap-1.5">
            <dt>오늘 주문</dt>
            <dd className="font-semibold text-ops-ink tabular-nums">
              {vm.ordersToday?.toLocaleString('ko-KR') ?? '…'}건
            </dd>
          </div>
          <div className="flex gap-1.5">
            <dt>오늘 통화</dt>
            <dd className="font-semibold text-ops-ink tabular-nums">
              {vm.callsToday?.toLocaleString('ko-KR') ?? '…'}건
            </dd>
          </div>
        </dl>
      </PageHead>
      {/* 화면 폭 · 높이를 다 씀 (1920에서 가운데만 쓰던 것) — 가운데 세 칸이 남는 높이를 채우고, 줄은 들어가는 만큼 */}
      <div className="min-h-0 flex-1 [scrollbar-width:thin] overflow-y-auto px-6 py-5">
        <div className="flex h-full flex-col gap-6 max-xl:h-auto">
          <section aria-label="처리할 일">
            <h2 className="mb-2 text-[14px] font-bold">처리할 일</h2>
            {/* 한 상자 안 네 칸 — 칸을 누르면 그 조건의 목록. 건수가 있으면 상태 색, 없으면 흐리게 */}
            <ul className="grid grid-cols-4 divide-x divide-ops-line overflow-hidden rounded-lg border border-ops-line bg-white max-xl:grid-cols-2 max-xl:divide-x-0">
              {vm.queue.map((q) => (
                <li key={q.label}>
                  <Link
                    to={q.to}
                    className="flex h-full flex-col gap-1 px-5 py-4 outline-none hover:bg-ops-paper focus-visible:bg-ops-route-soft"
                  >
                    <span className="text-[13px] font-medium text-ops-sub">{q.label}</span>
                    <span
                      className={`text-[24px] leading-8 font-bold tabular-nums ${q.count ? TONE_TEXT[q.tone] : 'text-ops-faint'}`}
                    >
                      {q.count ?? '…'}
                    </span>
                    <span className="text-[12px] text-ops-faint">{q.hint}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>

          <div className="grid min-h-0 flex-1 grid-cols-3 gap-3 max-xl:flex-none max-xl:grid-cols-1">
            <Panel
              title="최근 통화"
              more="/v2/calls"
              extra={vm.live ? `통화 중 ${vm.live}건` : undefined}
            >
              {vm.calls.map((c) => (
                <Line key={c.seq} to={`/v2/calls/${c.seq}`} at={c.at}>
                  <span className="text-ops-sub tabular-nums">#{c.seq}</span>
                  <span className="truncate font-medium">{c.name}</span>
                  {c.live && (
                    <span className="shrink-0 text-[12px] font-semibold text-ops-route">
                      통화 중
                    </span>
                  )}
                  {c.complaint && (
                    <span className="shrink-0 text-[12px] font-semibold text-ops-stop">불만</span>
                  )}
                </Line>
              ))}
            </Panel>
            <Panel title="미완료 주문" more="/v2/orders?g=COLLECTING">
              {vm.incomplete.length === 0 && <Empty>미완료 주문이 없습니다.</Empty>}
              {vm.incomplete.map((o) => (
                <Line key={o.seq} to={o.to} at={o.at}>
                  <span className="font-semibold tabular-nums">{o.no}</span>
                  <span className="truncate">{o.who}</span>
                  <span className="truncate text-ops-sub tabular-nums">{o.phone}</span>
                </Line>
              ))}
            </Panel>
            <Panel title="미답변 문의" more="/v2/unanswered">
              {vm.unanswered.length === 0 && <Empty>답하지 못한 질문이 없습니다.</Empty>}
              {vm.unanswered.map((u) => (
                <Line
                  key={u.seq}
                  to={`/v2/calls/${u.call}`}
                  state={{ unanswered: u.seq }}
                  at={u.at}
                >
                  <span className="truncate">“{u.question}”</span>
                </Line>
              ))}
            </Panel>
          </div>

          <section aria-label="AI 상담 성능">
            <div className="mb-2 flex items-baseline justify-between">
              <h2 className="text-[14px] font-bold">AI 상담 성능</h2>
              <Link
                to="/v2/stats"
                className="text-[13px] font-medium text-ops-route hover:underline"
              >
                그래프로 보기
              </Link>
            </div>
            <dl className="grid grid-cols-4 divide-x divide-ops-line rounded-lg border border-ops-line bg-white max-xl:grid-cols-2 max-xl:divide-x-0">
              {vm.perf.map((p) => (
                <div key={p.label} className="px-5 py-4">
                  <dt className="text-[12px] text-ops-sub">{p.label}</dt>
                  <dd className="mt-1 text-[20px] font-bold tabular-nums">{p.value}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      </div>
    </>
  )
}

function Panel({
  title,
  more,
  extra,
  children,
}: {
  title: string
  more: string
  extra?: string
  children: ReactNode
}) {
  return (
    <section className="flex min-h-0 flex-col rounded-lg border border-ops-line bg-white">
      <header className="flex h-11 items-center gap-2 border-b border-ops-line px-4">
        <h2 className="text-[14px] font-bold">{title}</h2>
        {extra && <span className="text-[12px] font-semibold text-ops-route">{extra}</span>}
        <Link
          to={more}
          className="ml-auto flex items-center gap-0.5 text-[12px] font-medium text-ops-sub hover:text-ops-ink"
        >
          전체 보기
        </Link>
      </header>
      {/* 줄바꿈 묶음 + 넘침 숨김 → 칸 높이에 다 들어가는 줄만 보이고 잘린 줄은 안 보임 */}
      <ul className="flex min-h-0 flex-1 flex-col flex-wrap content-start overflow-hidden py-1 max-xl:max-h-64 [&>li]:w-full">
        {children}
      </ul>
    </section>
  )
}

function Line({
  to,
  state,
  at,
  children,
}: {
  to: string
  state?: unknown
  at: string
  children: ReactNode
}) {
  return (
    <li>
      <Link
        to={to}
        state={state}
        className="flex h-10 items-center gap-2 px-4 text-[13px] hover:bg-ops-paper"
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
        <span className="shrink-0 text-[12px] text-ops-faint tabular-nums">{at}</span>
      </Link>
    </li>
  )
}

const Empty = ({ children }: { children: ReactNode }) => (
  <li className="flex h-full items-center justify-center px-4 py-6 text-center text-[13px] text-ops-faint">
    {children}
  </li>
)
