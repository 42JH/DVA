// 01 홈 Model — 오늘 숫자. React를 모르는 데이터 · API 층 (처리할 AI 미답변은 09 데이터를 그대로 씀 → features/faq)
// shortcut: 홈 API는 명세서 확인 전이라 경로 · 응답 모양이 가정값(BE 요청안). 명세가 오면 이 파일과 mocks/handlers/home.ts만 고친다
import { queryOptions } from '@tanstack/react-query'
import { api, type ApiItem } from '@/shared/api/client'

/** 오늘 0시부터 지금까지, 통화 시작 시각 기준 */
export interface TodayStats {
  successCount: number // 접수 성공
  failedCount: number // 접수 실패
  handoffCount: number // 상담원 이관
  complaintCount: number // 불만 감지된 통화 (위 셋과 겹칠 수 있음)
  avgCallSeconds: number
  avgReaskCount: number // 평균 되묻기 횟수
}

export const homeQueries = {
  all: () => ['home'] as const,
  today: () =>
    queryOptions({
      queryKey: [...homeQueries.all(), 'today'],
      queryFn: ({ signal }) => fetchTodayStats(signal),
    }),
}

export async function fetchTodayStats(signal?: AbortSignal): Promise<TodayStats> {
  return (await api.get<ApiItem<TodayStats>>('/stats/today', { signal })).data
}
