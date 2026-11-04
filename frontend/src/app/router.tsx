import { createBrowserRouter, Navigate } from 'react-router'
import { LoginPage } from '@/features/auth/components/LoginPage'
import { PendingPage } from '@/features/auth/components/PendingPage'
import { SignupPage } from '@/features/auth/components/SignupPage'
import { CallDetailPage } from '@/features/call/components/CallDetailPage'
import { CallListPage } from '@/features/call/components/CallListPage'
import { DashboardPage } from '@/features/dashboard/components/DashboardPage'
import { FaqListPage } from '@/features/faq/components/FaqListPage'
import { FaqDetailPage } from '@/features/faq/components/FaqDetailPage'
import { FaqEditPage } from '@/features/faq/components/FaqEditPage'
import { UnansweredPage } from '@/features/faq/components/UnansweredPage'
import { HomePage } from './routes/HomePage'
import { OrderListPage } from '@/features/order/components/OrderListPage'
import { PersonaPage } from '@/features/persona/components/PersonaPage'
import { MyInfoPage } from '@/features/me/components/MyInfoPage'
import { AdminPage } from '@/features/admin/components/AdminPage'
import { CompanyListPage } from '@/features/company/components/CompanyListPage'
import { CompanyDetailPage } from '@/features/company/components/CompanyDetailPage'
import { AppLayout, type RouteHandle } from './AppLayout'
import { RequireAuth } from './guards/RequireAuth'
import { RequireGuest } from './guards/RequireGuest'
import { RequireRole } from './guards/RequireRole'
import { RouteError } from './RouteError'
import { UiKitPage } from './routes/UiKitPage'

// 경로 = 와이어프레임 사이드바 메뉴. handle.title = 상단바 제목(AppLayout이 그림). 화면을 만들면 Placeholder를 그 화면으로 바꾼다
export const router = createBrowserRouter([
  {
    errorElement: <RouteError />, // 루트 에러 경계 (컨벤션 7.3)
    children: [
      {
        path: '/login',
        element: (
          <RequireGuest>
            <LoginPage />
          </RequireGuest>
        ),
      },
      {
        path: '/signup',
        element: (
          <RequireGuest>
            <SignupPage />
          </RequireGuest>
        ),
      },
      { path: '/pending', element: <PendingPage /> }, // 승인 대기 (가입 직후 · RequireAuth가 PENDING 계정을 여기로)
      // /inactive(비활성화 안내)는 보류 — 계정 비활성화 API가 없어 도달 경로 없음 (연동 상세명세 §10, BE 요청 B2)
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
          // 03 주문 내역 (Figma 11/04) — handle 없음(화면이 상단바 · 머리를 그림)
          { path: 'orders', element: <OrderListPage /> },
          // 04 통화 내역 (Figma 11/04) — handle 없음(화면이 상단바 · 머리를 그림)
          { path: 'calls', element: <CallListPage /> },
          // 06 통화 상세 (11/05 새 디자인) — handle 없음(화면이 경로 '통화 > 통화 상세'를 그림)
          { path: 'calls/:callId', element: <CallDetailPage /> },
          {
            path: 'companies',
            element: <CompanyListPage />,
            handle: { title: '기업관리' } satisfies RouteHandle,
          },
          {
            path: 'companies/:companyId',
            element: <CompanyDetailPage />,
            handle: { title: '기업관리' } satisfies RouteHandle,
          },
          {
            path: 'personas',
            element: <PersonaPage />,
            handle: { title: '페르소나 관리' } satisfies RouteHandle,
          },
          // 09 FAQ (Figma 11/04) — 목록 · 상세 · 작성 · 수정은 handle 없음(화면이 상단바 · 경로를 그림). AI 미답변은 예전 상단바
          { path: 'faqs', element: <FaqListPage /> },
          { path: 'faqs/new', element: <FaqEditPage /> },
          { path: 'faqs/:faqId', element: <FaqDetailPage /> },
          { path: 'faqs/:faqId/edit', element: <FaqEditPage /> },
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
