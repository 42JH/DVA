import { createBrowserRouter, Navigate } from 'react-router'
import { LoginPage } from '@/features/auth/components/LoginPage'
import { InactivePage } from '@/features/auth/components/InactivePage'
import { PendingPage } from '@/features/auth/components/PendingPage'
import { SignupPage } from '@/features/auth/components/SignupPage'
import { CallDetailPage } from '@/features/call/components/CallDetailPage'
import { CallListPage } from '@/features/call/components/CallListPage'
import { DashboardPage } from '@/features/dashboard/components/DashboardPage'
import { FaqPage } from '@/features/faq/components/FaqPage'
import { UnansweredPage } from '@/features/faq/components/UnansweredPage'
import { HomePage } from './routes/HomePage'
import { OrderListPage } from '@/features/order/components/OrderListPage'
import { PersonaPage } from '@/features/persona/components/PersonaPage'
import { MyInfoPage } from '@/features/me/components/MyInfoPage'
import { AdminPage } from '@/features/admin/components/AdminPage'
import { CompanyListPage } from '@/features/company/components/CompanyListPage'
import { AppLayout, type RouteHandle } from './AppLayout'
import { RequireAuth } from './guards/RequireAuth'
import { RequireRole } from './guards/RequireRole'
import { RouteError } from './RouteError'
import { UiKitPage } from './routes/UiKitPage'

// 경로 = 와이어프레임 사이드바 메뉴. handle.title = 상단바 제목(AppLayout이 그림). 화면을 만들면 Placeholder를 그 화면으로 바꾼다
export const router = createBrowserRouter([
  {
    errorElement: <RouteError />, // 루트 에러 경계 (컨벤션 7.3)
    children: [
      { path: '/login', element: <LoginPage /> },
      { path: '/signup', element: <SignupPage /> },
      { path: '/pending', element: <PendingPage /> }, // 승인 대기 (가입 직후 · RequireAuth가 PENDING 계정을 여기로)
      { path: '/inactive', element: <InactivePage /> }, // 비활성화 (RequireAuth가 INACTIVE 계정을 여기로)
      {
        element: (
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        ),
        children: [
          { index: true, element: <HomePage />, handle: { title: '홈' } satisfies RouteHandle },
          {
            path: 'dashboard',
            element: <DashboardPage />,
            handle: { title: '대시보드' } satisfies RouteHandle,
          },
          {
            path: 'orders',
            element: <OrderListPage />,
            handle: { title: '주문 내역' } satisfies RouteHandle,
          },
          {
            path: 'calls',
            element: <CallListPage />,
            handle: { title: '통화 내역' } satisfies RouteHandle,
          },
          {
            path: 'calls/:callId',
            element: <CallDetailPage />,
            handle: { title: '통화 상세' } satisfies RouteHandle,
          },
          {
            path: 'companies',
            element: <CompanyListPage />,
            handle: { title: '기업관리' } satisfies RouteHandle,
          },
          {
            path: 'personas',
            element: <PersonaPage />,
            handle: { title: '페르소나 관리' } satisfies RouteHandle,
          },
          // 09 FAQ 관리 ▸ FAQ 목록 · AI 미답변 (10/28 A안) — 상단바 제목 = 하위 메뉴 이름
          {
            path: 'faqs',
            element: <FaqPage />,
            handle: { title: 'FAQ 목록' } satisfies RouteHandle,
          },
          {
            path: 'faqs/unanswered',
            element: <UnansweredPage />,
            handle: { title: 'AI 미답변' } satisfies RouteHandle,
          },
          {
            path: 'admins',
            handle: { title: '관리자 권한 관리' } satisfies RouteHandle,
            element: (
              <RequireRole roles={['SYSTEM_ADMIN']}>
                <AdminPage />
              </RequireRole>
            ),
          },
          {
            path: 'me',
            element: <MyInfoPage />,
            handle: { title: '내 정보' } satisfies RouteHandle,
          },
          ...(import.meta.env.DEV
            ? [
                {
                  path: 'ui-kit',
                  element: <UiKitPage />,
                  handle: { title: '공통 부품' } satisfies RouteHandle,
                },
              ]
            : []), // 공통 부품 확인용, 개발 중에만
        ],
      },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
])
