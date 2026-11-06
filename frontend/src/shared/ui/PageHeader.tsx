import { Fragment, useContext, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router'
import { unansweredTo } from '@/shared/lib/unansweredReason'
import { GlobalSearch, type SearchProps } from '@/shared/search/GlobalSearch'
import { TopBarInfo } from './topBarInfo'

// 상단바(TopBar) · 경로(Crumbs) — 화면이 본문 맨 위에 직접 그림. handle.title이 있는 화면(새 디자인 전)은 AppLayout이 대신 그림
// AI 미답변 알림 (Figma '프레임' 11/04 — 사이드바 'AI 미답변' 옆 빨간 숫자가 여기로). 0건이면 안 보임
// 종 20 + 8 + 글자 16/600. 색은 디자인(#e77f83)이 흰 바탕에서 대비 2.7:1이라 danger(빨강)로
function UnansweredAlert({ count, className = '' }: { count: number; className?: string }) {
  const { pathname, search } = useLocation()
  if (!count) return null
  return (
    <Link
      // 미답변 화면 경로 첫 칸 = 이 화면 (11/05 사용자: 이동 전 위치). 미답변 화면 안에선 그대로
      to={pathname === '/faqs/unanswered' ? pathname + search : unansweredTo(pathname + search)}
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
      {/* 좁은 창(1280 미만)에선 짧게 — 긴 문장은 두 줄로 꺾여 상단바가 높아짐 (11/05 반응형) */}
      <span className="hidden xl:inline">AI 상담가가 답변하지 못한 문의가 {count}건 있습니다</span>
      <span className="xl:hidden">AI 미답변 {count}건</span>
    </Link>
  )
}

// 새 상단바 (Figma '프레임' · 'FAQ' · '통화' 11/04 → 11/06 주문 시안) — 경로 · AI 미답변 알림 | 검색칸(폭 320, 가운데) | 상태. 화면이 본문 맨 위에 그림
// (본문 위 여백 24를 끌어올려 카드 위에서 36 높이에 가운데가 오게). 정보는 AppLayout이 TopBarInfo로 채워 줌
// 상태 '● 빠른 접수형 AI 상담가 · N건 접수 중' — 점은 라이브처럼 깜빡임, 0건이면 '접수 중'만(11/04 사용자). 실시간 연결이 끊기면 점이 회색으로 멈춤
// 날짜는 뺌 (11/04 사용자 — 04 통화처럼 FAQ도). 상태는 카드 왼쪽 24부터(Figma '통화'), 좁은 화면(1280)에선 말줄임 — 검색칸은 늘 가운데
// 11/05 사용자: 모든 화면 같은 모양 — 검색은 공용 탭 검색(shared/search/GlobalSearch), 처음 탭 = 그 화면(기본 주문). 설정 화면은 search={false}
// 뎁스가 있는 화면(통화 상세 · FAQ 상세 · 작성 · 수정 · AI 미답변 · 기업 상세 · 그래프 보기)은 crumbs — 상태 자리에 경로, 검색칸 없음 (11/05 사용자 이미지)
// FAQ 목록은 검색 중일 때만 crumbs('FAQ > “박스” 검색') + 검색칸 그대로
// extra = 검색칸 자리(가운데 칸) 오른쪽에 붙는 화면 정보 — 검색칸이 없을 때만 (06 통화 상세의 발신번호, 11/05 사용자 이미지)
// wide = FAQ 화면들 (Figma 'FAQ' · 'FAQ 미답변' 11/06) — 검색칸 760(x 340~1100) · 칸은 BAR_COLS(본문 질문 열과 줄 맞춤) · 왼쪽은 경로만(알림 대신 FAQ '답변 대기 →')
// center = 검색칸 대신 가운데 칸 (AI 미답변 문의의 자기 검색칸)
export function TopBar({
  search,
  crumbs,
  extra,
  center,
  wide,
}: {
  search?: SearchProps | false
  crumbs?: Crumb[]
  extra?: ReactNode
  center?: ReactNode
  wide?: boolean
}) {
  const { unanswered, persona, calls, live } = useContext(TopBarInfo)
  // 검색칸: 넘긴 대로. 안 넘기면 경로 화면은 없음 · 나머지는 주문 탭이 먼저
  const box = search ?? (crumbs ? false : ({ tab: 'order' } as const))
  return (
    // 11/06 시안(주문 '프레임' 1521:7385): 가운데 검색칸(폭 320) · 오른쪽 끝 상태 '● 빠른 접수형 AI 상담가 · N건 접수 중'
    // 왼쪽 = 경로(뎁스 화면) 또는 AI 미답변 알림 — 시안엔 알림이 없지만 AI 미답변 화면으로 가는 길이 이것뿐이라 남김(사용자 확인 중)
    // 검색칸 가운데 = 화면 가운데(시안 1440에서 560~880): 왼쪽 칸 = 50vw − 160 − 상단바 왼쪽 끝(88) − 사이(24). 상태는 카드 오른쪽 20 앞까지(-mr-3)
    <header
      className={`-mt-6 h-18 shrink-0 items-center ${wide ? BAR_COLS : '-mr-3 -ml-4 grid grid-cols-[calc(50vw-272px)_320px_minmax(0,1fr)] gap-6 pl-2'}`}
    >
      <div className="flex min-w-0 items-center">
        {crumbs ? (
          <Crumbs items={crumbs} className={`min-w-0 truncate ${wide ? 'text-card' : ''}`} />
        ) : (
          !wide && <UnansweredAlert count={unanswered} className="min-w-0" />
        )}
      </div>
      {center ??
        (box ? (
          <GlobalSearch {...box} />
        ) : (
          // 검색칸이 없는 화면은 가운데 칸 오른쪽에 화면 정보 (06 발신번호)
          <div className="flex min-w-0 justify-end">{extra}</div>
        ))}
      <div className="flex min-w-0 justify-end">
        {persona && (
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
    </header>
  )
}

/** wide 상단바 세 칸 — 왼쪽(경로) | 가운데 검색칸(최대 760) | 오른쪽 상태. 카드 양끝 40 안쪽 (Figma 'FAQ' · 'FAQ 미답변' 11/06)
 *  1440에서 왼쪽 212 · 오른쪽 272 (디자인 검색칸 x 340~1100). FAQ 본문도 같은 칸을 써서 질문 열이 검색칸 아래로 줄이 맞음
 *  옆 칸은 192 · 240 이상 — 좁은 창(1280)에서 검색칸이 줄어듦 */
export const BAR_COLS =
  '-mx-content grid grid-cols-[minmax(12rem,1fr)_minmax(0,760px)_minmax(15rem,1.28fr)] gap-x-6 px-10'

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
