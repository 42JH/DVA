// v2 운영 콘솔 틀 (11/06 실험) — 왼쪽 글자 메뉴(처리할 건수 같이) + 오른쪽 화면. 화면 위 줄(제목 · 상태)은 화면이 PageHead로 그림
import type { ReactNode } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigation } from 'react-router'
import logo from '@/shared/assets/logo-dva.png'
import { Icon, type IconName } from './ui'
import { ShellContext, useShell, useShellState } from './useShell'

type Item = {
  to: string
  label: string
  icon: IconName
  count?: number | null
  live?: boolean
}

export function V2Layout() {
  const s = useShellState()
  const { pathname } = useLocation()
  const nav = useNavigation()
  const groups: { title: string; items: Item[] }[] = [
    {
      title: '운영',
      items: [
        { to: '/v2', label: '홈', icon: 'home' },
        { to: '/v2/orders', label: '주문', icon: 'box', count: s.incomplete },
        {
          to: '/v2/calls',
          label: '통화',
          icon: 'phone',
          count: s.liveCalls || null,
          live: !!s.liveCalls,
        },
        {
          to: '/v2/unanswered',
          label: '미답변 문의',
          icon: 'inbox',
          count: s.unanswered,
        },
      ],
    },
    {
      title: '관리',
      items: [
        { to: '/v2/faqs', label: 'FAQ', icon: 'book' },
        { to: '/v2/customers', label: '고객', icon: 'users' },
        { to: '/v2/companies', label: '기업', icon: 'building' },
        { to: '/v2/personas', label: 'AI 상담가', icon: 'bot' },
        { to: '/v2/stats', label: '통계', icon: 'chart' },
      ],
    },
    {
      title: '설정',
      items: [
        // 관리자 권한 관리는 최고 관리자만 (라우트 가드와 짝)
        ...(s.isSystemAdmin ? [{ to: '/v2/admins', label: '관리자', icon: 'users' as const }] : []),
        { to: '/v2/me', label: '내 정보', icon: 'gear' },
      ],
    },
  ]

  return (
    <ShellContext.Provider value={s}>
      <div className="flex h-full bg-ops-paper text-ops-ink">
        <nav
          aria-label="메뉴"
          className="flex w-52 shrink-0 flex-col border-r border-ops-line bg-white max-xl:w-44"
        >
          {/* 로고를 누르면 홈 */}
          <Link
            to="/v2"
            aria-label="홈으로"
            className="flex h-14 items-center gap-2 px-5 outline-none focus-visible:ring-2 focus-visible:ring-ops-route focus-visible:ring-inset"
          >
            <img src={logo} alt="DVA" className="w-9" />
            <span className="text-[13px] font-semibold text-ops-sub">운영 콘솔</span>
          </Link>
          <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-3 pt-2 pb-4">
            {groups.map((g) => (
              <div key={g.title}>
                <p className="px-2 pb-1 text-[12px] font-medium text-ops-faint">{g.title}</p>
                <ul className="flex flex-col gap-0.5">
                  {g.items.map((it) => (
                    <li key={it.to}>
                      <NavLink
                        to={it.to}
                        end={it.to === '/v2'}
                        className={({ isActive }) =>
                          `flex h-9 items-center gap-2.5 rounded-md px-2 text-[14px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ops-route ${isActive ? 'bg-ops-route-soft text-ops-route' : 'text-ops-ink hover:bg-ops-paper'}`
                        }
                      >
                        <Icon name={it.icon} className="size-[18px]" />
                        <span className="flex-1">{it.label}</span>
                        {it.live && (
                          <span
                            aria-hidden
                            className="size-2 rounded-full bg-ops-route motion-safe:animate-blink"
                          />
                        )}
                        {it.count != null && it.count > 0 && (
                          <span className="text-[12px] font-semibold text-ops-sub tabular-nums">
                            {it.count}
                          </span>
                        )}
                      </NavLink>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 border-t border-ops-line px-4 py-3">
            <NavLink
              to="/v2/me"
              className="min-w-0 flex-1 truncate text-[13px] font-medium hover:text-ops-route"
            >
              {s.name}
            </NavLink>
            <button
              type="button"
              onClick={s.logout}
              aria-label="로그아웃"
              className="grid size-7 place-items-center rounded text-ops-sub hover:bg-ops-paper hover:text-ops-ink"
            >
              <Icon name="out" />
            </button>
          </div>
        </nav>
        {/* overflow-hidden: 화면이 바뀔 때 새 화면이 6px 아래에서 떠오르는데(animate-page-in), 그만큼 창 밖으로 삐져나가
          창 스크롤바가 잠깐 생겼다 사라지며 화면 폭이 출렁였음 → 본문 밖은 잘라 냄 (스크롤은 화면마다 안쪽 상자에서) */}
        <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* 화면을 받는 동안(처음 여는 화면 코드) 위쪽 가는 막대 — 눌렀는데 반응이 없어 보이지 않게 */}
          {nav.state === 'loading' && (
            <span
              aria-hidden
              className="absolute top-0 right-0 left-0 z-30 h-0.5 origin-left bg-ops-route motion-safe:animate-load-bar"
            />
          )}
          {/* 경로가 바뀌면 새 화면이 살짝 떠오름 (같은 화면 안 쪽 · 필터 · 패널은 안 움직임) */}
          <div
            key={pathname}
            className="flex min-h-0 min-w-0 flex-1 flex-col motion-safe:animate-page-in"
          >
            <Outlet />
          </div>
        </main>
      </div>
    </ShellContext.Provider>
  )
}

/** 화면 위 줄 — 제목 · 오른쪽 끝 AI 상담가 상태. children = 제목 옆 도구(검색 · 추가 등) */
/** 화면 위 줄 — 상세 화면은 back을 주면 제목 앞에 '<' (누르면 그 목록으로) */
export function PageHead({
  title,
  back,
  children,
}: {
  title: string
  back?: { to: string; label: string } // label = 화면 낭독용 '통화 목록으로'
  children?: ReactNode
}) {
  const s = useShell()
  return (
    <header className="flex h-14 shrink-0 items-center gap-4 border-b border-ops-line bg-white px-6">
      <h1 className="flex items-center gap-1 text-[18px] font-bold">
        {back && (
          <Link
            to={back.to}
            aria-label={back.label}
            title={back.label}
            className="-ml-2 grid size-8 place-items-center rounded-md text-ops-sub hover:bg-ops-paper hover:text-ops-ink"
          >
            <Icon name="chevron" className="size-5 rotate-90" />
          </Link>
        )}
        {title}
      </h1>
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
      {s.persona && (
        <span
          title={s.live ? undefined : '실시간 연결이 끊겨 다시 연결하는 중입니다'}
          className="flex items-center gap-2 text-[13px] font-medium text-ops-sub"
        >
          <span
            aria-hidden
            className={`size-2 rounded-full ${s.live ? 'bg-ops-done' : 'bg-ops-faint'}`}
          />
          <span>{s.persona} AI 상담가</span>
          <span className="ml-2 text-ops-ink tabular-nums">통화 중 {s.liveCalls ?? 0}건</span>
        </span>
      )}
    </header>
  )
}
