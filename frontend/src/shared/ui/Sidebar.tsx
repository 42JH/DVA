import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, NavLink, useLocation } from 'react-router'
import logo from '@/shared/assets/logo-dva.png'
import { ExitGhost } from '@/shared/lib/useExitGhost'

// 사이드바 (Figma 디자인/목업 '프레임' 11/04) — 폭 64 아이콘 줄: 로고(홈) · 위 무리 · 아래 무리(바닥에 붙음)
// 줄 46×59 = 아이콘 24 + 글자 12. 선택된 줄 = 흰 네모(모서리 8), 다른 줄을 고르면 네모가 그리로 미끄러짐 (디자인 '선택시 슬라이드 애니메이션')
// 설정 = 옆에 뜨는 메뉴(관리자 · 내 정보 · 로그아웃, 11/04 사용자). 관리자는 최고 관리자만
// '물류'는 디자인 자리에 두되 누를 수 없음(화면 없음, 11/04 사용자) — 화면이 생기면 soon을 빼고 링크로. 디자인의 '접수'는 '주문'으로 통일(11/04 사용자)
// AI 미답변 숫자는 상단바로 옮김 (PageHeader)

// 아이콘 = Figma 아이콘의 선을 그대로 옮김 (조각마다 translate = 24 칸 안 자리). 색은 currentColor
const ICON = {
  chart: (
    <>
      <g transform="translate(3.25 2.25)">
        <path d="M3.25 8.75H1.25C0.973858 8.75 0.75 8.97386 0.75 9.25V15.25C0.75 15.5261 0.973858 15.75 1.25 15.75H3.25C3.52614 15.75 3.75 15.5261 3.75 15.25V9.25C3.75 8.97386 3.52614 8.75 3.25 8.75Z" />
        <path d="M9.75 0.75H7.75C7.47386 0.75 7.25 0.973858 7.25 1.25V15.25C7.25 15.5261 7.47386 15.75 7.75 15.75H9.75C10.0261 15.75 10.25 15.5261 10.25 15.25V1.25C10.25 0.973858 10.0261 0.75 9.75 0.75Z" />
        <path d="M16.25 4.75H14.25C13.9739 4.75 13.75 4.97386 13.75 5.25V15.25C13.75 15.5261 13.9739 15.75 14.25 15.75H16.25C16.5261 15.75 16.75 15.5261 16.75 15.25V5.25C16.75 4.97386 16.5261 4.75 16.25 4.75Z" />
      </g>
      <path d="M2.75 21H21.25" />
    </>
  ),
  call: (
    <>
      <path
        transform="translate(2.25 2.25)"
        d="M4.59 0.75H1.95C1.23 0.75 0.75 1.35 0.75 2.07C0.99 10.59 7.71 17.31 16.23 17.55C16.95 17.55 17.55 17.07 17.55 16.35V13.71L13.23 11.79L11.31 13.83C8.93645 12.5186 6.98144 10.5635 5.67 8.19L7.71 6.27L4.59 0.75Z"
      />
      <g transform="translate(12.45 1.65)">
        <path d="M4.95 9.15C7.2696 9.15 9.15 7.2696 9.15 4.95C9.15 2.6304 7.2696 0.75 4.95 0.75C2.6304 0.75 0.75 2.6304 0.75 4.95C0.75 7.2696 2.6304 9.15 4.95 9.15Z" />
        <path d="M4.95 2.67V4.95L6.51 5.91" />
      </g>
    </>
  ),
  box: (
    <g transform="translate(1.25 1.25)">
      <path d="M10.7501 0.75L20.7501 6.12634V15.3737L10.7501 20.75L0.750146 15.3737V6.12634L10.7501 0.75Z" />
      <path d="M0.750146 6.12613L10.7501 11.5025M10.7501 11.5025L20.7501 6.12613M10.7501 11.5025V20.7498" />
      <path d="M5.53286 3.54538L15.5329 8.92173V11.9325L17.7068 10.7712V7.76044L7.70677 2.38409" />
    </g>
  ),
  faq: (
    <>
      <path
        transform="translate(2 2)"
        d="M4.5 0.75H15.5C16.4946 0.75 17.4484 1.14509 18.1517 1.84835C18.8549 2.55161 19.25 3.50544 19.25 4.5V12.5C19.25 13.4946 18.8549 14.4484 18.1517 15.1517C17.4484 15.8549 16.4946 16.25 15.5 16.25H7L2.5 19.25V15.67C1.96441 15.3323 1.52304 14.8645 1.21704 14.3102C0.911034 13.7559 0.750362 13.1332 0.75 12.5V4.5C0.75 3.50544 1.14509 2.55161 1.84835 1.84835C2.55161 1.14509 3.50544 0.75 4.5 0.75Z"
      />
      <g transform="translate(9 5.25)">
        <path d="M0.750067 2.75004C0.811818 2.19763 1.07587 1.68762 1.49132 1.31833C1.90677 0.949038 2.44422 0.746602 3.00007 0.750043C4.35007 0.750043 5.25007 1.60004 5.25007 2.75004C5.25007 4.60004 3.00007 4.60004 3.00007 6.25004" />
        <path d="M3.00007 9.00004V9.05004" />
      </g>
    </>
  ),
  truck: (
    <>
      <rect x="2" y="5" width="12" height="10" rx="1" />
      <path d="M14 9h4l4 4v2h-8z" />
      <circle cx="6" cy="17" r="2" />
      <circle cx="18" cy="17" r="2" />
    </>
  ),
  headset: (
    <>
      <g transform="translate(2 1.25)">
        <path d="M1.5 9.75V9.25C1.5 6.99566 2.39553 4.83365 3.98959 3.23959C5.58365 1.64553 7.74566 0.75 10 0.75C12.2543 0.75 14.4163 1.64553 16.0104 3.23959C17.6045 4.83365 18.5 6.99566 18.5 9.25V9.75" />
        <path d="M2.5 9.25H2.25C1.42157 9.25 0.75 9.92157 0.75 10.75V13.75C0.75 14.5784 1.42157 15.25 2.25 15.25H2.5C3.32843 15.25 4 14.5784 4 13.75V10.75C4 9.92157 3.32843 9.25 2.5 9.25Z" />
        <path d="M17.75 9.25H17.5C16.6716 9.25 16 9.92157 16 10.75V13.75C16 14.5784 16.6716 15.25 17.5 15.25H17.75C18.5784 15.25 19.25 14.5784 19.25 13.75V10.75C19.25 9.92157 18.5784 9.25 17.75 9.25Z" />
        <path d="M18 15.25V15.75C18 16.5456 17.6839 17.3087 17.1213 17.8713C16.5587 18.4339 15.7956 18.75 15 18.75H12" />
      </g>
      <g transform="translate(5.25 6.25)">
        <path d="M9.75 0.75H3.75C2.09315 0.75 0.75 2.09315 0.75 3.75V8.75C0.75 10.4069 2.09315 11.75 3.75 11.75H9.75C11.4069 11.75 12.75 10.4069 12.75 8.75V3.75C12.75 2.09315 11.4069 0.75 9.75 0.75Z" />
        <path d="M4.25 4.75V5.75M9.25 4.75V5.75M4.75 8.25C6.08333 9.58333 7.41667 9.58333 8.75 8.25" />
      </g>
    </>
  ),
  building: (
    <>
      <g transform="translate(2.25 2)">
        <path d="M17.25 0.75H2.25C1.42157 0.75 0.75 1.42157 0.75 2.25V17.75C0.75 18.5784 1.42157 19.25 2.25 19.25H17.25C18.0784 19.25 18.75 18.5784 18.75 17.75V2.25C18.75 1.42157 18.0784 0.75 17.25 0.75Z" />
        <path d="M7.25 19.25V14H12.25V19.25" />
      </g>
      <path
        transform="translate(6.25 6.25)"
        d="M0.75 0.75H1.75M5.25 0.75H6.25M9.75 0.75H10.75M0.75 5.25H1.75M5.25 5.25H6.25M9.75 5.25H10.75"
      />
    </>
  ),
  gear: (
    <>
      <path d="M12.22 2H11.78C11.2947 1.99522 10.8242 2.16708 10.4562 2.48353C10.0883 2.79999 9.84792 3.23945 9.78 3.72L9.66 4.59C9.60699 4.92214 9.47107 5.23556 9.26482 5.50124C9.05856 5.76692 8.78863 5.9763 8.48 6.11L8.18 6.25C7.87238 6.38716 7.53511 6.4444 7.19946 6.41643C6.86382 6.38846 6.54067 6.27618 6.26 6.09L5.56 5.55C5.15606 5.2864 4.67046 5.17766 4.19268 5.24381C3.7149 5.30996 3.27712 5.54656 2.96 5.91L2.74 6.29C2.50814 6.71923 2.44116 7.2184 2.55166 7.69357C2.66217 8.16873 2.94254 8.58713 3.34 8.87L4.04 9.41C4.29969 9.62248 4.50176 9.89689 4.62758 10.2079C4.7534 10.519 4.79894 10.8567 4.76 11.19V11.53C4.79894 11.8633 4.7534 12.201 4.62758 12.5121C4.50176 12.8231 4.29969 13.0975 4.04 13.31L3.34 13.85C2.94254 14.1329 2.66217 14.5513 2.55166 15.0264C2.44116 15.5016 2.50814 16.0008 2.74 16.43L2.96 16.81C3.27712 17.1734 3.7149 17.41 4.19268 17.4762C4.67046 17.5423 5.15606 17.4336 5.56 17.17L6.26 16.63C6.54067 16.4438 6.86382 16.3315 7.19946 16.3036C7.53511 16.2756 7.87238 16.3328 8.18 16.47L8.48 16.61C8.78863 16.7437 9.05856 16.9531 9.26482 17.2188C9.47107 17.4844 9.60699 17.7979 9.66 18.13L9.78 19C9.84792 19.4806 10.0883 19.92 10.4562 20.2365C10.8242 20.5529 11.2947 20.7248 11.78 20.72H12.22C12.7053 20.7248 13.1758 20.5529 13.5438 20.2365C13.9117 19.92 14.1521 19.4806 14.22 19L14.34 18.13C14.393 17.7979 14.5289 17.4844 14.7352 17.2188C14.9414 16.9531 15.2114 16.7437 15.52 16.61L15.82 16.47C16.1276 16.3328 16.4649 16.2756 16.8005 16.3036C17.1362 16.3315 17.4593 16.4438 17.74 16.63L18.44 17.17C18.8439 17.4336 19.3295 17.5423 19.8073 17.4762C20.2851 17.41 20.7229 17.1734 21.04 16.81L21.26 16.43C21.4919 16.0008 21.5588 15.5016 21.4483 15.0264C21.3378 14.5513 21.0575 14.1329 20.66 13.85L19.96 13.31C19.7003 13.0975 19.4982 12.8231 19.3724 12.5121C19.2466 12.201 19.2011 11.8633 19.24 11.53V11.19C19.2011 10.8567 19.2466 10.519 19.3724 10.2079C19.4982 9.89689 19.7003 9.62248 19.96 9.41L20.66 8.87C21.0575 8.58713 21.3378 8.16873 21.4483 7.69357C21.5588 7.2184 21.4919 6.71923 21.26 6.29L21.04 5.91C20.7229 5.54656 20.2851 5.30996 19.8073 5.24381C19.3295 5.17766 18.8439 5.2864 18.44 5.55L17.74 6.09C17.4593 6.27618 17.1362 6.38846 16.8005 6.41643C16.4649 6.4444 16.1276 6.38716 15.82 6.25L15.52 6.11C15.2114 5.9763 14.9414 5.76692 14.7352 5.50124C14.5289 5.23556 14.393 4.92214 14.34 4.59L14.22 3.72C14.1521 3.23945 13.9117 2.79999 13.5438 2.48353C13.1758 2.16708 12.7053 1.99522 12.22 2Z" />
      <path d="M12 14C13.6569 14 15 12.6569 15 11C15 9.34315 13.6569 8 12 8C10.3431 8 9 9.34315 9 11C9 12.6569 10.3431 14 12 14Z" />
    </>
  ),
}

/** 메뉴 아이콘을 다른 곳에서 (검색 창 '최근 조회' 줄 앞 — 통화 · 주문 · FAQ · 기업). 크기 · 색은 className */
export function MenuIcon({ name, className }: { name: keyof typeof ICON; className: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`shrink-0 ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {ICON[name]}
    </svg>
  )
}

// 아이콘 회색 · 글자 진한 회색 (디자인 neutral-600 · 800). 선택되면 둘 다 파랑 (디자인 선택 상태 11/04)
function Icon({ name, on }: { name: keyof typeof ICON; on: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`size-6 shrink-0 ${on ? 'text-brand' : 'text-sub'}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {ICON[name]}
    </svg>
  )
}

type Item = { to: string; label: string; icon: keyof typeof ICON; soon?: boolean }
const TOP: Item[] = [
  { to: '/dashboard', label: '통계', icon: 'chart' },
  { to: '/calls', label: '통화', icon: 'call' },
  { to: '/orders', label: '주문', icon: 'box' },
  { to: '/faqs', label: 'FAQ', icon: 'faq' }, // FAQ 목록 · 상세 · 작성 (AI 미답변은 아님 — 아래 NO_ROW)
]
const BOTTOM: Item[] = [
  { to: '/logistics', label: '물류', icon: 'truck', soon: true },
  // shortcut: 수정 화면 글 칸 잘림(jiw/log/2026-11-05-persona-editor-clip.md)으로 잠시 막음 — 고치면 soon 삭제
  { to: '/personas', label: 'AI 상담가', icon: 'headset', soon: true },
  { to: '/companies', label: '기업', icon: 'building' },
]
const SETTINGS = ['/admins', '/me'] // 설정 메뉴 안 화면 — 여기 있으면 설정 줄이 선택됨
const NO_ROW = '/faqs/unanswered' // 사이드바에 줄이 없는 화면 — 아무 줄도 선택 안 함 (11/05 사용자: FAQ가 선택돼 보일 필요 없음)

// isolate: 흰 네모(-z-10)를 줄 안에서만 글자 · 아이콘 뒤로 깖. nowrap: 'AI 상담가'(45)가 줄 폭 46에 빠듯해 두 줄로 안 꺾이게
const ROW =
  'relative isolate flex h-[59px] w-[46px] flex-col items-center justify-center gap-1 rounded-lg text-[12px]/[14px] whitespace-nowrap'
const tone = (on: boolean) => (on ? 'text-brand' : 'text-ink hover:bg-surface/50')
// 디자인 '사용자 메뉴 / 펼침 상태': 폭 160 · 줄 44 · 글자 14/500 · 줄 사이 1 선
const MENU_ROW = 'flex h-11 w-full items-center px-4 text-label font-medium text-ink hover:bg-bg'

export function Sidebar({ onLogout, showAdmins }: { onLogout: () => void; showAdmins: boolean }) {
  const { pathname } = useLocation()
  const on = (to: string) => pathname === to || pathname.startsWith(to + '/')
  // 선택된 줄 (홈 '/'이면 없음)
  const active = on(NO_ROW)
    ? null
    : ([...TOP, ...BOTTOM].find((m) => on(m.to))?.to ?? (SETTINGS.some(on) ? 'settings' : null))

  // 흰 네모는 선택된 줄 안에 그림 → 줄이 바뀌면 옛 줄 자리에서 출발해 미끄러져 오는 애니메이션만 붙임 (FLIP)
  // 줄 안에 있으니 창 높이가 바뀌어 아래 무리가 움직여도 따라감. 옛 줄 자리는 지금 다시 재서 씀
  const mark = useRef<HTMLSpanElement>(null)
  const prevRow = useRef<Element | null>(null)
  useLayoutEffect(() => {
    const row = mark.current?.parentElement ?? null
    const from = prevRow.current
    prevRow.current = row
    if (!row || !from || from === row) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const dy = from.getBoundingClientRect().top - row.getBoundingClientRect().top
    mark.current!.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], {
      duration: 250,
      easing: 'ease-out',
    })
  }, [active])
  const markEl = (
    <span ref={mark} aria-hidden className="absolute inset-0 -z-10 rounded-lg bg-surface" />
  )

  // 설정 메뉴: 바깥 클릭 · Esc · 항목 선택으로 닫힘 (MoreMenu와 같은 방식)
  const [menu, setMenu] = useState(false)
  const settings = useRef<HTMLLIElement>(null)
  const settingsBtn = useRef<HTMLButtonElement>(null)
  const menuList = useRef<HTMLUListElement>(null) // 닫힐 때 사라지는 애니메이션은 안의 <ExitGhost>
  useEffect(() => {
    if (!menu) return
    const onDown = (e: PointerEvent) => {
      if (!settings.current?.contains(e.target as Node)) setMenu(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setMenu(false)
      settingsBtn.current?.focus() // 키보드 사용자가 제자리로
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menu])

  const row = (m: Item) => (
    <li key={m.to}>
      {m.soon ? (
        <span aria-disabled="true" title="준비 중" className={`${ROW} text-ink`}>
          <Icon name={m.icon} on={false} />
          {m.label}
        </span>
      ) : (
        <NavLink to={m.to} className={`${ROW} ${tone(active === m.to)}`}>
          {active === m.to && markEl}
          <Icon name={m.icon} on={active === m.to} />
          {m.label}
        </NavLink>
      )}
    </li>
  )

  return (
    // z-30: 설정 메뉴가 본문의 펼침(z-20)보다 위, 모달(z-50)보다 아래
    <nav
      aria-label="주 메뉴"
      className="relative z-30 flex w-sidebar shrink-0 flex-col items-center pt-4 pb-8"
    >
      <Link to="/" aria-label="홈으로">
        <img src={logo} alt="" className="w-10" />
      </Link>

      <ul className="mt-6 flex flex-col gap-1.5">{TOP.map(row)}</ul>

      <ul className="mt-auto flex flex-col gap-1.5">
        {BOTTOM.map(row)}
        <li ref={settings} className="relative">
          <button
            ref={settingsBtn}
            type="button"
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu((o) => !o)}
            className={`${ROW} ${tone(active === 'settings' || menu)}`}
          >
            {active === 'settings' && markEl}
            <Icon name="gear" on={active === 'settings' || menu} />
            설정
          </button>
          {menu && (
            // 설정 줄 오른쪽에 아래를 맞춰 위로 뜸
            <ul
              ref={menuList}
              role="menu"
              aria-label="설정"
              className="absolute bottom-0 left-full z-10 ml-4 w-40 origin-bottom-left divide-y divide-action-soft overflow-hidden rounded-sm border border-line bg-surface shadow-[0_4px_12px_rgba(0,0,0,0.08)] motion-safe:animate-pop-in"
            >
              <ExitGhost target={menuList} />
              {showAdmins && (
                <li role="none">
                  <Link
                    role="menuitem"
                    to="/admins"
                    onClick={() => setMenu(false)}
                    className={MENU_ROW}
                  >
                    관리자
                  </Link>
                </li>
              )}
              <li role="none">
                <Link role="menuitem" to="/me" onClick={() => setMenu(false)} className={MENU_ROW}>
                  내 정보
                </Link>
              </li>
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenu(false)
                    onLogout()
                  }}
                  className={MENU_ROW}
                >
                  로그아웃
                </button>
              </li>
            </ul>
          )}
        </li>
      </ul>
    </nav>
  )
}
