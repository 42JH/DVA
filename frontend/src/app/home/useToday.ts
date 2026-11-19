// 오늘 (첫 화면) — 위: 지금 처리할 일(건수 · 바로 가기) · 오늘 숫자, 아래: AI 상담 성능 요약 (기업 피드백: 통계는 아래로, 운영 정보 먼저)
// 데이터는 홈 API 한 번 (GET /dashboard/home, 백엔드 11/09) — 모든 칸이 같은 조회 시점(observedAt)
import { draftLabel, type ParcelDraftDto } from '@/shared/order/draftApi'
import { useQuery } from '@tanstack/react-query'
import { api, type ApiItem } from '@/shared/api/client'
import { fmtPhone } from '@/shared/lib/format'
import type { CallListItemDto } from '@/shared/call/callDto'
import { dashboardQueries, type Cards } from '@/features/stats/api/dashboardApi'
import { complaintView } from '@/features/stats/complaintView'
import { toScreen, type UnansweredDto } from '@/features/faq/api/unansweredApi'
import { useShell } from '@/shared/lib/shell'
import { dateTime } from '@/shared/lib/when'
import { callState } from '@/features/call/callState'

interface HomeDto {
  observedAt: string
  todayOrderCount: number // 오늘(한국 시간) 만든 실제 주문 — 미완료 초안 제외
  todayCallCount: number
  pendingWork: {
    incomplete: number
    notPaid: number
    submissionFailed: number
    unansweredQuestions: number
  }
  recentCalls: CallListItemDto[] // 최대 11
  incompleteDrafts: ParcelDraftDto[] // 최대 11
  unansweredQuestions: UnansweredDto[] // 최대 11, 오래된 통화부터
  aiPerformance: {
    stageDropoffs: Cards['stage-dropoffs']
    registrationTime: Cards['registration-time']
    complaintCalls: Cards['complaint-calls']
    responseWait: Cards['response-wait']
  }
}

export function useToday() {
  const s = useShell()
  const home = useQuery({
    queryKey: ['screen', 'today', 'home'],
    queryFn: ({ signal }) =>
      api.get<ApiItem<HomeDto>>('/dashboard/home', { signal }).then((r) => r.data),
    refetchInterval: 15_000, // 최근 통화(통화 중)가 너무 늦지 않게
  })
  const h = home.data
  const complained = useQuery(dashboardQueries.complainedCalls()) // 통계 카드와 같은 캐시
  const pct = (n: number | null | undefined) => (n == null ? '—' : `${n.toFixed(1)}%`)
  const pctOf = (v: string) => (v === '—' ? v : `${v}%`)

  return {
    queue: [
      {
        label: '미완료 주문',
        hint: 'AI 통화가 끊겨 빈 칸이 있는 주문',
        count: h?.pendingWork.incomplete ?? null,
        to: '/orders?g=COLLECTING&r=all',
        tone: 'idle' as const,
      },
      {
        label: '접수 실패',
        hint: '디버 접수가 끝내 안 된 주문',
        count: h?.pendingWork.submissionFailed ?? null,
        to: '/orders?g=SUBMISSION_FAILED&r=all',
        tone: 'stop' as const,
      },
      {
        label: '결제 대기',
        hint: '결제 링크를 보냈지만 아직 결제 전',
        count: h?.pendingWork.notPaid ?? null,
        to: '/orders?g=notPaid&r=all',
        tone: 'wait' as const,
      },
      {
        label: '미답변 문의',
        hint: 'AI가 답하지 못한 질문',
        count: h?.pendingWork.unansweredQuestions ?? null,
        to: '/unanswered',
        tone: 'wait' as const,
      },
    ],
    live: s.liveCalls ?? 0,
    ordersToday: h?.todayOrderCount ?? null,
    callsToday: h?.todayCallCount ?? null,
    incomplete: (h?.incompleteDrafts ?? []).map((d) => ({
      seq: d.draftSeq,
      to: `/orders?g=COLLECTING&o=d${d.draftSeq}`,
      no: draftLabel(d),
      at: dateTime(d.createdAt),
      who: d.parcel.origin.name ?? '',
      phone: d.parcel.origin.phoneNumber ? fmtPhone(d.parcel.origin.phoneNumber) : '',
    })),
    unanswered: (h?.unansweredQuestions ?? []).map(toScreen).map((u) => ({
      seq: u.unansweredQuestionSeq,
      call: u.callSessionSeq,
      question: u.question,
      at: dateTime(u.startedAt),
    })),
    calls: (h?.recentCalls ?? []).map((c) => ({
      seq: c.callSessionSeq,
      name: c.customerName ?? '',
      at: dateTime(c.startedAt),
      live: callState(c).label === '통화 중', // 목록 · 상세와 같은 기준
      // 고객 불만이 있을 때만 (AI 응대 오류 · 근거 없는 답변은 빼고, 11/11 Jira 148)
      complaint: (c.analysis?.complaints ?? []).some(
        (x) => x.type === 'DISSATISFACTION_EXPRESSION' && !!x.target, // 최신 판정본만
      ),
    })),
    perf: [
      // 통계 [AI 응대 오류] 탭과 같은 값 — 서버 비율은 AI 응대 불만까지 섞여 있어 통계처럼 목록으로 셈
      {
        label: 'AI 응대 오류가 난 통화',
        value: pctOf(
          h && complained.data
            ? complaintView(h.aiPerformance.complaintCalls, complained.data).tabs[0].value
            : '—',
        ),
      },
      { label: '중간에 끊은 통화', value: pct(h?.aiPerformance.stageDropoffs.dropoffRatePercent) },
      {
        label: '배송 1건 접수에 걸린 시간',
        value:
          h?.aiPerformance.registrationTime.averageSecondsPerParcel == null
            ? '—'
            : `${Math.round(h.aiPerformance.registrationTime.averageSecondsPerParcel)}초`,
      },
      { label: '통화 중 AI 응답 대기', value: pct(h?.aiPerformance.responseWait.waitRatePercent) },
    ],
  }
}
