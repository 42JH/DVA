// 01 홈 Model — 오늘 숫자. React를 모르는 데이터 · API 층 (처리할 AI 미답변은 09 데이터를 그대로 씀 → features/faq)
// 통계 API가 없음(연동 상세명세 §10, 백엔드 11/01: '우선 프론트에서 집계') → 02 대시보드와 같은 방식:
// API-21 GET /calls를 조건별로 1건만 받아 total_count로 셈. 평균 통화 시간 · 되묻기는 목록으로 못 셈 → 화면에서 '집계 API 없음'
import { queryOptions } from '@tanstack/react-query'
import { api, type ApiList } from '@/shared/api/client'
import { addDays, kstDayStart, todayYmd } from '@/shared/lib/dateRange'

/** 오늘 0시부터 지금까지, 통화 시작 시각 기준 (한국 시각) */
export interface TodayStats {
  successCount: number // 접수 성공 (result=REGISTERED)
  failedCount: number // 접수 실패 (REGISTRATION_FAILED)
  handoffCount: number // 상담원 이관 (HANDOFF)
  complaintCount: number // 불만이 확인된 통화 (hasComplaint=true, 위 셋과 겹칠 수 있음)
}

export const homeQueries = {
  all: () => ['home'] as const,
  today: () =>
    queryOptions({
      queryKey: [...homeQueries.all(), 'today'],
      queryFn: ({ signal }) => fetchTodayStats(signal),
    }),
}

/** 조건에 맞는 오늘 통화 수 — 1건만 받고 total_count만 씀 */
async function countToday(filter: Record<string, string | boolean>, signal?: AbortSignal) {
  const today = todayYmd()
  const res = await api.get<ApiList<unknown>>('/calls', {
    query: { from: kstDayStart(today), to: kstDayStart(addDays(today, 1)), limit: 1, ...filter },
    signal,
  })
  return res.total_count
}

export async function fetchTodayStats(signal?: AbortSignal): Promise<TodayStats> {
  const [successCount, failedCount, handoffCount, complaintCount] = await Promise.all([
    countToday({ result: 'REGISTERED' }, signal),
    countToday({ result: 'REGISTRATION_FAILED' }, signal),
    countToday({ result: 'HANDOFF' }, signal),
    countToday({ hasComplaint: true }, signal),
  ])
  return { successCount, failedCount, handoffCount, complaintCount }
}
