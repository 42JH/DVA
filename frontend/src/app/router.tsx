import { createBrowserRouter, Navigate } from 'react-router'
import { LoginPage } from '@/features/auth/components/LoginPage'
import { PendingPage } from '@/features/auth/components/PendingPage'
import { SignupPage } from '@/features/auth/components/SignupPage'
import { RequireAuth } from './guards/RequireAuth'
import { RequireGuest } from './guards/RequireGuest'
import { RequireRole } from './guards/RequireRole'
import { RouteError } from './RouteError'
import { AppLayout } from './AppLayout'

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
      // 운영 콘솔 (11/06 v2로 만든 화면) — 11/09부터 기본 주소. 옛 화면 주소는 없앰
      {
        path: '/',
        element: (
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        ),
        children: [
          // 화면마다 따로 받음 (처음 여는 화면만 받게)
          {
            index: true,
            lazy: () => import('@/app/home/TodayPage').then((m) => ({ Component: m.TodayPage })),
          },
          {
            path: 'orders',
            lazy: () =>
              import('@/features/order/components/OrdersPage').then((m) => ({
                Component: m.OrdersPage,
              })),
          },
          {
            path: 'calls',
            lazy: () =>
              import('@/features/call/components/CallsPage').then((m) => ({
                Component: m.CallsPage,
              })),
          },
          {
            path: 'calls/:callId',
            lazy: () =>
              import('@/features/call/components/CallPage').then((m) => ({
                Component: m.CallPage,
              })),
          },
          {
            path: 'unanswered',
            lazy: () =>
              import('@/features/faq/components/UnansweredPage').then((m) => ({
                Component: m.UnansweredPage,
              })),
          },
          {
            path: 'faqs',
            lazy: () =>
              import('@/features/faq/components/FaqsPage').then((m) => ({ Component: m.FaqsPage })),
          },
          {
            path: 'customers',
            lazy: () =>
              import('@/features/customer/components/CustomersPage').then((m) => ({
                Component: m.CustomersPage,
              })),
          },
          {
            path: 'companies',
            lazy: () =>
              import('@/features/company/components/CompaniesPage').then((m) => ({
                Component: m.CompaniesPage,
              })),
          },
          {
            path: 'companies/:companyId',
            lazy: () =>
              import('@/features/company/components/CompanyPage').then((m) => ({
                Component: m.CompanyPage,
              })),
          },
          {
            path: 'personas',
            lazy: () =>
              import('@/features/persona/components/PersonasPage').then((m) => ({
                Component: m.PersonasPage,
              })),
          },
          {
            path: 'personas/:personaSeq/tests/:version', // 시나리오 시험 (VITE_SCENARIO_TEST=false면 AI 상담가로)
            lazy: () =>
              import('@/features/persona/components/ScenarioTest').then((m) => ({
                Component: m.ScenarioTestPage,
              })),
          },
          {
            path: 'personas/:personaSeq/tests/:version/:scenario', // 시나리오 시험 상세 (VITE_SCENARIO_TEST=false면 AI 상담가로)
            lazy: () =>
              import('@/features/persona/components/ScenarioDetailPage').then((m) => ({
                Component: m.ScenarioDetailPage,
              })),
          },
          {
            path: 'stats',
            lazy: () =>
              import('@/features/stats/components/StatsPage').then((m) => ({
                Component: m.StatsPage,
              })),
          },
          {
            path: 'stats/:kind', // 그래프 보기 (응답 대기 · 단계별 이탈)
            lazy: () =>
              import('@/features/stats/components/StatsGraphPage').then((m) => ({
                Component: m.StatsGraphPage,
              })),
          },
          {
            path: 'admins', // 최고 관리자만 (기존 /admins와 같은 가드)
            lazy: () =>
              import('@/features/admin/components/AdminsPage').then((m) => ({
                Component: () => (
                  <RequireRole roles={['SYSTEM_ADMIN']}>
                    <m.AdminsPage />
                  </RequireRole>
                ),
              })),
          },
          {
            path: 'me',
            lazy: () =>
              import('@/features/me/components/MePage').then((m) => ({ Component: m.MePage })),
          },
        ],
      },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
])
