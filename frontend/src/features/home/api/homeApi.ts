// 01 홈 Model — 오늘 숫자. React를 모르는 데이터 · API 층 (처리할 AI 미답변은 09 데이터를 그대로 씀 → features/faq)
// 통계 API가 없음(연동 상세명세 §10, 백엔드 11/01: '우선 프론트에서 집계') → 02 대시보드와 같은 방식:
// API-21 GET /calls를 조건별로 1건만 받아 total_count로 셈. 평균 통화 시간은 오늘 목록 전체로 화면에서 냄 (11/02, 02와 같은 계산)
// 평균 되묻기는 아직 '집계 API 없음' (11/02 사용자: 통화 시간만)
import { queryOptions } from '@tanstack/react-query'
import { api, type ApiList } from '@/shared/api/client'
import { fetchAll } from '@/shared/api/paging'
import { avgDurationSec } from '@/shared/lib/callStats'
import { addDays, kstDayStart, todayYmd } from '@/shared/lib/dateRange'

/** 오늘 0시부터 지금까지, 통화 시작 시각 기준 (한국 시각) */
export interface TodayStats {
  successCount: number // 접수 성공 (result=REGISTERED)
  failedCount: number // 접수 실패 (REGISTRATION_FAILED)
  handoffCount: number // 상담원 이관 (HANDOFF)
  complaintCount: number // 불만이 확인된 통화 (hasComplaint=true, 위 셋과 겹칠 수 있음)
  avgDurationSec: number | null // 오늘 끝난 통화의 평균 통화 시간(초), 끝난 통화가 없으면 null
}

export const homeQueries = {
  all: () => ['home'] as const,
  today: () =>
    queryOptions({
      queryKey: [...homeQueries.all(), 'today'],
      queryFn: ({ signal }) => fetchTodayStats(signal),
    }),
  /** 검색 추천 밑천 — 오늘 주문의 보내는 분 · 받는 분 이름 (검색은 03 주문 내역으로 가고 03 기본 기간이 오늘이라 같은 범위). 칠 때만 받고 5분 재사용 */
  searchNames: () =>
    queryOptions({
      queryKey: [...homeQueries.all(), 'searchNames'],
      queryFn: ({ signal }) => fetchTodayOrderNames(signal),
      staleTime: 5 * 60_000,
    }),
}

/** 주문 목록에서 이름만 (API AdminOrderListItem — 03과 같은 응답, feature끼리 import하지 않게 필요한 칸만) */
interface OrderNamesDto {
  parcels: { origin: { name: string | null }; destination: { name: string | null } }[]
}
async function fetchTodayOrderNames(signal?: AbortSignal): Promise<string[]> {
  const today = todayYmd()
  const orders = await fetchAll<OrderNamesDto>(
    '/admin/orders',
    { from: `${today}T00:00:00+09:00`, to: `${addDays(today, 1)}T00:00:00+09:00` },
    signal,
  )
  const names = orders.flatMap((o) => o.parcels.flatMap((p) => [p.origin.name, p.destination.name]))
  return [...new Set(names.filter((n): n is string => !!n))]
}

/** 오늘 0시 ~ 내일 0시 (한국 시각) */
function todayBounds() {
  const today = todayYmd()
  return { from: kstDayStart(today), to: kstDayStart(addDays(today, 1)) }
}

/** 조건에 맞는 오늘 통화 수 — 1건만 받고 total_count만 씀 */
async function countToday(filter: Record<string, string | boolean>, signal?: AbortSignal) {
  const res = await api.get<ApiList<unknown>>('/calls', {
    query: { ...todayBounds(), limit: 1, ...filter },
    signal,
  })
  return res.total_count
}

export async function fetchTodayStats(signal?: AbortSignal): Promise<TodayStats> {
  const [successCount, failedCount, handoffCount, complaintCount, rows] = await Promise.all([
    countToday({ result: 'REGISTERED' }, signal),
    countToday({ result: 'REGISTRATION_FAILED' }, signal),
    countToday({ result: 'HANDOFF' }, signal),
    countToday({ hasComplaint: true }, signal),
    // shortcut: fetchAll 2,000건 상한 — 하루 ~130건이라 안 걸림. 하루 2,000건을 넘기면 집계 API로 바꿀 것
    fetchAll<{ startedAt: string | null; endedAt: string | null }>('/calls', todayBounds(), signal),
  ])
  return {
    successCount,
    failedCount,
    handoffCount,
    complaintCount,
    avgDurationSec: avgDurationSec(rows),
  }
}
