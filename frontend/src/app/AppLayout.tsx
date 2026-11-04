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
  const unanswered = useUnansweredCount() // 상단바 AI 미답변 알림 (상단바는 shared라 features를 못 읽어서 여기서 넘김)
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
    // 틀 (디자인 '프레임' 11/04): 옅은 하늘색 바탕 위에 왼쪽 아이콘 줄 + 오른쪽 흰 카드(위 · 오른쪽 · 아래 4 띄움, 모서리 20)
    <div className="flex h-full bg-frame">
      <Sidebar
        onLogout={logout}
        showAdmins={isSystemAdmin} // 설정 ▸ 관리자(10 관리자 권한 관리)는 최고 관리자만 (RequireRole과 짝)
      />
      <div className="my-1 mr-1 flex min-w-0 flex-1 flex-col overflow-hidden rounded-[20px] bg-surface">
        <PageHeader title={title} unanswered={unanswered} />
        <main
          ref={main}
          // 스크롤 막대는 디자인처럼 바탕 없이 얇은 회색 손잡이만
          className="min-h-0 flex-1 [scrollbar-width:thin] [scrollbar-color:var(--color-line)_transparent] overflow-auto px-content pt-6 pb-content"
        >
          {/* 경로(쿼리 제외)가 바뀌면 본문이 떠오름 (11/01). key로 새로 그려서 애니메이션이 다시 돎 — 쪽 · 필터 변경은 같은 경로라 안 돎 */}
          <div key={pathname} className="flex min-h-full flex-col motion-safe:animate-page-in">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}
