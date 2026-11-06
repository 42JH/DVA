import { Fragment, useContext, type ReactNode } from 'react'
import { Link } from 'react-router'
import { GlobalSearch, type SearchProps } from '@/shared/search/GlobalSearch'
import { TopBarInfo } from './topBarInfo'

// 상단바(TopBar) · 경로(Crumbs) — 화면이 본문 맨 위에 직접 그림. handle.title이 있는 화면(새 디자인 전)은 AppLayout이 대신 그림

/** 상단바 세 칸 — 왼쪽(경로 · 제목) | 가운데 검색칸(최대 760) | 오른쪽 상태. 카드 양끝 40 안쪽 (Figma 'FAQ' · 'FAQ 미답변' 11/06)
 *  1440에서 왼쪽 212 · 오른쪽 272 (디자인 검색칸 x 340~1100). 본문도 같은 칸을 쓰면 검색칸 아래로 줄이 맞음 (FAQ 질문 열)
 *  옆 칸은 192 · 240 이상 — 좁은 창(1280)에서 검색칸이 줄어듦 */
export const BAR_COLS =
  '-mx-content grid grid-cols-[minmax(12rem,1fr)_minmax(0,760px)_minmax(15rem,1.28fr)] gap-x-6 px-10'

// 새 상단바 (Figma 'FAQ' 11/06 — 모든 화면 같은 모양, 11/06 사용자) — 경로 · 제목 | 검색칸 | 상태. 화면이 본문 맨 위에 그림
// (본문 위 여백 24를 끌어올려 카드 위에서 36 높이에 가운데가 오게). 정보는 AppLayout이 TopBarInfo로 채워 줌
// 상태 '● 빠른 접수형 AI 상담가 · N건 접수 중' — 오른쪽 끝. 점은 라이브처럼 깜빡임, 0건이면 '접수 중'만. 실시간 연결이 끊기면 점이 회색으로 멈춤
// 예전 오른쪽 'AI 미답변 알림'은 없어짐 — FAQ 화면 왼쪽 아래 '답변 대기 →'로 (11/06 디자인)
// 검색은 공용 탭 검색(shared/search/GlobalSearch), 처음 탭 = 그 화면(기본 주문). 설정 화면은 search={false}
// 뎁스가 있는 화면(통화 상세 · 기업 상세 · 그래프 보기 · AI 미답변)은 crumbs — 왼쪽에 경로, 검색칸 없음 (search를 따로 넘기면 있음)
// center = 검색칸 대신 가운데 칸 (AI 미답변의 자기 검색칸) · extra = 검색칸이 없을 때 가운데 칸 오른쪽 끝 정보 (06 통화 상세의 발신번호)
export function TopBar({
  search,
  crumbs,
  center,
  extra,
}: {
  search?: SearchProps | false
  crumbs?: Crumb[]
  center?: ReactNode
  extra?: ReactNode
}) {
  const { persona, calls, live } = useContext(TopBarInfo)
  // 검색칸: 넘긴 대로. 안 넘기면 경로 화면은 없음 · 나머지는 주문 탭이 먼저
  const box = search ?? (crumbs ? false : ({ tab: 'order' } as const))
  return (
    <header className={`${BAR_COLS} -mt-6 h-18 shrink-0 items-center`}>
      <div className="flex min-w-0 items-center">
        {crumbs && <Crumbs items={crumbs} className="min-w-0 truncate" />}
      </div>
      {center ??
        (box ? <GlobalSearch {...box} /> : <div className="flex min-w-0 justify-end">{extra}</div>)}
      {persona && (
        <span
          title={live ? undefined : '실시간 연결이 끊겨 다시 연결하는 중입니다'}
          className="flex min-w-0 items-center gap-2 justify-self-end text-body font-medium text-brand"
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
    </header>
  )
}

type Crumb = { label: string; to?: string }

// 경로 · 제목 (Figma 'FAQ 미답변' 11/06) — 20 · '통계 > 그래프 보기'. 앞 단계는 링크, 마지막은 지금 화면
export function Crumbs({ items, className = '' }: { items: Crumb[]; className?: string }) {
  return (
    <nav aria-label="경로" className={`text-card text-ink ${className}`}>
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
