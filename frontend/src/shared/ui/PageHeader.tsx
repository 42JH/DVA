import { Fragment, useContext, type ReactNode } from 'react'
import { Link } from 'react-router'
import { TopBarInfo } from './topBarInfo'

// 상단바 (와이어프레임 16 Page header) — 높이 64 · 제목 28/700 · 아래 구분선 · 왼쪽 여백 32(본문과 같은 선)
// 사이드바처럼 모든 화면에 고정된 틀이라 각 화면이 그리지 않는다. AppLayout이 라우트의 handle.title로 그린다
// 새 디자인 화면(11/04 FAQ부터)은 handle.title 없이 화면이 TopBar · Crumbs를 본문 맨 위에 직접 그린다
export function PageHeader({ title, unanswered }: { title: string; unanswered: number }) {
  return (
    <header className="flex h-16 shrink-0 items-center border-b border-line px-content">
      <h1 className="text-title font-bold">{title}</h1>
      <UnansweredAlert count={unanswered} className="ml-auto" />
    </header>
  )
}

// AI 미답변 알림 (Figma '프레임' 11/04 — 사이드바 'AI 미답변' 옆 빨간 숫자가 여기로). 0건이면 안 보임
// 종 20 + 8 + 글자 16/600. 색은 디자인(#e77f83)이 흰 바탕에서 대비 2.7:1이라 danger(빨강)로
function UnansweredAlert({ count, className = '' }: { count: number; className?: string }) {
  if (!count) return null
  return (
    <Link
      to="/faqs/unanswered"
      className={`flex items-center gap-2 text-body font-semibold text-danger hover:underline ${className}`}
    >
      <svg
        viewBox="0 0 20 20"
        className="size-5 shrink-0"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M7.77778 16.7424C8.36751 17.2135 9.14627 17.5 10 17.5C10.8537 17.5 11.6325 17.2135 12.2222 16.7424M3.75636 14.3182C3.40502 14.3182 3.20878 13.7662 3.42131 13.4595C3.91447 12.7479 4.39046 11.7043 4.39046 10.4475L4.4108 8.62638C4.4108 5.24288 6.91317 2.5 10 2.5C13.1323 2.5 15.6715 5.28328 15.6715 8.71662L15.6512 10.4475C15.6512 11.7129 16.1108 12.7623 16.5839 13.4742C16.7882 13.7816 16.5914 14.3182 16.2444 14.3182H3.75636Z" />
      </svg>
      AI 상담가가 답변하지 못한 문의가 {count}건 있습니다
    </Link>
  )
}

// 새 상단바 (Figma '프레임' · 'FAQ' 11/04) — 날짜 · 상태 | 화면 검색칸(폭 317, 가운데) | AI 미답변 알림. 목록 화면이 본문 맨 위에 그림
// (본문 위 여백 24를 끌어올려 카드 위에서 36 높이에 가운데가 오게). 날짜 외 정보는 AppLayout이 TopBarInfo로 채워 줌
// 상태 '● 빠른 접수형 AI 상담가 · N건 접수 중' — 점은 라이브처럼 깜빡임, 0건이면 '접수 중'만(11/04 사용자). 실시간 연결이 끊기면 점이 회색으로 멈춤
// 좁은 화면(1280)에선 상태 글자가 말줄임 — 검색칸은 늘 가운데
// crumbs = 검색 중이면 날짜 · 상태 자리에 경로('“박스” 검색', 11/04 사용자 — 상세로 가면 '“박스” 검색 > “박스” 검색 상세')
// 04 통화(Figma '통화' 11/04)는 날짜 · 검색이 아래 머리 줄에 있어 상태 · 알림만 (date={false}, search 없음)
export function TopBar({
  search,
  crumbs,
  date = true,
  className = '',
}: {
  search?: ReactNode
  crumbs?: Crumb[]
  date?: boolean
  className?: string // 화면마다 왼쪽 자리 맞춤 (04는 카드 왼쪽 24부터)
}) {
  const { unanswered, persona, calls, live } = useContext(TopBarInfo)
  const today = new Date().toLocaleDateString('ko-KR', {
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  })
  return (
    <header
      className={`-mt-6 grid h-18 shrink-0 grid-cols-[minmax(0,1fr)_317px_minmax(0,1fr)] items-center gap-6 pr-12 pl-2 ${className}`}
    >
      <div className="flex min-w-0 items-center gap-[clamp(16px,3.3vw,48px)]">
        {crumbs ? (
          <Crumbs items={crumbs} className="min-w-0 truncate" />
        ) : (
          date && <span className="shrink-0 text-body text-ink">{today}</span>
        )}
        {!crumbs && persona && (
          <span
            title={live ? undefined : '실시간 연결이 끊겨 다시 연결하는 중입니다'}
            className="flex min-w-0 items-center gap-2 text-body font-medium text-brand"
          >
            <span
              aria-hidden
              className={`size-3 shrink-0 rounded-full ${live ? 'bg-brand motion-safe:animate-blink' : 'bg-muted'}`}
            />
            <span className="truncate">
              {persona} AI 상담가 · {calls ? `${calls}건 ` : ''}접수 중
            </span>
          </span>
        )}
      </div>
      {search ?? <span />}
      <UnansweredAlert count={unanswered} className="justify-self-end" />
    </header>
  )
}

type Crumb = { label: string; to?: string }

// 경로 (Figma 'FAQ 상세' · 'FAQ 작성' · 'FAQ 수정' 11/04) — 28 · 'FAQ > FAQ 상세'. 앞 단계는 링크, 마지막은 지금 화면
export function Crumbs({ items, className = '' }: { items: Crumb[]; className?: string }) {
  return (
    <nav aria-label="경로" className={`text-v28 text-ink ${className}`}>
      {items.map((c, i) => (
        <Fragment key={c.label}>
          {i > 0 && (
            <span aria-hidden className="mx-2">
              &gt;
            </span>
          )}
          {c.to ? (
            <Link to={c.to} className="hover:text-brand">
              {c.label}
            </Link>
          ) : (
            <span aria-current="page">{c.label}</span>
          )}
        </Fragment>
      ))}
    </nav>
  )
}
