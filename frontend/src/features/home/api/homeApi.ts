// 01 홈 Model — 오늘 숫자 · 처리할 AI 미답변. React를 모르는 데이터 · API 층
// shortcut: 홈 API는 명세서 확인 전이라 경로 · 응답 모양이 가정값(BE 요청안). 명세가 오면 이 파일과 mocks/handlers/home.ts만 고친다
import { queryOptions } from '@tanstack/react-query'
import { api, type ApiItem, type ApiList } from '@/shared/api/client'

/** 오늘 0시부터 지금까지, 통화 시작 시각 기준 */
export interface TodayStats {
  successCount: number // 접수 성공
  failedCount: number // 접수 실패
  handoffCount: number // 상담원 이관
  complaintCount: number // 불만 감지된 통화 (위 셋과 겹칠 수 있음)
  avgCallSeconds: number
  avgReaskCount: number // 평균 되묻기 횟수
}

/** AI가 답하지 못한 질문 중 조치 필요 (05 통화 문의 AI 미답변 탭과 같은 데이터) */
export interface UnansweredQuestion {
  callSeq: number
  startedAt: string // ISO 8601
  customerName: string
  callerPhone: string // 숫자만
  question: string
}

export const UNANSWERED_PREVIEW = 6 // 홈 미리보기 6줄 (와이어프레임 01)

export const homeQueries = {
  all: () => ['home'] as const,
  today: () =>
    queryOptions({
      queryKey: [...homeQueries.all(), 'today'],
      queryFn: ({ signal }) => fetchTodayStats(signal),
    }),
  unanswered: () =>
    queryOptions({
      queryKey: [...homeQueries.all(), 'unanswered'],
      queryFn: ({ signal }) => fetchUnanswered(signal),
    }),
}

export async function fetchTodayStats(signal?: AbortSignal): Promise<TodayStats> {
  return (await api.get<ApiItem<TodayStats>>('/stats/today', { signal })).data
}

/** 미처리 전체 기간, 오래된 순 앞 6개. 'n개'는 totalCount (대조표 D2) */
export function fetchUnanswered(signal?: AbortSignal): Promise<ApiList<UnansweredQuestion>> {
  return api.get<ApiList<UnansweredQuestion>>('/inquiries/unanswered', {
    query: { limit: UNANSWERED_PREVIEW, offset: 0 },
    signal,
  })
}
