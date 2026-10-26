import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createBrowserRouter, Navigate } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { LoginPage } from '../features/auth/view/LoginPage'
import { ApiError } from '../shared/api/client'
import { AppLayout } from './AppLayout'
import { Placeholder } from './Placeholder'
import { RequireAuth } from './RequireAuth'
import { UiKitPage } from './UiKitPage'

// 명세서 1.6: 조회만 재시도 — 연결 실패(0) · 429 · 503일 때 최대 2번. 등록 · 수정은 재시도 안 함
// ponytail: Retry-After 헤더는 아직 안 따름(기본 지수 대기). 백엔드가 429에 Retry-After를 주면 retryDelay에 반영
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, e) => count < 2 && e instanceof ApiError && [0, 429, 503].includes(e.status),
    },
    mutations: { retry: false },
  },
})

// 경로 = 와이어프레임 사이드바 메뉴. 화면을 만들면 Placeholder를 그 화면의 View로 바꾼다
const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/signup', element: <Placeholder title="00 회원가입" /> },
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
      { path: 'calls/:callId', element: <Placeholder title="06 통화 상세" /> },
      { path: 'inquiries', element: <Placeholder title="05 통화 문의" /> },
      { path: 'inquiries/:callId', element: <Placeholder title="05 통화 문의 상세" /> },
      { path: 'companies', element: <Placeholder title="08 기업관리" /> },
      { path: 'personas', element: <Placeholder title="07 페르소나 관리" /> },
      { path: 'faqs', element: <Placeholder title="09 FAQ 관리" /> },
      { path: 'admins', element: <Placeholder title="10 관리자 권한 관리" /> },
      { path: 'me', element: <Placeholder title="11 내 정보" /> },
      ...(import.meta.env.DEV ? [{ path: 'ui-kit', element: <UiKitPage /> }] : []), // 공통 부품 확인용, 개발 중에만
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
])

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}
