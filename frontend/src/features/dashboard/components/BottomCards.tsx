// 아래 줄 두 카드 (02 날짜별 · 페르소나별 같은 모양, 6칸씩 — 10/30 필드별 수정률 뺌)
// AI 미답변: 그 범위에 AI가 답하지 못한 질문, 최신순 8줄(페르소나별 6줄) + 'AI 미답변 보기 ›'(09). 줄은 누를 수 없음 (처리는 09에서)
// 불만 내역: 유형 5줄 + 막대(건수 열 앞까지) + '불만 통화 보기 ›'(04 불만 통화 탭, 같은 기간)
// onMore가 없으면(페르소나별 — 04 · 09에 버전 필터가 없어 숫자가 안 맞음) 아래 링크 줄 자체가 없음

function Card({
  title,
  sub,
  more,
  onMore,
  children,
}: {
  title: string
  sub: string
  more: string
  onMore?: () => void
  children: React.ReactNode
}) {
  return (
    <section className="flex min-h-[460px] flex-col rounded-xl bg-surface ring-1 ring-line ring-inset">
      <div className="px-6 pt-6">
        <h2 className="text-card font-bold">{title}</h2>
        <p className="mt-1 text-label text-sub">{sub}</p>
      </div>
      <div className="flex-1 px-6 pt-5">{children}</div>
      {onMore && (
        <div className="flex h-14 items-center border-t border-line px-6">
          <button
            type="button"
            onClick={onMore}
            className="text-label font-semibold text-action hover:underline"
          >
            {more} ›
          </button>
        </div>
      )}
    </section>
  )
}

const Head = ({ left, right }: { left: string; right: string }) => (
  <div className="flex h-8 items-center justify-between border-b border-line text-caption text-muted">
    <span>{left}</span>
    <span>{right}</span>
  </div>
)

export function UnansweredCard({
  sub,
  timeHeader,
  rows,
  onMore,
}: {
  sub: string
  timeHeader: string
  rows: { key: string; question: string; time: string }[]
  onMore?: () => void
}) {
  return (
    <Card title="AI 미답변" sub={sub} more="AI 미답변 보기" onMore={onMore}>
      {rows.length === 0 ? (
        <p className="py-16 text-center text-body text-muted">AI가 답하지 못한 질문이 없습니다.</p>
      ) : (
        <>
          <Head left="질문" right={timeHeader} />
          <ul>
            {rows.map((r) => (
              <li
                key={r.key}
                className="flex h-[41px] items-center gap-4 border-b border-bg text-label last:border-0"
              >
                <span className="min-w-0 flex-1 truncate">“{r.question}”</span>
                <span className="shrink-0 text-sub">{r.time}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  )
}

export function ComplaintCard({
  sub,
  total,
  rows,
  onMore,
}: {
  sub: string
  total: number
  rows: { key: string; label: string; count: number }[]
  onMore?: () => void
}) {
  const max = Math.max(1, ...rows.map((r) => r.count))
  return (
    <Card title="불만 내역" sub={sub} more="불만 통화 보기" onMore={onMore}>
      {total === 0 ? (
        <p className="py-16 text-center text-body text-muted">불만이 감지된 통화가 없습니다.</p>
      ) : (
        <>
          <Head left="불만 유형" right="건수" />
          <ul>
            {rows.map((r) => (
              <li
                key={r.key}
                className="flex h-[41px] items-center gap-4 border-b border-bg text-label last:border-0"
              >
                <span className="w-[124px] shrink-0">{r.label}</span>
                <span className="min-w-0 flex-1">
                  {r.count > 0 && (
                    <span
                      className="block h-1.5 rounded-full bg-action"
                      style={{ width: `${Math.max(4, (r.count / max) * 100)}%` }}
                    />
                  )}
                </span>
                <span className="w-14 shrink-0 text-right font-semibold">
                  {r.count.toLocaleString('ko-KR')}건
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  )
}
