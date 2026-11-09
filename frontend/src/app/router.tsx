import { createBrowserRouter, Navigate } from 'react-router'
import { LoginPage } from '@/features/auth/components/LoginPage'
import { PendingPage } from '@/features/auth/components/PendingPage'
import { SignupPage } from '@/features/auth/components/SignupPage'
import { CallDetailPage } from '@/features/call/components/CallDetailPage'
import { CallListPage } from '@/features/call/components/CallListPage'
import { DashboardPage } from '@/features/dashboard/components/DashboardPage'
import { GraphPage } from '@/features/dashboard/components/GraphPage'
import { FaqListPage, FaqOpenRedirect } from '@/features/faq/components/FaqListPage'
import { UnansweredPage } from '@/features/faq/components/UnansweredPage'
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
import { V2Layout } from '@/v2/V2Layout'

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
          // 로그인하면 v2 운영 콘솔 홈으로 (기존 화면은 v2 사이드바 '기존 화면'으로 들어감)
          { index: true, element: <Navigate to="/v2" replace /> },
          // 02 통계 'AI 상담 성능' (Figma 11/05) · 그래프 보기 두 화면 — handle 없음(화면이 상단바 · 경로를 그림)
          { path: 'dashboard', element: <DashboardPage /> },
          { path: 'dashboard/response-wait', element: <GraphPage kind="response-wait" /> },
          { path: 'dashboard/stage-dropoffs', element: <GraphPage kind="stage-dropoffs" /> },
          // 03 주문 내역 (Figma 11/04) — handle 없음(화면이 상단바 · 머리를 그림)
          { path: 'orders', element: <OrderListPage /> },
          // 04 통화 내역 (Figma 11/04) — handle 없음(화면이 상단바 · 머리를 그림)
          { path: 'calls', element: <CallListPage /> },
          // 06 통화 상세 (11/05 새 디자인) — handle 없음(화면이 경로 '통화 > 통화 상세'를 그림)
          { path: 'calls/:callId', element: <CallDetailPage /> },
          // 08 기업관리 (11/05 새 디자인 — 구성 그대로 모양만) — handle 없음(화면이 상단바 · 경로를 그림)
          { path: 'companies', element: <CompanyListPage /> },
          { path: 'companies/:companyId', element: <CompanyDetailPage /> },
          // 07 페르소나 관리 (11/05 새 디자인 — 구성 그대로 모양만) — handle 없음(화면이 상단바를 그림)
          { path: 'personas', element: <PersonaPage /> },
          // 09 FAQ (Figma 11/06) — handle 없음(화면이 상단바 · 경로를 그림)
          { path: 'faqs', element: <FaqListPage /> },
          // 옛 상세 주소 (검색 창 · 최근 조회) → 그 FAQ를 펼친 목록. 상세 · 작성 · 수정은 목록 안으로 (11/06)
          { path: 'faqs/:faqId', element: <FaqOpenRedirect /> },
          // AI 미답변 (11/05 새 디자인 — FAQ 목록과 같은 틀) — handle 없음(화면이 상단바 · 경로를 그림)
          { path: 'faqs/unanswered', element: <UnansweredPage /> },
          {
            path: 'admins', // 10 (11/05 새 디자인) — handle 없음(화면이 상단바 · 경로를 그림)
            element: (
              <RequireRole roles={['SYSTEM_ADMIN']}>
                <AdminPage />
              </RequireRole>
            ),
          },
          // 11 내 정보 (11/05 새 디자인 — 구성 그대로 모양만) — handle 없음(화면이 상단바 · 경로를 그림)
          { path: 'me', element: <MyInfoPage /> },
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
      // v2 운영 콘솔 (11/06 실험 — 기존 화면은 그대로, 새 디자인을 /v2에서 따로 쌓음)
      {
        path: '/v2',
        element: (
          <RequireAuth>
            <V2Layout />
          </RequireAuth>
        ),
        children: [
          // 화면마다 따로 받음 (기존 화면을 여는 데 v2 코드가 같이 실리지 않게)
          {
            index: true,
            lazy: () => import('@/v2/home/TodayPage').then((m) => ({ Component: m.TodayPage })),
          },
          {
            path: 'orders',
            lazy: () => import('@/v2/orders/OrdersPage').then((m) => ({ Component: m.OrdersPage })),
          },
          {
            path: 'calls',
            lazy: () => import('@/v2/calls/CallsPage').then((m) => ({ Component: m.CallsPage })),
          },
          {
            path: 'calls/:callId',
            lazy: () => import('@/v2/calls/CallPage').then((m) => ({ Component: m.CallPage })),
          },
          {
            path: 'unanswered',
            lazy: () =>
              import('@/v2/faq/UnansweredPage').then((m) => ({ Component: m.UnansweredPage })),
          },
          {
            path: 'faqs',
            lazy: () => import('@/v2/faq/FaqsPage').then((m) => ({ Component: m.FaqsPage })),
          },
          {
            path: 'customers',
            lazy: () =>
              import('@/v2/customers/CustomersPage').then((m) => ({ Component: m.CustomersPage })),
          },
          {
            path: 'companies',
            lazy: () =>
              import('@/v2/companies/CompaniesPage').then((m) => ({ Component: m.CompaniesPage })),
          },
          {
            path: 'companies/:companyId',
            lazy: () =>
              import('@/v2/companies/CompanyPage').then((m) => ({ Component: m.CompanyPage })),
          },
          {
            path: 'personas',
            lazy: () =>
              import('@/v2/personas/PersonasPage').then((m) => ({ Component: m.PersonasPage })),
          },
          {
            path: 'stats',
            lazy: () => import('@/v2/stats/StatsPage').then((m) => ({ Component: m.StatsPage })),
          },
          {
            path: 'stats/:kind', // 그래프 보기 (응답 대기 · 단계별 이탈)
            lazy: () =>
              import('@/v2/stats/StatsGraphPage').then((m) => ({ Component: m.StatsGraphPage })),
          },
          {
            path: 'admins', // 최고 관리자만 (기존 /admins와 같은 가드)
            lazy: () =>
              import('@/v2/settings/AdminsPage').then((m) => ({
                Component: () => (
                  <RequireRole roles={['SYSTEM_ADMIN']}>
                    <m.AdminsPage />
                  </RequireRole>
                ),
              })),
          },
          {
            path: 'me',
            lazy: () => import('@/v2/settings/MePage').then((m) => ({ Component: m.MePage })),
          },
        ],
      },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
])
