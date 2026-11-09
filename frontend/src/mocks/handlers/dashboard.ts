import { http, HttpResponse } from 'msw'
import { API_BASE_URL } from '@/shared/api/client'
import type {
  ComplaintCalls,
  CustomerType,
  ProcessType,
  RegistrationTime,
  ResponseWait,
  Stage,
  StageDropoffs,
  VersionTime,
} from '@/features/stats/api/dashboardApi'

// 가짜 02 대시보드 'AI 상담 성능' — 대시보드 프론트 연동 명세(BE feature/ai-dashboard) 모양 그대로: 카드마다 GET 하나 · customerType만 · 단건 { data, meta }
// 모르는 쿼리 · 중복 · 빈 값 · 이상한 customerType은 400 INVALID_REQUEST (명세 §1). 비율 · 평균은 서버처럼 반올림 없이 계산
// 신규 · 기존 고객 = Figma 예시 수치(11/04 'AI 상담 성능' · 11/05 '그래프 보기')에 맞춤, 미분류 = 지어낸 값, 전체 = 셋을 더함
// 비교 버전 = 빠른 접수형 v6(적용 중) · v5(직전) — personas.ts와 같음

const STAGES: Stage[] = [
  'SENDER_INFO',
  'RECIPIENT_INFO',
  'ITEM_INFO',
  'CONFIRMATION',
  'PAYMENT_GUIDANCE',
  'FAQ_ANSWER',
  'ORDER_LOOKUP',
  'ORDER_CANCEL',
]
const TYPES: ComplaintCalls['types'][number]['type'][] = [
  'INFORMATION_RECOGNITION_ERROR',
  'INTENT_RECOGNITION_ERROR',
  'UNSUPPORTED_ANSWER',
  'SLOW_RESPONSE',
  'INTERRUPTION',
  'DISSATISFACTION_EXPRESSION',
]
const PROCESSES: ProcessType[] = [
  'CUSTOMER_LOOKUP',
  'INFORMATION_INPUT',
  'FAQ_LOOKUP',
  'ORDER_LOOKUP',
  'ORDER_CANCEL',
  'ADDRESS_LOOKUP',
  'ORDER_SAVE',
]
const V6 = { aiPersonaVersionSeq: 6, aiPersonaSeq: 1, name: '빠른 접수형', version: 6 }
const V5 = { aiPersonaVersionSeq: 5, aiPersonaSeq: 1, name: '빠른 접수형', version: 5 }

/** 고객 구분 하나의 원래 건수 · 합계 (비율 · 평균은 아래 build가 계산) */
type Ver = { calls: number; parcels: number; ms: number }
interface Raw {
  ended: number
  stage: { assessed: number; drops: number[] } // drops = STAGES 순서
  reg: { calls: number; unmeasured: number; parcels: number; ms: number; v6: Ver; v5: Ver }
  complaint: { assessed: number; calls: number; legacy: number; types: number[] } // types = TYPES 순서
  wait: {
    measured: number
    unmeasured: number
    invalid: number
    waitMs: number
    callMs: number
    processes: [count: number, totalMs: number][] // PROCESSES 순서
  }
}

const NEW: Raw = {
  ended: 400,
  stage: { assessed: 400, drops: [12, 15, 6, 7, 4, 5, 1, 1] },
  reg: {
    calls: 180,
    unmeasured: 6,
    parcels: 212,
    ms: 45_368_800,
    v6: { calls: 62, parcels: 72, ms: 13_168_800 }, // 182.9초/건
    v5: { calls: 118, parcels: 140, ms: 32_200_000 }, // 230.0초/건
  },
  complaint: { assessed: 362, calls: 71, legacy: 4, types: [38, 16, 13, 21, 15, 7] },
  wait: {
    measured: 400,
    unmeasured: 0,
    invalid: 0,
    waitMs: 5 * 3_600_000, // 45.0초/통화 (업무별 합과 같음 — 겹친 구간 없음)
    callMs: 23 * 3_600_000 + 20 * 60_000,
    processes: [
      [400, 840_000], // 통화당 2.1초
      [1800, 5_400_000], // 13.5
      [200, 1_240_000], // 3.1
      [100, 520_000], // 1.3
      [50, 240_000], // 0.6
      [1900, 8_800_000], // 22.0
      [190, 960_000], // 2.4
    ],
  },
}

const EXISTING: Raw = {
  ended: 600,
  stage: { assessed: 600, drops: [4, 6, 2, 3, 2, 8, 5, 3] }, // 5.5%
  reg: {
    calls: 360,
    unmeasured: 9,
    parcels: 418,
    ms: 66_652_400,
    v6: { calls: 140, parcels: 158, ms: 22_088_400 },
    v5: { calls: 220, parcels: 260, ms: 44_564_000 },
  },
  complaint: { assessed: 552, calls: 62, legacy: 7, types: [29, 12, 9, 18, 11, 5] },
  wait: {
    measured: 600,
    unmeasured: 0,
    invalid: 0,
    waitMs: 16_560_000, // 27.6초/통화 — 업무별 합(27.7)보다 작음: 겹친 구간을 뺀 값 (명세 §5)
    callMs: 95_700_000, // 대기 17.3%
    processes: [
      [620, 960_000], // 통화당 1.6초
      [2140, 3_960_000], // 6.6
      [260, 1_200_000], // 2.0
      [180, 840_000], // 1.4
      [70, 300_000], // 0.5
      [1480, 8_376_000], // 14.0
      [418, 960_000], // 1.6
    ],
  },
}

/** 고객 구분이 null인 통화 — 전체(ALL)에만 들어감 */
const UNCLASSIFIED: Raw = {
  ended: 30,
  stage: { assessed: 26, drops: [1, 2, 0, 1, 0, 1, 0, 0] },
  reg: {
    calls: 10,
    unmeasured: 3,
    parcels: 11,
    ms: 2_486_000,
    v6: { calls: 4, parcels: 4, ms: 806_000 },
    v5: { calls: 6, parcels: 7, ms: 1_680_000 },
  },
  complaint: { assessed: 24, calls: 6, legacy: 1, types: [3, 1, 1, 1, 0, 1] },
  wait: {
    measured: 27,
    unmeasured: 2,
    invalid: 1, // 전체 탭에서 '시각 확인 필요' 안내가 보이게
    waitMs: 1_512_000,
    callMs: 6_300_000,
    processes: [
      [30, 72_000],
      [120, 384_000],
      [12, 79_200],
      [6, 31_200],
      [2, 9_600],
      [95, 446_500],
      [11, 55_000],
    ],
  },
}

/** 같은 모양의 두 값을 칸마다 더함 (전체 = 신규 + 기존 + 미분류) */
function add<T>(a: T, b: T): T {
  if (typeof a === 'number') return (a + (b as number)) as T
  if (Array.isArray(a)) return a.map((x, i) => add(x, (b as unknown[])[i])) as T
  return Object.fromEntries(
    Object.entries(a as object).map(([k, v]) => [k, add(v, (b as Record<string, unknown>)[k])]),
  ) as T
}

const RAW: Record<CustomerType, Raw> = {
  NEW,
  EXISTING,
  ALL: add(add(NEW, EXISTING), UNCLASSIFIED),
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
const pct = (n: number, of: number) => (of ? (n / of) * 100 : null) // 분모 0 = null (0과 다름)
const avg = (total: number, n: number) => (n ? total / n : null)

type Common = Pick<
  StageDropoffs,
  'customerType' | 'endedCallCount' | 'unclassifiedCustomerCallCount'
>

const build = {
  'stage-dropoffs': (c: Common, r: Raw): StageDropoffs => ({
    ...c,
    assessedCallCount: r.stage.assessed,
    unassessedCallCount: r.ended - r.stage.assessed,
    dropoffCallCount: sum(r.stage.drops),
    dropoffRatePercent: pct(sum(r.stage.drops), r.stage.assessed),
    stages: STAGES.map((stage, i) => ({
      stage,
      callCount: r.stage.drops[i],
      dropoffRatePercent: pct(r.stage.drops[i], r.stage.assessed),
    })),
  }),
  'registration-time': (c: Common, r: Raw): RegistrationTime => {
    const version = (meta: typeof V6, v: Ver): VersionTime => ({
      ...meta,
      registrationCallCount: v.calls,
      registeredParcelCount: v.parcels,
      totalCallDurationMs: v.ms,
      averageSecondsPerParcel: avg(v.ms / 1000, v.parcels),
    })
    const current = version(V6, r.reg.v6)
    const previous = version(V5, r.reg.v5)
    return {
      ...c,
      registrationCallCount: r.reg.calls,
      unmeasuredCallCount: r.reg.unmeasured,
      registeredParcelCount: r.reg.parcels,
      totalCallDurationMs: r.reg.ms,
      averageSecondsPerParcel: avg(r.reg.ms / 1000, r.reg.parcels),
      comparison: {
        current,
        previous,
        previousMinusCurrentSeconds:
          current.averageSecondsPerParcel === null || previous.averageSecondsPerParcel === null
            ? null
            : previous.averageSecondsPerParcel - current.averageSecondsPerParcel,
      },
    }
  },
  'complaint-calls': (c: Common, r: Raw): ComplaintCalls => ({
    ...c,
    assessedCallCount: r.complaint.assessed,
    unassessedCallCount: r.ended - r.complaint.assessed,
    complaintCallCount: r.complaint.calls,
    complaintRatePercent: pct(r.complaint.calls, r.complaint.assessed),
    typeTotalCount: sum(r.complaint.types),
    legacyTypeCallCount: r.complaint.legacy,
    types: TYPES.map((type, i) => ({
      type,
      callCount: r.complaint.types[i],
      sharePercent: pct(r.complaint.types[i], sum(r.complaint.types)),
    })),
  }),
  'response-wait': (c: Common, r: Raw): ResponseWait => ({
    ...c,
    measuredCallCount: r.wait.measured,
    unmeasuredCallCount: r.wait.unmeasured,
    invalidWaitCallCount: r.wait.invalid,
    totalWaitMs: r.wait.waitMs,
    totalCallDurationMs: r.wait.callMs,
    waitRatePercent: pct(r.wait.waitMs, r.wait.callMs),
    processes: PROCESSES.map((processType, i) => ({
      processType,
      measurementCount: r.wait.processes[i][0],
      totalLatencyMs: r.wait.processes[i][1],
      averageLatencyMs: avg(r.wait.processes[i][1], r.wait.processes[i][0]),
    })),
  }),
}

const meta = () => ({ requestId: crypto.randomUUID() })

export const dashboardHandlers = (Object.keys(build) as (keyof typeof build)[]).map((card) =>
  http.get(`${API_BASE_URL}/dashboard/${card}`, ({ request }) => {
    const q = new URL(request.url).searchParams
    const values = q.getAll('customerType')
    const t = values[0] ?? 'ALL' // 생략 = ALL
    if ([...q.keys()].some((k) => k !== 'customerType') || values.length > 1 || !(t in RAW))
      return HttpResponse.json(
        {
          error: { code: 'INVALID_REQUEST', message: '요청 값을 확인해 주세요.', details: [] },
          meta: meta(),
        },
        { status: 400 },
      )
    const customerType = t as CustomerType
    const r = RAW[customerType]
    const common = {
      customerType,
      endedCallCount: r.ended,
      unclassifiedCustomerCallCount: customerType === 'ALL' ? UNCLASSIFIED.ended : 0,
    }
    return HttpResponse.json(
      { data: build[card](common, r), meta: meta() },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  }),
)
