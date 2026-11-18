import { http, HttpResponse } from 'msw'
import { API_BASE_URL } from '@/shared/api/client'
import type { Cards, CustomerType } from '@/features/stats/api/dashboardApi'
import { demoCard } from '@/features/stats/api/dashboardDemo'

// 가짜 02 대시보드 'AI 상담 성능' — 대시보드 프론트 연동 명세(BE feature/ai-dashboard) 모양 그대로: 카드마다 GET 하나 · customerType만 · 단건 { data, meta }
// 모르는 쿼리 · 중복 · 빈 값 · 이상한 customerType은 400 INVALID_REQUEST (명세 §1). 숫자는 통계 목데이터(dashboardDemo.ts)와 같음

const CARDS: (keyof Cards)[] = [
  'stage-dropoffs',
  'registration-time',
  'complaint-calls',
  'response-wait',
]
const CUSTOMER_TYPES: CustomerType[] = ['ALL', 'NEW', 'EXISTING']

const meta = () => ({ requestId: crypto.randomUUID() })

export const dashboardHandlers = CARDS.map((card) =>
  http.get(`${API_BASE_URL}/dashboard/${card}`, ({ request }) => {
    const q = new URL(request.url).searchParams
    const values = q.getAll('customerType')
    const t = (values[0] ?? 'ALL') as CustomerType // 생략 = ALL
    if (
      [...q.keys()].some((k) => k !== 'customerType') ||
      values.length > 1 ||
      !CUSTOMER_TYPES.includes(t)
    )
      return HttpResponse.json(
        {
          error: { code: 'INVALID_REQUEST', message: '요청 값을 확인해 주세요.', details: [] },
          meta: meta(),
        },
        { status: 400 },
      )
    return HttpResponse.json(
      { data: demoCard(card, t), meta: meta() },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  }),
)

// 홈 (GET /dashboard/home, 백엔드 11/09) — 다른 가짜 응답을 모아 같은 모양으로 (미리보기 11개씩)
export const homeHandler = http.get(`${API_BASE_URL}/dashboard/home`, async ({ request }) => {
  const base = new URL(request.url).origin + API_BASE_URL
  const get = (path: string) => fetch(base + path).then((r) => r.json())
  const today = `${new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10)}T00:00:00+09:00`
  const [orders, ordersToday, callsToday, calls, drafts, unanswered, ...cards] = await Promise.all([
    get('/admin/orders?limit=1'),
    get(`/admin/orders?limit=100&from=${encodeURIComponent(today)}`),
    get(`/calls?limit=1&from=${encodeURIComponent(today)}`),
    get('/calls?limit=11'),
    get('/parcel-drafts?status=INCOMPLETE&limit=11'),
    get('/unanswered-questions?limit=11'),
    ...(['stage-dropoffs', 'registration-time', 'complaint-calls', 'response-wait'] as const).map(
      (c) => get(`/dashboard/${c}`),
    ),
  ])
  const real = (ordersToday.data as { draftSeq: number | null }[]).filter((o) => o.draftSeq == null)
  return HttpResponse.json({
    data: {
      observedAt: new Date().toISOString(),
      todayOrderCount: real.length,
      todayCallCount: callsToday.total_count,
      pendingWork: {
        incomplete: orders.statusCounts.incomplete,
        notPaid: orders.statusCounts.notPaid,
        submissionFailed: orders.statusCounts.submissionFailed,
        unansweredQuestions: unanswered.total_count,
      },
      recentCalls: calls.data,
      incompleteDrafts: drafts.data,
      unansweredQuestions: unanswered.data,
      aiPerformance: {
        stageDropoffs: cards[0].data,
        registrationTime: cards[1].data,
        complaintCalls: cards[2].data,
        responseWait: cards[3].data,
      },
    },
    meta: meta(),
  })
})
