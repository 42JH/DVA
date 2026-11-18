import { QueryClient } from '@tanstack/react-query'
import { ApiError } from './client'

// 명세서 1.6: 조회만 재시도 — 연결 실패(0) · 429 · 503일 때 최대 2번. 등록 · 수정은 재시도 안 함
// ponytail: Retry-After 헤더는 아직 안 따름(기본 지수 대기). 백엔드가 429에 Retry-After를 주면 retryDelay에 반영
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, e) => count < 2 && e instanceof ApiError && [0, 429, 503].includes(e.status),
    },
    mutations: { retry: false },
  },
})
