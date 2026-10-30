import { http, HttpResponse } from 'msw'
import { API_BASE_URL } from '@/shared/api/client'

// 가짜 01 홈 오늘 숫자 — 와이어프레임 01 예시 값. 경로 · 모양은 features/home/api/homeApi.ts의 가정과 같음 (명세 확인 전)
export const homeHandlers = [
  http.get(`${API_BASE_URL}/stats/today`, () =>
    HttpResponse.json({
      data: {
        successCount: 12345,
        failedCount: 214,
        handoffCount: 87,
        complaintCount: 8,
        avgCallSeconds: 1.4,
        avgReaskCount: 1.3,
      },
    }),
  ),
]
