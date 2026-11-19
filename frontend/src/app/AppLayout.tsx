// 화면 틀 — 왼쪽 글자 메뉴(처리할 건수 같이) + 오른쪽 화면. 화면 위 줄(제목 · 상태)은 화면이 PageHead로 그림
import { lazy, Suspense, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigation } from 'react-router'
import logo from '@/shared/assets/logo-dva.webp'
import { Icon, type IconName } from '@/shared/ui'
import { Confirm } from '@/shared/ui/Modal'
import { ShellContext, type Shell } from '@/shared/lib/shell'
import { useTrackHistory } from '@/shared/lib/keepScroll'
import { useHasPledge } from '@/features/persona/hooks/pledgeStore'
import { useShellState } from './useShellState'

// AI 상담가 '모두 통과하면 반영' 약속 지켜보기 — 약속이 있을 때만 불러옴 (시험 창구 코드가 첫 화면 묶음에 들어가지 않게)
const ApplyAfterTest = lazy(() =>
  import('@/features/persona/components/ApplyAfterTest').then((m) => ({
    default: m.ApplyAfterTest,
  })),
)

type MenuItem = {
  to: string
  label: string
  icon: IconName
  count?: number | null
  live?: boolean
}

/** 왼쪽 메뉴 묶음 — 운영 · 관리 · 설정 */
function menuGroups(shell: Shell): { title: string; items: MenuItem[] }[] {
  return [
    {
      title: '운영',
      items: [
        { to: '/', label: '홈', icon: 'home' },
        // 주문 옆 숫자는 뺌 ('주문 72'가 주문 수로 읽힘. 미완료는 홈 '처리할 일' · 주문 미완료 탭에서)
        { to: '/orders', label: '주문', icon: 'box' },
        {
          to: '/calls',
          label: '통화',
          icon: 'phone',
          count: shell.liveCalls || null,
          live: !!shell.liveCalls,
        },
        { to: '/unanswered', label: '미답변 문의', icon: 'inbox', count: shell.unanswered },
      ],
    },
    {
      title: '관리',
      items: [
        { to: '/faqs', label: 'FAQ', icon: 'book' },
        { to: '/customers', label: '고객', icon: 'users' },
        { to: '/companies', label: '기업', icon: 'building' },
        { to: '/personas', label: 'AI 상담가', icon: 'bot' },
        { to: '/stats', label: '통계', icon: 'chart' },
      ],
    },
    {
      title: '설정',
      items: [
        // 관리자 권한 관리는 최고 관리자만 (라우트 가드와 짝)
        ...(shell.isSystemAdmin
          ? [{ to: '/admins', label: '관리자', icon: 'users' as const }]
          : []),
        { to: '/me', label: '내 정보', icon: 'gear' },
      ],
    },
  ]
}

export function AppLayout() {
  const shell = useShellState()
  const { pathname } = useLocation()
  const navigation = useNavigation()
  useTrackHistory()
  const hasPledge = useHasPledge() // 시험이 모두 통과하면 반영 — 어느 화면에 있든 (AI 상담가 1번)

  return (
    <ShellContext.Provider value={shell}>
      <div className="flex h-full bg-ops-paper text-ops-ink">
        <SideNav shell={shell} />
        {/* overflow-hidden: 화면이 바뀔 때 새 화면이 6px 아래에서 떠오르는데(animate-page-in), 그만큼 창 밖으로 삐져나가
          창 스크롤바가 잠깐 생겼다 사라지며 화면 폭이 출렁였음 → 본문 밖은 잘라 냄 (스크롤은 화면마다 안쪽 상자에서) */}
        <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* 화면을 받는 동안(처음 여는 화면 코드) 위쪽 가는 막대 — 눌렀는데 반응이 없어 보이지 않게 */}
          {navigation.state === 'loading' && (
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
      {hasPledge && (
        <Suspense fallback={null}>
          <ApplyAfterTest />
        </Suspense>
      )}
    </ShellContext.Provider>
  )
}

/** 왼쪽 메뉴 — 로고 · 메뉴 묶음 · 아래 계정 줄(이름 · 로그아웃) */
function SideNav({ shell }: { shell: Shell }) {
  const [askLogout, setAskLogout] = useState(false) // 로그아웃은 한 번 더 물음 (잘못 누르면 바로 나가짐)
  return (
    <nav
      aria-label="메뉴"
      className="flex w-52 shrink-0 flex-col border-r border-ops-line bg-white max-xl:w-44"
    >
      {/* 로고를 누르면 홈 */}
      <Link
        to="/"
        // 읽기용 이름에 보이는 글자(DVA 운영 콘솔)가 들어가야 음성 명령으로도 누름 (Lighthouse 접근성)
        aria-label="DVA 운영 콘솔 홈"
        className="flex h-14 items-center gap-2 px-5 outline-none focus-visible:ring-2 focus-visible:ring-ops-route focus-visible:ring-inset"
      >
        {/* 크기를 적어 두면 그림이 늦게 와도 옆 글자가 밀리지 않음. 파일은 표시 폭의 2배(72px) */}
        <img src={logo} alt="DVA" width={36} height={14} className="w-9" />
        <span className="text-[13px] font-semibold text-ops-sub">운영 콘솔</span>
      </Link>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-3 pt-2 pb-4">
        {menuGroups(shell).map((group) => (
          <div key={group.title}>
            <p className="px-2 pb-1 text-[12px] font-medium text-ops-faint">{group.title}</p>
            <ul className="flex flex-col gap-0.5">
              {group.items.map((item) => (
                <li key={item.to}>
                  <MenuLink item={item} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 border-t border-ops-line px-4 py-3">
        <NavLink
          to="/me"
          className="min-w-0 flex-1 truncate text-[13px] font-medium hover:text-ops-route"
        >
          {shell.name}
        </NavLink>
        <button
          type="button"
          onClick={() => setAskLogout(true)}
          aria-label="로그아웃"
          className="grid size-7 place-items-center rounded text-ops-sub hover:bg-ops-paper hover:text-ops-ink"
        >
          <Icon name="out" />
        </button>
      </div>
      {askLogout && (
        <Confirm
          title="로그아웃할까요?"
          ok="로그아웃"
          onOk={() => {
            setAskLogout(false)
            shell.logout()
          }}
          onClose={() => setAskLogout(false)}
        />
      )}
    </nav>
  )
}

const menuLinkClass = ({ isActive }: { isActive: boolean }) =>
  `flex h-9 items-center gap-2.5 rounded-md px-2 text-[14px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ops-route ${isActive ? 'bg-ops-route-soft text-ops-route' : 'text-ops-ink hover:bg-ops-paper'}`

/** 메뉴 한 줄 — 아이콘 · 이름 · (통화 중이면 깜빡이는 점) · 건수 */
function MenuLink({ item }: { item: MenuItem }) {
  return (
    <NavLink to={item.to} end={item.to === '/'} className={menuLinkClass}>
      <Icon name={item.icon} className="size-[18px]" />
      <span className="flex-1">{item.label}</span>
      {item.live && (
        <span aria-hidden className="size-2 rounded-full bg-ops-route motion-safe:animate-blink" />
      )}
      {item.count != null && item.count > 0 && (
        <span className="text-[12px] font-semibold text-ops-sub tabular-nums">{item.count}</span>
      )}
    </NavLink>
  )
}
