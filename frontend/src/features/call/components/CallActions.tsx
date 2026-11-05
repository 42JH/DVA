import { useRef, type ReactNode } from 'react'
import type { CallActionKind } from '@/features/call/api/callDto'
import type { ActionView } from '@/features/call/hooks/useCallDetail'
import { useFollowScroll, useSlidingMark } from '@/features/call/hooks/useFollowScroll'

// 06 AI 동작 기록 (11/05 새 디자인 오른쪽) — 아이콘 + 서버 요약 한 줄 ('보내는 분 이름 = 강도윤' · '주소 검색 ... → 1건' · '전송 완료')
// 아이콘: 조회 = 명부 · 저장 = 디스켓 · 검색 = 돋보기 · 전송 = 보내기 화살표 · 취소 = ✕. 이 목록만 스크롤
// 하이라이트: 지금 짚은 말(재생 중 · 고른 말)이 부른 동작들 = 옅은 하늘색 상자 하나가 미끄러져 옮겨 감 (11/05 사용자: 대본처럼 AI 동작도). 재생 중엔 가운데로 따라감
// 줄을 누르면 대본이 그 동작을 부른 고객 말로 넘어가고 녹취가 그 말부터 (11/01). 시각을 모르는 줄은 누를 수 없음
const svg = (d: ReactNode) => (
  <svg
    viewBox="0 0 24 24"
    className="size-6 shrink-0"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.7}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    {d}
  </svg>
)
const LOOKUP = svg(
  <>
    <rect x="5" y="3" width="15" height="18" rx="2" />
    <path d="M3 7h4M3 12h4M3 17h4M10 8h6M10 12h6M10 16h4" />
  </>,
)
const SAVE = svg(
  <>
    <path d="M5 3h11l4 4v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 1-2z" />
    <path d="M8 3v5h7V3M8 21v-6h8v6" />
  </>,
)
const SEARCH = svg(
  <>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-4-4" />
  </>,
)
const SEND = svg(<path d="M14 5l7 7-7 7M21 12H11a7 7 0 0 0-7 7" />)
const CANCEL = svg(<path d="M6 6l12 12M18 6L6 18" />)
const ICON: Record<CallActionKind, ReactNode> = {
  CUSTOMER_LOOKUP: LOOKUP,
  ORDER_LOOKUP: LOOKUP,
  FIELD_SAVED: SAVE,
  PIN_SEARCH: SEARCH,
  PREVIOUS_ORDER_SEARCH: SEARCH,
  FAQ_SEARCH: SEARCH,
  ADDRESS_SEARCH: SEARCH,
  ORDER_SUBMITTED: SEND,
  ORDER_CANCELLED: CANCEL,
}

export function CallActions({
  className = '',
  actions,
  follow,
  emptyText,
}: {
  className?: string
  actions: ActionView[]
  follow: boolean // 재생 중 — 하이라이트 동작을 따라 스크롤
  emptyText: string // 받는 중 · 못 받음 · 없음
}) {
  const list = useRef<HTMLUListElement>(null)
  const touched = useFollowScroll(list, actions.find((a) => a.active)?.key ?? null, follow)
  const mark = useSlidingMark(
    list,
    actions.filter((a) => a.active).map((a) => a.key),
  )
  return (
    <ul
      ref={list}
      onWheel={touched}
      onTouchMove={touched}
      aria-label="AI 동작"
      className={`relative flex min-h-0 [scrollbar-width:thin] [scrollbar-color:var(--color-line)_transparent] flex-col overflow-y-auto pr-2 ${className}`}
    >
      {/* 하이라이트 상자 — 줄 사이를 미끄러져 옮겨 감 (useSlidingMark) */}
      <li
        ref={mark}
        aria-hidden
        className="pointer-events-none absolute top-0 right-2 left-0 rounded-xl bg-frame opacity-0 transition-[transform,height,opacity] duration-500 ease-out motion-reduce:transition-none"
      />
      {actions.length === 0 && <li className="py-6 text-body text-muted">{emptyText}</li>}
      {actions.map((a) => {
        const row = `flex w-full items-center gap-3 relative rounded-lg px-2 py-2 text-left text-strong transition-colors duration-300`
        const cells = (
          <>
            {ICON[a.kind]}
            <span className="min-w-0 break-words">{a.text}</span>
          </>
        )
        return (
          <li key={a.key} data-key={a.key}>
            {a.onClick ? (
              <button
                type="button"
                onClick={a.onClick}
                title="이 동작을 부른 고객 말로 가기 · 거기부터 듣기"
                aria-current={a.active || undefined}
                className={`${row} ${a.active ? '' : 'hover:bg-bg'}`}
              >
                {cells}
              </button>
            ) : (
              <div className={row}>{cells}</div>
            )}
          </li>
        )
      })}
    </ul>
  )
}
