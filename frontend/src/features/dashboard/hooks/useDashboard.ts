import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { fmtDuration } from '@/shared/lib/format'
import {
  dashboardQueries,
  type ComplaintCalls,
  type RegistrationTime,
  type ResponseWait,
  type StageDropoffs,
  type VersionTime,
} from '@/features/dashboard/api/dashboardApi'
import {
  hoursMinutes,
  maxIndex,
  num,
  one,
  pct2,
  pctText,
  two,
  versionGap,
} from '@/features/dashboard/format'
import { COMPLAINT, PROCESS_LABEL, STAGE_LABEL } from '@/features/dashboard/labels'

const sec = (s: number | null) => (s === null ? '—' : `${one(s)}초`)
const sec2 = (s: number | null) => (s === null ? '—' : `${two(s)}초`) // 응답 대기 표

/** 02 대시보드 'AI 상담 성능' 훅 — 카드 네 장 = 네 요청을 동시에. 고객 탭이 없어 늘 전체(customerType=ALL, 11/05 디자인)
 *  신규 · 기존 비교는 '그래프 보기' 화면(useDashboardGraph) */
export function useDashboard() {
  return {
    dropOff: card(useQuery(dashboardQueries.card('stage-dropoffs', 'ALL')), dropOffView),
    registration: card(
      useQuery(dashboardQueries.card('registration-time', 'ALL')),
      registrationView,
    ),
    complaint: card(useQuery(dashboardQueries.card('complaint-calls', 'ALL')), complaintView),
    wait: card(useQuery(dashboardQueries.card('response-wait', 'ALL')), waitView),
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
    value: two(d.dropoffRatePercent),
    note:
      `판정 ${num(d.assessedCallCount)}건 중 고객 이탈 ${num(d.dropoffCallCount)}건` +
      (d.unassessedCallCount ? ` · 미판정 ${num(d.unassessedCallCount)}건 제외` : ''),
    rows: d.stages.map((s, i) => ({
      key: s.stage,
      cells: [STAGE_LABEL[s.stage], `${num(s.callCount)}건`, pct2(s.dropoffRatePercent)],
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
    sub: `${tag} · 접수 ${num(v.registeredParcelCount)}건`,
  })
  return {
    value: one(d.averageSecondsPerParcel),
    note:
      `접수 ${num(d.registeredParcelCount)}건` +
      (d.averageSecondsPerParcel === null
        ? ''
        : ` · 평균 ${fmtDuration(Math.round(d.averageSecondsPerParcel))}`),
    bars: [
      ...(current ? [bar(current, '현재 운영')] : []),
      ...(previous ? [bar(previous, '직전 버전')] : []),
    ],
    callout: versionGap(d.comparison.previousMinusCurrentSeconds),
    foot:
      '접수가 있는 통화의 전체 통화시간 ÷ 접수 배송 건수 · FAQ · 조회 시간 포함' +
      (d.unmeasuredCallCount ? ` · 접수 건수 미수신 ${num(d.unmeasuredCallCount)}통화 제외` : ''),
  }
}

/** §4 — 상단 = 불편 통화 비율(과거 유형 포함), 도넛 = 여섯 유형 통화 수 합 안의 구성비. 범례 색칠 = 가장 많은 유형 */
function complaintView(d: ComplaintCalls) {
  const hot = maxIndex(d.types.map((t) => t.callCount))
  return {
    value: one(d.complaintRatePercent),
    ratio: `불편 ${num(d.complaintCallCount)} / 판정 완료 ${num(d.assessedCallCount)}통화`,
    excluded: `미판정 ${num(d.unassessedCallCount)}통화 제외`,
    total: num(d.typeTotalCount),
    slices: d.types.map((t, i) => ({
      key: t.type,
      ...COMPLAINT[t.type],
      value: t.callCount,
      count: num(t.callCount),
      share: pctText(t.sharePercent),
      hot: i === hot,
    })),
    foot: [
      `원형 비율은 유형별 집계 ${num(d.typeTotalCount)}건 대비 · 한 통화에 여러 유형을 포함합니다.`,
      `통화율 ${pctText(d.complaintRatePercent)} = 불편 ${num(d.complaintCallCount)} / 판정 완료 ${num(d.assessedCallCount)}` +
        (d.legacyTypeCallCount
          ? ` · 기존 분류 ${num(d.legacyTypeCallCount)}통화 포함(원형 제외)`
          : ''),
    ],
  }
}

/** §5 — P95 없이 평균 대기만. 줄 색칠 = 평균 대기가 가장 긴 처리 */
function waitView(d: ResponseWait) {
  const hot = maxIndex(d.processes.map((p) => p.averageLatencyMs ?? 0))
  return {
    value: two(d.waitRatePercent),
    note: `총 대기 ${hoursMinutes(d.totalWaitMs / 1000)} · 전체 통화 ${hoursMinutes(d.totalCallDurationMs / 1000)}`,
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
      (d.unmeasuredCallCount ? ` · 미수신 ${num(d.unmeasuredCallCount)}통화 제외` : '') +
      (d.invalidWaitCallCount ? ` · 시각 확인 필요 ${num(d.invalidWaitCallCount)}통화 제외` : ''),
  }
}

export type DropOffView = ReturnType<typeof dropOffView>
export type RegistrationView = ReturnType<typeof registrationView>
export type ComplaintView = ReturnType<typeof complaintView>
export type WaitView = ReturnType<typeof waitView>
