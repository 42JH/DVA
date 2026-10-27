import { createBrowserRouter, Navigate } from 'react-router'
import { LoginPage } from '@/features/auth/components/LoginPage'
import { PendingPage } from '@/features/auth/components/PendingPage'
import { CallDetailPage } from '@/features/call/components/CallDetailPage'
import { FaqPage } from '@/features/faq/components/FaqPage'
import { AppLayout } from './AppLayout'
import { RequireAuth } from './guards/RequireAuth'
import { RequireRole } from './guards/RequireRole'
import { RouteError } from './RouteError'
import { Placeholder } from './routes/Placeholder'
import { UiKitPage } from './routes/UiKitPage'

// 경로 = 와이어프레임 사이드바 메뉴. 화면을 만들면 Placeholder를 그 화면의 View로 바꾼다
export const router = createBrowserRouter([
  {
    errorElement: <RouteError />, // 루트 에러 경계 (컨벤션 7.3)
    children: [
      { path: '/login', element: <LoginPage /> },
      { path: '/signup', element: <Placeholder title="00 회원가입" /> },
      { path: '/pending', element: <PendingPage /> }, // 승인 대기 (RequireAuth가 PENDING 계정을 여기로)
      {
        element: (
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        ),
        children: [
          { index: true, element: <Placeholder title="01 홈" /> },
          { path: 'dashboard', element: <Placeholder title="02 대시보드" /> },
          { path: 'orders', element: <Placeholder title="03 주문 내역" /> },
          { path: 'calls', element: <Placeholder title="04 통화 내역" /> },
          { path: 'calls/:callId', element: <CallDetailPage /> },
          { path: 'inquiries', element: <Placeholder title="05 통화 문의" /> },
          { path: 'inquiries/:callId', element: <Placeholder title="05 통화 문의 상세" /> },
          { path: 'companies', element: <Placeholder title="08 기업관리" /> },
          { path: 'personas', element: <Placeholder title="07 페르소나 관리" /> },
          { path: 'faqs', element: <FaqPage /> },
          {
            path: 'admins',
            element: (
              <RequireRole roles={['SYSTEM_ADMIN']}>
                <Placeholder title="10 관리자 권한 관리" />
              </RequireRole>
            ),
          },
          { path: 'me', element: <Placeholder title="11 내 정보" /> },
          ...(import.meta.env.DEV ? [{ path: 'ui-kit', element: <UiKitPage /> }] : []), // 공통 부품 확인용, 개발 중에만
        ],
      },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
])
