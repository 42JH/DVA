import { useState } from 'react'
import { NavLink, useLocation } from 'react-router'
import { MENU, type MenuIcon } from './menu'

// 사이드바 (와이어프레임 15 Sidebar · 10/20 확정 메뉴) — 폭 222 · 머리 64(로고 + '관리자' + 접기 28) · 줄 44(아이콘 16 + 14 + 글자) · 하위 줄 40
// '상세내역'은 하위 3개(주문 내역 · 통화 내역 · 통화 문의)를 ▾로 펼침. 하위가 선택되면 위 메뉴는 글자만 진하게
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

export function Sidebar({
  userLabel,
  onLogout,
  canSee = () => true,
}: {
  userLabel?: string
  onLogout: () => void
  canSee?: (to: string) => boolean // 역할에 따라 숨길 메뉴 (예: 관리자 권한 관리는 슈퍼바이저만). 기본은 전부
}) {
  const { pathname } = useLocation()
  const inDetail = MENU[2].subs!.some((s) => pathname.startsWith(s.to))
  const [open, setOpen] = useState(inDetail)
  // 1280 아래(반응형 규칙 10/23)에선 접힌 채로 시작. 그 뒤는 사용자가 버튼으로
  const [collapsed, setCollapsed] = useState(() => window.matchMedia('(max-width: 1279px)').matches)
  const [fly, setFly] = useState(false) // 접힌 채 상세내역을 누르면 옆에 뜨는 하위 메뉴 (사이드바는 그대로 접힌 채)

  // 줄: 펼침 = 4..218 (pl 24 → 아이콘 28, 글자 58) · 접힘 = 48×44 가운데
  const row = (active: boolean, bold: boolean) =>
    `flex h-11 items-center rounded-lg text-body ${collapsed ? 'w-12 justify-center' : 'gap-3.5 pr-3 pl-6'} ${
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
      className="grid size-7 shrink-0 place-items-center rounded-md text-sub ring-1 ring-line ring-inset hover:bg-bg"
    >
      <Icon name={name} />
    </button>
  )

  return (
    <nav
      className={`flex h-full shrink-0 flex-col border-r border-line bg-surface ${collapsed ? 'w-[72px]' : 'w-sidebar'}`}
    >
      {collapsed ? (
        <div className="flex h-16 items-center justify-center">
          {toggleBtn('expand', () => {
            setCollapsed(false)
            setFly(false)
          })}
        </div>
      ) : (
        <div className="flex h-16 items-center gap-2.5 pr-6 pl-6">
          <span className="text-strong font-bold text-brand">dver</span>
          <span className="text-label font-semibold text-sub">관리자</span>
          <span className="ml-auto">{toggleBtn('collapse', () => setCollapsed(true))}</span>
        </div>
      )}

      <ul className={`flex flex-col gap-1 pt-3 ${collapsed ? 'px-3' : 'px-1'}`}>
        {MENU.filter((m) => canSee(m.to)).map((m) =>
          m.subs ? (
            <li key={m.label} className="relative">
              <button
                type="button"
                title={collapsed ? m.label : undefined}
                aria-expanded={collapsed ? fly : open}
                onClick={() => (collapsed ? setFly((f) => !f) : setOpen((o) => !o))}
                className={`${row(collapsed && inDetail, inDetail)} w-full`}
              >
                <Icon name={m.icon} />
                {label(m.label)}
                {!collapsed && (
                  // 펼침 화살표 — 글자(▾)가 아니라 16 칸 아이콘, 펼치면 뒤집음
                  <svg
                    viewBox="0 0 20 20"
                    className={`ml-auto size-4 stroke-sub ${open ? 'rotate-180' : ''}`}
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
              {collapsed && fly && (
                <>
                  {/* 바깥을 누르면 닫힘 */}
                  <div className="fixed inset-0 z-40" onClick={() => setFly(false)} />
                  <ul
                    role="menu"
                    className="absolute top-0 left-full z-50 ml-2 w-44 rounded-xl bg-surface p-2 shadow-[0_12px_40px_rgba(43,47,54,0.16)] ring-1 ring-line ring-inset"
                  >
                    {m.subs.map((s) => (
                      <li key={s.to}>
                        <NavLink
                          to={s.to}
                          onClick={() => setFly(false)}
                          className={({ isActive }) =>
                            `flex h-10 items-center rounded-lg px-3 text-label whitespace-nowrap ${isActive ? 'bg-action-soft font-bold text-action' : 'text-sub hover:bg-bg'}`
                          }
                        >
                          {s.label}
                        </NavLink>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {open && !collapsed && (
                // 안내선 x=20(4 + 16) · 하위 글자 x=58 (위 메뉴 글자와 같은 자리)
                <ul className="ml-4 flex flex-col gap-1 border-l border-line">
                  {m.subs.map((s) => (
                    <li key={s.to}>
                      <NavLink
                        to={s.to}
                        className={({ isActive }) =>
                          `flex h-10 items-center rounded-lg pr-3 pl-[37px] text-label ${isActive ? 'bg-action-soft font-bold text-action' : 'text-sub hover:bg-bg'}`
                        }
                      >
                        {s.label}
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

      {/* 위 메뉴 줄과 같은 좌우 여백 → 로그아웃 글자도 메뉴 글자와 같은 x */}
      <div className={`mt-auto flex flex-col gap-1 pb-6 ${collapsed ? 'px-3' : 'px-1'}`}>
        {userLabel && !collapsed && (
          <span className="truncate pl-6 text-caption text-muted">{userLabel}</span>
        )}
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
