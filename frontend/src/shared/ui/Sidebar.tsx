import { useState } from 'react'
import { NavLink, useLocation } from 'react-router'
import { MENU } from './menu'

// 사이드바 (와이어프레임 15 Sidebar · 10/20 확정 메뉴) — 폭 222 · 머리 64(로고 + '관리자' + 접기) · 줄 44 · 하위 줄 40
// '상세내역'은 하위 3개(주문 내역 · 통화 내역 · 통화 문의)를 ▾로 펼침. 하위가 선택되면 위 메뉴는 글자만 진하게
// 로그아웃은 맨 아래. 1280에서 아이콘 줄(72)로 접히는 변형은 반응형 작업 때

export function Sidebar({ userLabel, onLogout }: { userLabel?: string; onLogout: () => void }) {
  const { pathname } = useLocation()
  const inDetail = MENU[2].subs!.some((s) => pathname.startsWith(s.to))
  const [open, setOpen] = useState(inDetail)

  const row = (active: boolean, bold: boolean) =>
    `flex h-11 items-center rounded-lg px-3 text-body ${active ? 'bg-action-soft font-bold text-action' : bold ? 'font-semibold text-action' : 'text-sub hover:bg-bg'}`

  return (
    <nav className="flex h-full w-sidebar shrink-0 flex-col border-r border-line bg-surface">
      <div className="flex h-16 items-center gap-2.5 px-6">
        <span className="text-strong font-bold text-brand">dver</span>
        <span className="text-label font-semibold text-sub">관리자</span>
      </div>
      <ul className="flex flex-col gap-1 px-1 pt-3">
        {MENU.map((m) =>
          m.subs ? (
            <li key={m.label}>
              <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                className={`${row(false, inDetail)} w-full justify-between`}
              >
                {m.label}
                {/* 펼침 화살표 — 글자(▾)가 아니라 16 칸 아이콘, 펼치면 뒤집음 */}
                <svg
                  viewBox="0 0 20 20"
                  className={`size-4 stroke-sub ${open ? 'rotate-180' : ''}`}
                  fill="none"
                  strokeWidth={1.6}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M5 8l5 5 5-5" />
                </svg>
              </button>
              {open && (
                <ul className="relative ml-4 flex flex-col gap-1 border-l border-line pl-1">
                  {m.subs.map((s) => (
                    <li key={s.to}>
                      <NavLink
                        to={s.to}
                        className={({ isActive }) =>
                          `flex h-10 items-center rounded-lg px-3 text-label ${isActive ? 'bg-action-soft font-bold text-action' : 'text-sub hover:bg-bg'}`
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
                className={({ isActive }) => row(isActive, false)}
              >
                {m.label}
              </NavLink>
            </li>
          ),
        )}
      </ul>
      {/* 위 메뉴 줄과 같은 좌우 4 → 로그아웃 글자도 메뉴 글자와 같은 x(16) */}
      <div className="mt-auto flex flex-col gap-1 px-1 pb-6">
        {userLabel && <span className="truncate px-3 text-caption text-muted">{userLabel}</span>}
        <button
          type="button"
          onClick={onLogout}
          className="flex h-11 items-center rounded-lg px-3 text-left text-body text-sub hover:bg-bg"
        >
          로그아웃
        </button>
      </div>
    </nav>
  )
}
