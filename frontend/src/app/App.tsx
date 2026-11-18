import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from 'react-router/dom'
import { queryClient } from '@/shared/api/queryClient'
import { router } from './router'

// Provider + 라우터만. 라우트 표는 router.tsx, QueryClient 기본값은 shared/api/queryClient.ts
export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}
