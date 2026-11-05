import { createBrowserRouter, Navigate } from 'react-router'
import { LoginPage } from '@/features/auth/components/LoginPage'
import { PendingPage } from '@/features/auth/components/PendingPage'
import { SignupPage } from '@/features/auth/components/SignupPage'
import { CallDetailPage } from '@/features/call/components/CallDetailPage'
import { CallListPage } from '@/features/call/components/CallListPage'
import { DashboardPage } from '@/features/dashboard/components/DashboardPage'
import { GraphPage } from '@/features/dashboard/components/GraphPage'
import { FaqListPage } from '@/features/faq/components/FaqListPage'
import { FaqDetailPage } from '@/features/faq/components/FaqDetailPage'
import { FaqEditPage } from '@/features/faq/components/FaqEditPage'
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
          // 홈 화면은 없앰 (11/05 사용자) — 로그인하면 02 통계로
          { index: true, element: <Navigate to="/dashboard" replace /> },
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
          // 09 FAQ (Figma 11/04) — 목록 · 상세 · 작성 · 수정은 handle 없음(화면이 상단바 · 경로를 그림)
          { path: 'faqs', element: <FaqListPage /> },
          { path: 'faqs/new', element: <FaqEditPage /> },
          { path: 'faqs/:faqId', element: <FaqDetailPage /> },
          { path: 'faqs/:faqId/edit', element: <FaqEditPage /> },
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
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
])
