import { http, HttpResponse } from 'msw'
import { API_BASE_URL } from '@/shared/api/client'

// 가짜 01 홈 오늘 숫자 — 04 통화 내역 · 02 대시보드의 '오늘' 가짜와 같은 값 (카드를 눌러 04로 가도 건수가 맞게). 경로 · 모양은 features/home/api/homeApi.ts의 가정과 같음 (명세 확인 전)
export const homeHandlers = [
  http.get(`${API_BASE_URL}/stats/today`, () =>
    HttpResponse.json({
      data: {
        successCount: 96,
        failedCount: 12,
        handoffCount: 5,
        complaintCount: 8,
        avgCallSeconds: 171,
        avgReaskCount: 1.3,
      },
    }),
  ),
]
