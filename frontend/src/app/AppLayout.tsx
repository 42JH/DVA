import { useLayoutEffect, useRef } from 'react'
import { Outlet, useLocation, useMatches } from 'react-router'
import { useSession } from '@/shared/auth/useSession'
import { PageHeader, Sidebar } from '@/shared/ui'
import { useUnansweredCount } from '@/features/faq/hooks/useUnansweredList'

/** 라우트마다 붙이는 정보 (router.tsx의 handle). 상단바 제목은 여기서만 정한다 */
export type RouteHandle = { title: string }

// 로그인 뒤 틀: 왼쪽 사이드바 + 오른쪽(상단바 64 고정 + 본문 스크롤). 상단바 · 사이드바는 화면이 그리지 않는다
export function AppLayout() {
  const { isSystemAdmin, logout } = useSession()
  const unanswered = useUnansweredCount() // 사이드바 'AI 미답변' 옆 숫자 (사이드바는 shared라 features를 못 읽어서 여기서 넘김)
  // 지금 경로에 맞은 라우트 중 가장 안쪽의 제목 (예: /calls/9101 → '통화 상세')
  const title =
    useMatches()
      .map((m) => (m.handle as RouteHandle | undefined)?.title)
      .findLast(Boolean) ?? ''

  // 본문이 유일한 스크롤 영역이라 화면 · 쪽 · 필터가 바뀌면 맨 위로 (브라우저 기본 동작은 window 스크롤에만 해당)
  const main = useRef<HTMLElement>(null)
  const { pathname, search } = useLocation()
  useLayoutEffect(() => {
    main.current?.scrollTo(0, 0)
  }, [pathname, search])

  return (
    <div className="flex h-full">
      <Sidebar
        onLogout={logout}
        canSee={(to) => to !== '/admins' || isSystemAdmin} // 10 관리자 권한 관리는 최고 관리자만 (RequireRole과 짝)
        badges={{ '/faqs/unanswered': unanswered }}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <PageHeader title={title} />
        <main ref={main} className="min-h-0 flex-1 overflow-auto px-content pt-6 pb-content">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
