import { useQuery } from '@tanstack/react-query'
import {
  dashboardQueries,
  type Cards,
  type ProcessType,
  type ResponseWait,
  type Stage,
  type StageDropoffs,
} from '@/features/dashboard/api/dashboardApi'
import { num, one, pctText, two } from '@/features/dashboard/format'
import { PROCESS_LABEL, STAGE_LABEL } from '@/features/dashboard/labels'

// 02 대시보드 '그래프 보기' (Figma '통계 · 응답 대기에 쓰인 통화시간' · '통계 · 단계별 이탈률' 11/05)
// 같은 카드 API를 신규(NEW) · 기존(EXISTING)으로 한 번씩 받아 묶음 막대로 비교. 항목 순서 · 이름은 labels.ts (명세가 늘 같은 순서로 줌)

/** 고객군 하나 = 위 평균 칸 + 막대 값 */
interface Series {
  headline: string // 큰 숫자
  sub: string // 그 아래 한 줄
  values: (number | null)[] // 항목마다 (null = 미측정 → 막대 없이 '—')
  labels: string[] // 막대 위 글자
}

/** 응답 대기 — 업무별 막대 = 그 업무 대기 합 ÷ 측정 통화 수(초/통화). 위 평균은 겹친 구간을 뺀 전체 대기 ÷ 측정 통화 수
 *  (명세 §5: 업무별 합을 다시 더해 전체 대기를 만들지 않음 → 막대 합과 위 평균이 조금 다를 수 있음) */
function waitSeries(d: ResponseWait): Series {
  const perCall = (ms: number) => (d.measuredCallCount ? ms / d.measuredCallCount / 1000 : null)
  const values = (Object.keys(PROCESS_LABEL) as ProcessType[]).map((k) => {
    const p = d.processes.find((x) => x.processType === k)
    return p ? perCall(p.totalLatencyMs) : null
  })
  return {
    headline: one(perCall(d.totalWaitMs)),
    sub: `전체 통화시간의 ${pctText(d.waitRatePercent)} · ${num(d.measuredCallCount)}통화`,
    values,
    labels: values.map(two), // 막대 위 초는 두 자리 — 0.04초가 '0.0'으로 보이지 않게 (11/05 사용자)
  }
}

/** 단계별 이탈 — 막대 = 그 단계 이탈 ÷ 판정 완료 통화(%) */
function dropSeries(d: StageDropoffs): Series {
  const values = (Object.keys(STAGE_LABEL) as Stage[]).map(
    (k) => d.stages.find((s) => s.stage === k)?.dropoffRatePercent ?? null,
  )
  return {
    headline: one(d.dropoffRatePercent),
    sub: `판정 ${num(d.assessedCallCount)}통화 중 고객 이탈 ${num(d.dropoffCallCount)}통화`,
    values,
    labels: values.map(pctText),
  }
}

/** 화면마다 다른 글자 · 계산 */
export const GRAPHS = {
  'response-wait': {
    title: '응답 대기에 쓰인 통화시간',
    chart: '업무별 응답 대기시간',
    unit: '초/통화',
    headUnit: '초/통화',
    name: (who: string) => who,
    foot: '업무별 대기시간 ÷ 고객군 측정 통화 수 · 위 평균은 겹친 구간을 뺀 전체 대기로 계산',
    groups: Object.entries(PROCESS_LABEL).map(([key, label]) => ({ key, label })),
    barWidth: 40,
    series: waitSeries,
  },
  'stage-dropoffs': {
    title: '단계별 이탈률',
    chart: '상담 단계별 고객 이탈률',
    unit: '%',
    headUnit: '%',
    name: (who: string) => `${who} · 전체 이탈률`,
    foot: '단계 이탈률 = 해당 단계 이탈 통화 ÷ 판정 완료 통화 × 100 · 고객 중도 종료만 집계',
    groups: Object.entries(STAGE_LABEL).map(([key, label]) => ({ key, label })),
    barWidth: 36,
    series: dropSeries,
  },
} as const

export type GraphKind = keyof typeof GRAPHS

/** 신규 · 기존 두 요청. 둘 다 와야 그림 (하나라도 실패면 0으로 바꾸지 않고 '다시 시도', 명세 §6) */
export function useDashboardGraph<K extends GraphKind>(kind: K) {
  const build = GRAPHS[kind].series as (d: Cards[K]) => Series
  const fresh = useQuery(dashboardQueries.card(kind, 'NEW'))
  const old = useQuery(dashboardQueries.card(kind, 'EXISTING'))
  return {
    ...GRAPHS[kind],
    NEW: fresh.data ? build(fresh.data) : null,
    EXISTING: old.data ? build(old.data) : null,
    failed: fresh.isError || old.isError,
    retry: () => {
      if (fresh.isError) void fresh.refetch()
      if (old.isError) void old.refetch()
    },
  }
}
