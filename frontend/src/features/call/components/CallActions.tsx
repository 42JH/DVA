import { Tag } from '@/shared/ui'
import type { ActionView, ResultView } from '@/features/call/hooks/useCallDetail'

// 처리 내용 (06 오른쪽, 11/05 새 디자인) — 이 통화가 한 일
// 위: 결과 카드(하늘색 — 주문 상세 창 카드와 같은 색) — 굵은 종류 · 회색 통화 안 시각 · 오른쪽 파랑 링크
//     접수 · 주문 취소 → '주문 보기 ›'(팝업), AI 미답변 → 사유 태그 + 질문 + 'AI 미답변 보기 ›'(09). 상담원 이관 요청은 링크 없음 (연결 성공이 아니라 요청 기록)
// 아래: 'AI 동작 n'(서버 전체 건수) — 시각 · 칩 · 내용. 길면 이 목록만 스크롤
//     칩 색 = 04 상담 유형 칩 색: 전송 = 접수 파랑 · 조회 = 노랑 · 취소 = 분홍 · 검색 = FAQ 남보라, 저장(칸 채우기)은 회색
//     줄을 누르면 왼쪽 스크립트가 그 동작을 부른 고객 말로 넘어가고 녹취가 그 말부터 (11/01). 시각을 모르는 줄은 누를 수 없음
const ACTION_BG: Record<string, string> = {
  전송: 'bg-kind-accept',
  조회: 'bg-kind-lookup',
  취소: 'bg-kind-cancel',
  검색: 'bg-kind-faq',
  저장: 'bg-bg',
}

export function CallActions({
  className = '',
  results,
  actions,
  count,
  resultsEmpty,
  actionsEmpty,
}: {
  className?: string
  results: ResultView[]
  actions: ActionView[]
  count: number
  resultsEmpty: string // 카드가 없을 때 (받는 중 · 못 받음 · 없음)
  actionsEmpty: string
}) {
  return (
    <section className={`flex min-h-0 flex-col ${className}`}>
      <h2 className="shrink-0 text-strong font-bold">처리 내용</h2>

      <ul className="mt-3 flex shrink-0 flex-col gap-2">
        {results.length === 0 && (
          <li className="rounded-xl bg-frame px-5 py-4 text-body text-muted">{resultsEmpty}</li>
        )}
        {results.map((r) => (
          <li key={r.key} className="rounded-xl bg-frame px-5 py-4">
            <div className="flex items-center gap-3">
              <span className="text-strong font-bold">{r.label}</span>
              {r.reason && <Tag kind={r.reason.kind}>{r.reason.label}</Tag>}
              <span className="text-label text-sub tabular-nums">{r.time}</span>
              {r.link && (
                <button
                  type="button"
                  onClick={r.link.onClick}
                  className="ml-auto shrink-0 text-body font-semibold text-brand hover:underline"
                >
                  {r.link.label} ›
                </button>
              )}
            </div>
            {r.question && (
              <p className="mt-2 flex gap-3 text-body">
                <span className="shrink-0 text-sub">질문</span>
                <span className="min-w-0 break-words">{r.question}</span>
              </p>
            )}
          </li>
        ))}
      </ul>

      <h3 className="mt-6 flex shrink-0 items-baseline gap-2 text-strong font-bold">
        AI 동작 <span className="text-body font-normal text-sub">{count}</span>
      </h3>
      <ul className="mt-2 min-h-0 flex-1 [scrollbar-width:thin] [scrollbar-color:var(--color-line)_transparent] overflow-y-auto pr-2">
        {actions.length === 0 && <li className="py-6 text-body text-muted">{actionsEmpty}</li>}
        {actions.map((a) => {
          const row = (
            <>
              <span className="w-12 shrink-0 text-label leading-7 text-sub tabular-nums">
                {a.time}
              </span>
              <span
                className={`grid h-7 min-w-12 shrink-0 place-items-center px-2 text-label ${ACTION_BG[a.tag] ?? 'bg-bg'}`}
              >
                {a.tag}
              </span>
              <span className="min-w-0 text-body leading-7 break-words">{a.text}</span>
            </>
          )
          return (
            <li key={a.key}>
              {a.onClick ? (
                <button
                  type="button"
                  onClick={a.onClick}
                  title="이 동작을 부른 고객 말로 가기 · 거기부터 듣기"
                  className="flex w-full items-start gap-3 rounded-lg px-2 py-1 text-left hover:bg-bg"
                >
                  {row}
                </button>
              ) : (
                <div className="flex items-start gap-3 px-2 py-1">{row}</div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
