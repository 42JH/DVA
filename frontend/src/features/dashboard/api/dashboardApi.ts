// 02 대시보드 'AI 상담 성능' Model — 'AI 상담 성능 대시보드 프론트 연동 명세'(BE feature/ai-dashboard · migration 050) 그대로. React를 모르는 데이터 층
//   카드 하나 = GET 하나: /dashboard/stage-dropoffs · registration-time · complaint-calls · response-wait
//   쿼리는 customerType(ALL · NEW · EXISTING) 하나뿐 — 날짜 · 쪽 필터 없음(보관 중인 종료 통화 전체). 응답은 단건 { data, meta }
//   null = 미측정 · 계산 불가(분모 0) → 화면에 '—' (0과 다름). 비율은 이미 0~100이고 반올림 안 됨 → 표시 자릿수만 화면에서
// 개발 중엔 MSW 가짜(mocks/handlers/dashboard.ts)가 같은 모양으로 응답
import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import { api, type ApiItem } from '@/shared/api/client'

export type CustomerType = 'ALL' | 'NEW' | 'EXISTING'
export type Stage =
  | 'SENDER_INFO'
  | 'RECIPIENT_INFO'
  | 'ITEM_INFO'
  | 'CONFIRMATION'
  | 'PAYMENT_GUIDANCE'
  | 'FAQ_ANSWER'
  | 'ORDER_LOOKUP'
  | 'ORDER_CANCEL'
export type ComplaintType =
  | 'INFORMATION_RECOGNITION_ERROR'
  | 'INTENT_RECOGNITION_ERROR'
  | 'UNSUPPORTED_ANSWER'
  | 'SLOW_RESPONSE'
  | 'INTERRUPTION'
  | 'DISSATISFACTION_EXPRESSION'
export type ProcessType =
  | 'CUSTOMER_LOOKUP'
  | 'INFORMATION_INPUT'
  | 'FAQ_LOOKUP'
  | 'ORDER_LOOKUP'
  | 'ORDER_CANCEL'
  | 'ADDRESS_LOOKUP'
  | 'ORDER_SAVE'

/** 네 응답 공통 */
interface Common {
  customerType: CustomerType
  endedCallCount: number // 보관 중인 종료 통화 (삭제 · 5년 만료 제외)
  unclassifiedCustomerCallCount: number // 그중 고객 구분이 null — ALL에서만 0보다 큼
}

/** §2 단계별 고객 이탈 — 비율 분모 = 판정 완료(AI가 이탈 단계 또는 NONE을 보낸) 통화. stages는 늘 8개 이 순서, callCount 합 = dropoffCallCount */
export interface StageDropoffs extends Common {
  assessedCallCount: number
  unassessedCallCount: number
  dropoffCallCount: number
  dropoffRatePercent: number | null
  stages: { stage: Stage; callCount: number; dropoffRatePercent: number | null }[]
}

/** §3 비교 막대 하나 = 정확한 설정 버전 (그 고객 탭의 접수 표본이 없으면 건수 0 · 평균 null) */
export interface VersionTime {
  aiPersonaVersionSeq: number
  aiPersonaSeq: number
  name: string
  version: number
  registrationCallCount: number
  registeredParcelCount: number
  totalCallDurationMs: number
  averageSecondsPerParcel: number | null
}

/** §3 접수 소요시간 — 접수가 있는 통화의 전체 통화시간 ÷ 배송 상세 건수 (FAQ · 조회 시간도 포함)
 *  comparison = 현재 ACTIVE 버전 vs 그 직전에 ACTIVE였던 버전 (BE가 고름. 없으면 null) */
export interface RegistrationTime extends Common {
  registrationCallCount: number
  unmeasuredCallCount: number // 접수 건수 미수신 통화 (확인된 0건은 아님)
  registeredParcelCount: number
  totalCallDurationMs: number
  averageSecondsPerParcel: number | null
  comparison: {
    current: VersionTime | null
    previous: VersionTime | null
    previousMinusCurrentSeconds: number | null // 양수면 현재 버전이 그만큼 빠름
  }
}

/** §4 고객 불편 표현 — 상단 = 불편 통화 비율(과거 유형 포함), 도넛 = 여섯 유형 통화 수 합(typeTotalCount) 안의 구성비. types는 늘 6개 이 순서 */
export interface ComplaintCalls extends Common {
  assessedCallCount: number
  unassessedCallCount: number
  complaintCallCount: number
  complaintRatePercent: number | null
  typeTotalCount: number
  legacyTypeCallCount: number // 여섯 유형 밖 과거 유형이 있는 통화 — 도넛에 안 더함
  types: { type: ComplaintType; callCount: number; sharePercent: number | null }[]
}

/** §5 응답 대기 — 상단 = 통화시간 중 대기 비율(겹친 구간 뺌). processes는 늘 7개 이 순서. ended = measured + unmeasured + invalid */
export interface ResponseWait extends Common {
  measuredCallCount: number
  unmeasuredCallCount: number
  invalidWaitCallCount: number // 대기가 통화시간보다 커진 통화 — 이 카드 집계에서 전부 빠짐
  totalWaitMs: number
  totalCallDurationMs: number
  waitRatePercent: number | null
  processes: {
    processType: ProcessType
    measurementCount: number
    totalLatencyMs: number
    averageLatencyMs: number | null
  }[]
}

export interface Cards {
  'stage-dropoffs': StageDropoffs
  'registration-time': RegistrationTime
  'complaint-calls': ComplaintCalls
  'response-wait': ResponseWait
}

export const dashboardQueries = {
  /** 탭을 빨리 바꿔도 탭마다 다른 쿼리 키라 이전 탭 응답이 지금 화면을 덮지 않음 (안 보게 된 요청은 signal로 취소) */
  card: <K extends keyof Cards>(card: K, customerType: CustomerType) =>
    queryOptions({
      queryKey: ['dashboard', card, customerType],
      queryFn: async ({ signal }) =>
        (
          await api.get<ApiItem<Cards[K]>>(`/dashboard/${card}`, {
            query: { customerType },
            signal,
          })
        ).data,
      placeholderData: keepPreviousData, // 탭을 바꾸는 동안 이전 탭 카드가 흐리게 남음 (깜빡임 없게)
    }),
}
