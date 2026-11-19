import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { fmtDuration } from '@/shared/lib/format'
import {
  dashboardQueries,
  type RegistrationTime,
  type ResponseWait,
  type StageDropoffs,
  type VersionTime,
} from '@/features/stats/api/dashboardApi'
import { hoursMinutes, maxIndex, num, one, pctText, two, versionGap } from '@/features/stats/format'
import { PROCESS_LABEL, STAGE_LABEL } from '@/features/stats/labels'
import { FETCH_ALL_MAX } from '@/shared/api/paging'
import type { CallListItemDto } from '@/shared/call/callDto'
import { complaintView } from '@/features/stats/complaintView'

const sec = (s: number | null) => (s === null ? '—' : `${one(s)}초`)
const sec2 = (s: number | null) => (s === null ? '—' : `${two(s)}초`) // 응답 대기 카드 표의 평균 대기만 두 자리 (0.02초처럼 작은 값)

/** 02 대시보드 'AI 상담 성능' 훅 — 카드 네 장 = 네 요청을 동시에. 고객 탭이 없어 늘 전체(customerType=ALL, 11/05 디자인)
 *  신규 · 기존 비교는 '그래프 보기' 화면(useDashboardGraph) */
export function useDashboard() {
  return {
    dropOff: card(useQuery(dashboardQueries.card('stage-dropoffs', 'ALL')), dropOffView),
    registration: card(
      useQuery(dashboardQueries.card('registration-time', 'ALL')),
      registrationView,
    ),
    // 판정 수(서버 통계)와 불만 있는 통화 목록이 둘 다 와야 그림 — 탭을 넘길 때 따로 기다리지 않게
    complaint: both(
      useQuery(dashboardQueries.card('complaint-calls', 'ALL')),
      useQuery(dashboardQueries.complainedCalls()),
      (d, calls: CallListItemDto[]) => ({
        ...complaintView(d, calls),
        capped: calls.length >= FETCH_ALL_MAX, // 받은 통화가 상한 — 그 안에서 센 값
      }),
    ),
    wait: card(useQuery(dashboardQueries.card('response-wait', 'ALL')), waitView),
  }
}

/** 두 요청을 합친 카드 하나 — 둘 다 와야 값, 하나라도 실패면 다시 시도 */
function both<A, B, V>(
  a: UseQueryResult<A>,
  b: UseQueryResult<B>,
  view: (a: A, b: B) => V,
): CardState<V> {
  return {
    view: a.data && b.data ? view(a.data, b.data) : null,
    stale: a.isPlaceholderData || b.isPlaceholderData,
    failed: (a.isError && !a.data) || (b.isError && !b.data),
    retry: () => {
      void a.refetch()
      void b.refetch()
    },
  }
}

/** 카드 하나의 상태 — 값 · 처음 받는 중 · 실패(0으로 바꾸지 않고 다시 시도, 명세 §6) */
function card<T, V>(q: UseQueryResult<T>, view: (d: T) => V): CardState<V> {
  return {
    view: q.data ? view(q.data) : null,
    stale: q.isPlaceholderData,
    failed: q.isError && !q.data,
    retry: () => void q.refetch(),
  }
}
export interface CardState<V> {
  view: V | null
  stale: boolean
  failed: boolean
  retry: () => void
}

/** §2 — 줄 색칠 = 이탈 통화가 가장 많은 단계 (가장 많이 잃는 곳) */
function dropOffView(d: StageDropoffs) {
  const hot = maxIndex(d.stages.map((s) => s.callCount))
  return {
    value: one(d.dropoffRatePercent),
    note:
      `판정 ${num(d.assessedCallCount)}건 중 고객 이탈 ${num(d.dropoffCallCount)}건` +
      (d.unassessedCallCount ? `, 미판정 ${num(d.unassessedCallCount)}건 제외` : ''),
    rows: d.stages.map((s, i) => ({
      key: s.stage,
      cells: [STAGE_LABEL[s.stage], `${num(s.callCount)}건`, pctText(s.dropoffRatePercent)],
      hot: i === hot,
    })),
  }
}

/** §3 — 막대 = 현재 운영 버전 · 직전 버전 (있는 것만). 평균이 없는 버전은 막대 없이 '—' (0초로 안 그림) */
function registrationView(d: RegistrationTime) {
  const { current, previous } = d.comparison
  const bar = (v: VersionTime, tag: string) => ({
    key: `${tag}-${v.aiPersonaVersionSeq}`,
    name: `${v.name} v${v.version}`,
    value: v.averageSecondsPerParcel,
    label: sec(v.averageSecondsPerParcel),
    sub: `${tag}, 접수 ${num(v.registeredParcelCount)}건`,
  })
  return {
    value: one(d.averageSecondsPerParcel),
    note:
      `접수 ${num(d.registeredParcelCount)}건` +
      (d.averageSecondsPerParcel === null
        ? ''
        : `, 평균 ${fmtDuration(Math.round(d.averageSecondsPerParcel))}`),
    bars: [
      ...(current ? [bar(current, '현재 운영')] : []),
      ...(previous ? [bar(previous, '직전 버전')] : []),
    ],
    callout: versionGap(d.comparison.previousMinusCurrentSeconds),
    foot:
      '접수가 있는 통화의 전체 통화시간 ÷ 접수 배송 건수, FAQ와 조회 시간 포함' +
      (d.unmeasuredCallCount ? `, 접수 건수 미수신 ${num(d.unmeasuredCallCount)}통화 제외` : ''),
  }
}

/** §5 — P95 없이 평균 대기만. 줄 색칠 = 평균 대기가 가장 긴 처리 */
function waitView(d: ResponseWait) {
  const hot = maxIndex(d.processes.map((p) => p.averageLatencyMs ?? 0))
  return {
    value: one(d.waitRatePercent),
    note: `총 대기 ${hoursMinutes(d.totalWaitMs / 1000)}, 전체 통화 ${hoursMinutes(d.totalCallDurationMs / 1000)}`,
    rows: d.processes.map((p, i) => ({
      key: p.processType,
      cells: [
        PROCESS_LABEL[p.processType],
        `${num(p.measurementCount)}회`,
        sec2(p.averageLatencyMs === null ? null : p.averageLatencyMs / 1000),
      ],
      hot: i === hot,
    })),
    foot:
      `측정 ${num(d.measuredCallCount)}통화 기준` +
      (d.unmeasuredCallCount ? `, 미수신 ${num(d.unmeasuredCallCount)}통화 제외` : '') +
      (d.invalidWaitCallCount ? `, 시각 확인 필요 ${num(d.invalidWaitCallCount)}통화 제외` : ''),
  }
}

export type DropOffView = ReturnType<typeof dropOffView>
export type RegistrationView = ReturnType<typeof registrationView>
export type ComplaintView = ReturnType<typeof complaintView> & { capped: boolean }
export type WaitView = ReturnType<typeof waitView>
