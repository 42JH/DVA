import { useEffect, useRef, useState } from 'react'
import { NavLink, useLocation } from 'react-router'
import { ExitGhost } from '@/shared/lib/useExitGhost'
import { MENU, type MenuIcon } from './menu'

// 사이드바 (와이어프레임 15 Sidebar · 10/20 확정 메뉴) — 폭 222 · 머리 64(로고 + '관리자' + 접기 28) · 줄 44(아이콘 16 + 14 + 글자) · 하위 줄 40
// 11/01 Gmail식: 줄은 왼쪽 끝에서 시작해 오른쪽만 둥근 알약(선택 = 옅은 남색 · 굵게, 마우스 = 회색), 접고 펼 때 폭이 미끄러짐, 하위는 안내선 없이 더 들여쓴 알약
// 하위가 있는 메뉴(상세내역 · FAQ 관리)는 ▾로 펼침. 하위가 선택되면 위 메뉴는 글자만 진하게
// 하위 메뉴 옆 빨간 숫자(AI 미답변 22)는 badges로 받기만 함 — 숫자를 세는 건 features(app이 넘겨줌, shared는 features를 모름)
// 접으면(머리 오른쪽 버튼 · 1280 아래 기본) 폭 72 아이콘 줄: 줄 48×44 가운데 아이콘, 펼치기 버튼 가운데
// 로그아웃은 맨 아래

const ICON: Record<MenuIcon | 'collapse' | 'expand', React.ReactNode> = {
  home: <path d="M3 8.5l7-5.5 7 5.5V17H3zM8 17v-5h4v5" />,
  chart: <path d="M3 17h14M6 14V9M10 14V4M14 14V7" />,
  list: (
    <>
      <path d="M7 5h10M7 10h10M7 15h10" />
      <circle cx="3.5" cy="5" r="1" fill="currentColor" stroke="none" />
      <circle cx="3.5" cy="10" r="1" fill="currentColor" stroke="none" />
      <circle cx="3.5" cy="15" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  building: (
    <path d="M4 17V3h12v14M8 6.5h1M11 6.5h1M8 9.5h1M11 9.5h1M8 12.5h1M11 12.5h1M8 17v-3h4v3" />
  ),
  sliders: (
    <>
      <path d="M3 6h14M3 14h14" />
      <circle cx="7" cy="6" r="1.7" fill="white" />
      <circle cx="13" cy="14" r="1.7" fill="white" />
    </>
  ),
  faq: (
    <>
      <circle cx="10" cy="10" r="7.5" />
      <path d="M7.8 8a2.2 2.2 0 1 1 3.2 2c-.7.4-1 .8-1 1.5M10 14h.01" />
    </>
  ),
  shield: <path d="M10 2.5l6 2.5v5c0 4-2.6 6.3-6 7.5-3.4-1.2-6-3.5-6-7.5V5z" />,
  user: (
    <>
      <circle cx="10" cy="6.5" r="3" />
      <path d="M4 17c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5" />
    </>
  ),
  logout: <path d="M8 3H4.5A1.5 1.5 0 0 0 3 4.5v11A1.5 1.5 0 0 0 4.5 17H8M12 13l3-3-3-3M15 10H7" />,
  collapse: <path d="M3 4.5h14v11H3zM8 4.5v11M13.5 8l-2 2 2 2" />,
  expand: <path d="M3 4.5h14v11H3zM8 4.5v11M11.5 8l2 2-2 2" />,
}

function Icon({ name }: { name: keyof typeof ICON }) {
  return (
    <svg
      viewBox="0 0 20 20"
      className="size-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {ICON[name]}
    </svg>
  )
}

type Sub = { to: string; label: string }

export function Sidebar({
  onLogout,
  canSee = () => true,
  badges = {},
}: {
  onLogout: () => void
  canSee?: (to: string) => boolean // 역할에 따라 숨길 메뉴 (예: 관리자 권한 관리는 최고 관리자만). 기본은 전부
  badges?: Record<string, number> // 하위 메뉴 경로 → 빨간 숫자 (0이면 안 그림)
}) {
  const { pathname } = useLocation()
  const inGroup = (subs: Sub[]) => subs.some((s) => pathname.startsWith(s.to))
  // 펼친 그룹 (그룹 이름 → 펼침). 처음엔 지금 경로가 들어 있는 그룹만 펼침
  const [open, setOpen] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(MENU.filter((m) => m.subs).map((m) => [m.label, inGroup(m.subs!)])),
  )
  // 다른 화면에서 그룹 안 화면으로 오면(02 · 06의 'AI 미답변 보기' 등) 그 그룹을 펼침. 사용자가 접은 다른 그룹은 그대로
  // (사이드바는 화면을 옮겨도 다시 안 그려져 처음 값만으론 부족 — 렌더 중에 경로 바뀜을 보고 고침, React 문서 방식)
  const [seenPath, setSeenPath] = useState(pathname)
  if (seenPath !== pathname) {
    setSeenPath(pathname)
    const g = MENU.find((m) => m.subs && inGroup(m.subs))
    if (g && !open[g.label]) setOpen({ ...open, [g.label]: true })
  }
  // 1280 아래(반응형 규칙 10/23)에선 접힌 채로 시작. 그 뒤는 사용자가 버튼으로
  const [collapsed, setCollapsed] = useState(() => window.matchMedia('(max-width: 1279px)').matches)
  const [fly, setFly] = useState<string | null>(null) // 접힌 채 그룹을 누르면 옆에 뜨는 하위 메뉴 (사이드바는 그대로 접힌 채)
  const [flyTop, setFlyTop] = useState(0) // 옆 메뉴의 화면 y — 누른 그룹 줄 위에 맞춤 (fixed라 직접 잡아 줌)
  const navRef = useRef<HTMLElement>(null)
  const flyRef = useRef<HTMLUListElement>(null) // 옆 메뉴 — 닫힐 때 사라지는 애니메이션은 안의 <ExitGhost> (11/02 사용자: 열리고 닫히는 전환)
  // 옆 메뉴가 떠 있을 때 다른 곳을 누르거나 Esc → 닫힘. 화면을 덮는 막을 쓰지 않음 — 막은 다음 클릭(펼치기 버튼 · 다른 메뉴)까지 먹어서
  // "눌러도 안 열림"이 됐음 (11/02 사용자). 사이드바 안 클릭은 각 버튼이 알아서 처리(그룹 다시 누르면 닫힘, 펼치기는 setFly(null))
  useEffect(() => {
    if (!fly) return
    // 옆 메뉴 자신과 그걸 연 그룹 버튼 말고는 어디를 눌러도 닫힘 — 다른 메뉴(홈 · 기업관리 …)를 눌러도 떠 있던 문제 (11/02 사용자)
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element
      if (t.closest('[role="menu"]')) return
      if (t.closest<HTMLElement>('[data-fly-owner]')?.dataset.flyOwner === fly) return
      setFly(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFly(null)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [fly])
  // '/faqs'(FAQ 목록)는 '/faqs/unanswered'에서도 켜지면 안 됨 → 더 깊은 형제가 있는 하위만 경로가 딱 맞을 때 켬
  const isEnd = (s: Sub, subs: Sub[]) => subs.some((o) => o !== s && o.to.startsWith(s.to + '/'))
  const subLabel = (s: Sub) => (
    <>
      <span className="truncate">{s.label}</span>
      {!!badges[s.to] && (
        // 와이어프레임 red_badge: 높이 24 · 빨강 바탕 · 흰 숫자
        <span className="ml-2 grid h-6 min-w-6 place-items-center rounded-full bg-danger px-2 text-caption font-bold text-white">
          {badges[s.to]}
        </span>
      )}
    </>
  )

  // 줄 (11/01 Gmail식 알약): 펼침 = 왼쪽 끝 0..210, 오른쪽만 둥글게 (pl 28 → 아이콘 28, 글자 58) · 접힘 = 12..60 동그라미 (아이콘 x 28로 같음 → 접힐 때 아이콘이 안 움직임)
  const row = (active: boolean, bold: boolean) =>
    `flex h-10 items-center text-body ${collapsed ? 'ml-3 w-12 justify-center rounded-full' : 'gap-3.5 rounded-r-full pr-3 pl-7'} ${
      active
        ? 'bg-action-soft font-bold text-action'
        : bold
          ? 'font-semibold text-action'
          : 'text-sub hover:bg-bg'
    }`
  const label = (text: string) => (collapsed ? null : <span className="truncate">{text}</span>)
  const toggleBtn = (name: 'collapse' | 'expand', onClick: () => void) => (
    <button
      type="button"
      onClick={onClick}
      aria-label={name === 'collapse' ? '메뉴 접기' : '메뉴 펼치기'}
      className="relative grid size-7 shrink-0 place-items-center rounded-md text-sub ring-1 ring-line ring-inset after:absolute after:-inset-1 after:content-[''] hover:bg-bg" // after: 판정 36 (보이는 건 28)
    >
      <Icon name={name} />
    </button>
  )

  return (
    <nav
      ref={navRef}
      // 접고 펼 때 폭이 미끄러짐 (Gmail식, 11/01). overflow-hidden: 줄어드는 동안 글자가 밖으로 안 삐져나옴
      className={`flex h-full shrink-0 flex-col overflow-hidden border-r border-line bg-surface transition-[width] duration-200 ease-out ${collapsed ? 'w-[72px]' : 'w-sidebar'}`}
    >
      {collapsed ? (
        <div className="flex h-16 items-center justify-center">
          {toggleBtn('expand', () => {
            setCollapsed(false)
            setFly(null)
          })}
        </div>
      ) : (
        // whitespace-nowrap: 폭이 미끄러지는 동안 '관리자'가 세로로 꺾이지 않게 (잘리기만 함)
        <div className="flex h-16 items-center gap-2.5 pr-6 pl-6 whitespace-nowrap">
          <NavLink to="/" className="text-strong font-bold text-brand" aria-label="홈으로">
            dver
          </NavLink>
          <span className="text-label font-semibold text-sub">관리자</span>
          <span className="ml-auto">{toggleBtn('collapse', () => setCollapsed(true))}</span>
        </div>
      )}

      <ul className={`flex flex-col gap-1 pt-3 ${collapsed ? '' : 'pr-3'}`}>
        {MENU.filter((m) => canSee(m.to)).map((m) =>
          m.subs ? (
            <li key={m.label} className="relative">
              <button
                type="button"
                title={collapsed ? m.label : undefined}
                data-fly-owner={m.label}
                aria-expanded={collapsed ? fly === m.label : !!open[m.label]}
                onClick={(e) => {
                  if (collapsed) {
                    setFlyTop(e.currentTarget.getBoundingClientRect().top)
                    setFly((f) => (f === m.label ? null : m.label))
                  } else setOpen((o) => ({ ...o, [m.label]: !o[m.label] }))
                }}
                className={`${row(collapsed && inGroup(m.subs), inGroup(m.subs))} ${collapsed ? '' : 'w-full'}`} // 접히면 w-12 동그라미 그대로 (w-full이면 오른쪽으로 밀림)
              >
                <Icon name={m.icon} />
                {label(m.label)}
                {!collapsed && (
                  // 펼침 화살표 — 글자(▾)가 아니라 16 칸 아이콘, 펼치면 뒤집음
                  <svg
                    viewBox="0 0 20 20"
                    className={`ml-auto size-4 stroke-sub transition-transform duration-200 ${open[m.label] ? 'rotate-180' : ''}`}
                    fill="none"
                    strokeWidth={1.6}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d="M5 8l5 5 5-5" />
                  </svg>
                )}
              </button>
              {collapsed && fly === m.label && (
                <>
                  <ul
                    role="menu"
                    // fixed: nav가 overflow-hidden(폭 슬라이드용)이라 absolute면 72px 밖이 잘려 안 보였음 (11/02 사용자 "접혔을 때 주문 내역 · 통화 내역이 안 열려"). 왼쪽 = 접힌 폭 72 + 8
                    ref={flyRef}
                    className="fixed z-50 w-48 origin-top-left rounded-xl bg-surface p-2 shadow-[0_12px_40px_rgba(43,47,54,0.16)] ring-1 ring-line ring-inset motion-safe:animate-pop-in"
                    style={{ left: 80, top: flyTop }}
                  >
                    <ExitGhost target={flyRef} />
                    {m.subs.map((s) => (
                      <li key={s.to}>
                        <NavLink
                          to={s.to}
                          end={isEnd(s, m.subs!)}
                          onClick={() => setFly(null)}
                          className={({ isActive }) =>
                            `flex h-9 items-center rounded-lg px-3 text-label whitespace-nowrap ${isActive ? 'bg-action-soft font-bold text-action' : 'text-sub hover:bg-bg'}`
                          }
                        >
                          {subLabel(s)}
                        </NavLink>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {open[m.label] && !collapsed && (
                // 하위 줄도 알약 (안내선 없음, Gmail식) · 하위 글자 x=58 (위 메뉴 글자와 같은 자리). 펼칠 때 떠오름
                <ul className="mt-1 flex flex-col gap-1 motion-safe:animate-page-in">
                  {m.subs.map((s) => (
                    <li key={s.to}>
                      <NavLink
                        to={s.to}
                        end={isEnd(s, m.subs!)}
                        className={({ isActive }) =>
                          `flex h-9 items-center rounded-r-full pr-3 pl-[58px] text-label ${isActive ? 'bg-action-soft font-bold text-action' : 'text-sub hover:bg-bg'}`
                        }
                      >
                        {subLabel(s)}
                      </NavLink>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ) : (
            <li key={m.to}>
              <NavLink
                to={m.to}
                end={m.to === '/'}
                title={collapsed ? m.label : undefined}
                className={({ isActive }) => row(isActive, false)}
              >
                <Icon name={m.icon} />
                {label(m.label)}
              </NavLink>
            </li>
          ),
        )}
      </ul>

      {/* 위 메뉴 줄과 같은 좌우 여백 → 로그아웃 글자도 메뉴 글자와 같은 x. 로그인 아이디는 안 보임 (10/30 사용자) */}
      <div className={`mt-auto flex flex-col gap-1 pb-6 ${collapsed ? '' : 'pr-3'}`}>
        <button
          type="button"
          onClick={onLogout}
          title={collapsed ? '로그아웃' : undefined}
          className={`${row(false, false)} ${collapsed ? '' : 'w-full text-left'}`}
        >
          <Icon name="logout" />
          {label('로그아웃')}
        </button>
      </div>
    </nav>
  )
}
