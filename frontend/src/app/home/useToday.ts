// 오늘 (첫 화면) — 위: 지금 처리할 일(건수 · 바로 가기) · 오늘 숫자, 아래: AI 상담 성능 요약 (기업 피드백: 통계는 아래로, 운영 정보 먼저)
import { draftLabel, draftList } from '@/features/order/api/draftApi'
import { useQuery } from '@tanstack/react-query'
import { api, type ApiItem, type ApiList } from '@/shared/api/client'
import { kstDayStart, todayYmd } from '@/shared/lib/dateRange'
import { fmtPhone } from '@/shared/lib/format'
import type { CallListItemDto } from '@/shared/call/callDto'
import { dashboardQueries } from '@/features/stats/api/dashboardApi'
import { unansweredQueries } from '@/features/faq/api/unansweredApi'
import { useShell } from '@/shared/lib/shell'
import { dateTime } from '@/shared/lib/when'

const total = (path: string, query: Record<string, string | undefined>) => ({
  queryKey: ['screen', 'today', path, query],
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    api
      .get<ApiList<unknown>>(path, { query: { ...query, limit: 1, offset: 0 }, signal })
      .then((r) => r.total_count),
  refetchInterval: 30_000,
})

export function useToday() {
  const s = useShell()
  const today = kstDayStart(todayYmd())
  const notPaid = useQuery(total('/admin/orders', { statusGroup: 'notPaid' }))
  const failed = useQuery(total('/admin/orders', { statusGroup: 'SUBMISSION_FAILED' }))
  // 오늘 주문 = 홈 API의 실제 주문 수 (057 · 058 뒤 /admin/orders 전체엔 미완료 초안이 섞여 건수가 부풀므로)
  const home = useQuery({
    queryKey: ['screen', 'today', 'home'],
    queryFn: ({ signal }) =>
      api
        .get<ApiItem<{ todayOrderCount: number }>>('/dashboard/home', { signal })
        .then((r) => r.data),
    refetchInterval: 30_000,
  })
  const callsToday = useQuery(total('/calls', { from: today }))
  // 처리할 미완료 주문 (최근 것부터) — 20건 받아 칸 높이에 들어가는 만큼 보임
  // 미완료 = 배송 초안 (055)
  const incomplete = useQuery({
    queryKey: ['screen', 'drafts', 'today'],
    queryFn: ({ signal }) => draftList({ limit: 20, offset: 0 }, signal),
    refetchInterval: 30_000,
  })
  const unanswered = useQuery(unansweredQueries.list())
  // 최근 통화 — 통화 중 · 불만을 바로 봄 (20건 받아 들어가는 만큼)
  const calls = useQuery({
    queryKey: ['screen', 'today', 'calls'],
    queryFn: ({ signal }) =>
      api.get<ApiList<CallListItemDto>>('/calls', { query: { limit: 20, offset: 0 }, signal }),
    refetchInterval: 15_000,
  })
  const complaint = useQuery(dashboardQueries.card('complaint-calls', 'ALL'))
  const dropoff = useQuery(dashboardQueries.card('stage-dropoffs', 'ALL'))
  const regTime = useQuery(dashboardQueries.card('registration-time', 'ALL'))
  const wait = useQuery(dashboardQueries.card('response-wait', 'ALL'))
  const pct = (n: number | null | undefined) => (n == null ? '—' : `${n.toFixed(1)}%`)

  return {
    queue: [
      {
        label: '미완료 주문',
        hint: 'AI 통화가 끊겨 빈 칸이 있는 주문',
        count: s.incomplete,
        to: '/orders?g=COLLECTING&r=all',
        tone: 'idle' as const,
      },
      {
        label: '접수 실패',
        hint: '디버 접수가 끝내 안 된 주문',
        count: failed.data ?? null,
        to: '/orders?g=SUBMISSION_FAILED&r=all',
        tone: 'stop' as const,
      },
      {
        label: '결제 대기',
        hint: '결제 링크를 보냈지만 아직 결제 전',
        count: notPaid.data ?? null,
        to: '/orders?g=notPaid&r=all',
        tone: 'wait' as const,
      },
      {
        label: '미답변 문의',
        hint: 'AI가 답하지 못한 질문',
        count: s.unanswered,
        to: '/unanswered',
        tone: 'wait' as const,
      },
    ],
    live: s.liveCalls ?? 0,
    ordersToday: home.data?.todayOrderCount ?? null,
    callsToday: callsToday.data ?? null,
    incomplete: (incomplete.data?.data ?? []).map((d) => ({
      seq: d.draftSeq,
      to: `/orders?g=COLLECTING&o=d${d.draftSeq}`,
      no: draftLabel(d),
      at: dateTime(d.createdAt),
      who: d.parcel.origin.name ?? '',
      phone: d.parcel.origin.phoneNumber ? fmtPhone(d.parcel.origin.phoneNumber) : '',
    })),
    unanswered: (unanswered.data ?? []).slice(0, 20).map((u) => ({
      seq: u.unansweredQuestionSeq,
      call: u.callSessionSeq,
      question: u.question,
      at: dateTime(u.startedAt),
    })),
    calls: (calls.data?.data ?? []).map((c) => ({
      seq: c.callSessionSeq,
      name: c.customerName ?? '',
      at: dateTime(c.startedAt),
      live: !!c.startedAt && !c.endedAt,
      complaint: (c.analysis?.complaints.length ?? 0) > 0,
    })),
    perf: [
      { label: '불편을 표현한 통화', value: pct(complaint.data?.complaintRatePercent) },
      { label: '중간에 끊은 통화', value: pct(dropoff.data?.dropoffRatePercent) },
      {
        label: '배송 1건 접수에 걸린 시간',
        value:
          regTime.data?.averageSecondsPerParcel == null
            ? '—'
            : `${Math.round(regTime.data.averageSecondsPerParcel)}초`,
      },
      { label: '통화 중 AI 응답 대기', value: pct(wait.data?.waitRatePercent) },
    ],
  }
}
