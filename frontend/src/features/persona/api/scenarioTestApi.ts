// 시나리오 시험 (11/12) — 페르소나 글을 통화에 쓰기 전에, 정해진 고객 대본으로 AI에게 전화를 걸어 보는 시험
// 데이터 모양은 시험 도구(ai/persona_check)의 창구를 따름 (FE_HANDOFF 6장). 백엔드 API가 아직 없어 주소는 임시이고
// 가짜 서버(mocks/handlers/scenarioTests.ts)만 답함 → 화면은 가짜 모드에서만 보임 (SCENARIO_TEST)
// 도구에 없는 것(백엔드가 맡을 것): 어느 버전의 결과인지, 버전마다 시나리오별 최신 결과를 합쳐 주기, 녹음 주소(audioUrl)
// 도구에 없는 것(도구가 더 줘야 할 것): 시나리오 한 개의 내용 — GET /scenarios/{id} (대본 · 정답 · 행동 확인)
import { queryOptions } from '@tanstack/react-query'
import { api, type ApiItem } from '@/shared/api/client'

/** 가짜 모드(개발 서버 + VITE_USE_MOCK)에서만 켜짐 — 배포 화면은 그대로 */
export const SCENARIO_TEST = import.meta.env.DEV && import.meta.env.VITE_USE_MOCK === 'true'

export interface Scenario {
  id: string // 'A1' — AI 파트 문서의 번호
  name: string
  group: string // 업무 (접수 · 조회 · 취소 …)
  core: boolean // 핵심 묶음 — 빨리 돌려 보는 몇 개
}

/** 시나리오 내용 (보기 전용 — 시나리오는 AI 파트가 시험 도구의 파일로 관리, 화면에서 고치지 않음) */
export interface ScenarioScript extends Scenario {
  caller: string // 전화한 사람 ('등록 고객 김민수' · '신규 고객')
  lines: { text: string; optional: boolean }[] // 고객 대본. optional = 상황에 따라 안 할 수 있는 말
  expected: { name: string; value: string }[] // 정답 (판정의 코드 검사와 같은 이름)
  checks: string[] // 행동 확인 문장
}

/** 시나리오 한 개의 결과. error = 통화가 연결되지 않음(시나리오 실패가 아님, passed null) */
export interface TestItem {
  scenario: string
  runId: string // 이 결과가 나온 묶음 — 판정 · 대화 기록을 받을 때
  status: 'queued' | 'running' | 'done' | 'error'
  passed: boolean | null
  error: string | null
  liveSeconds: number | null
}

/** 한 버전의 시험 결과 — 시나리오마다 가장 최근 것 */
export interface VersionTest {
  personaSeq: number
  version: number
  status: 'running' | 'done' | 'interrupted'
  startedAt: string
  finishedAt: string | null
  items: TestItem[]
}

/** 판정 한 줄 — 코드 검사(정답 값 / 실제 값)와 행동 확인(문장 · '지킴' / '어김: …')이 같은 모양으로 섞여 옴 */
export interface Check {
  name: string
  status: 'pass' | 'fail' | 'skip' // skip = 채점 안 함 (사유는 note)
  expected: unknown
  actual: unknown
  note?: string
  at?: number // 실패가 난 통화 안 시각(초) — 도구가 아직 안 줌. 주면 대화의 그 말로 바로 감
}
export interface Verdict {
  passed: boolean
  checks: Check[]
}

/** 통화 기록 — [통화 안 초, 말한 쪽, 말] */
export interface TestRecord {
  customer: { lines: [number, 'AI' | '고객', string][] }
  liveSeconds: number
  audioUrl: string | null
}

const get =
  <T>(path: string) =>
  async ({ signal }: { signal?: AbortSignal }) =>
    (await api.get<ApiItem<T>>(path, { signal })).data

export const scenarioTestQueries = {
  all: () => ['personaTests'] as const,
  scenarios: () =>
    queryOptions({
      queryKey: [...scenarioTestQueries.all(), 'scenarios'],
      queryFn: get<Scenario[]>('/persona-check/scenarios'),
      staleTime: Infinity,
    }),
  script: (id: string) =>
    queryOptions({
      queryKey: [...scenarioTestQueries.all(), 'scenarios', id],
      queryFn: get<ScenarioScript>(`/persona-check/scenarios/${id}`),
      staleTime: Infinity,
    }),
  tests: () =>
    queryOptions({
      queryKey: [...scenarioTestQueries.all(), 'tests'],
      queryFn: get<VersionTest[]>('/persona-check/tests'),
      // 시험이 도는 동안만 2초마다 다시 받음 — 표 · 카드 · 상세가 같은 규칙
      refetchInterval: (q) => (q.state.data?.some((t) => t.status === 'running') ? 2000 : false),
    }),
  verdict: (runId: string, scenario: string) =>
    queryOptions({
      queryKey: [...scenarioTestQueries.all(), runId, scenario, 'verdict'],
      queryFn: get<Verdict>(`/persona-check/runs/${runId}/${scenario}/verdict`),
      staleTime: Infinity, // 끝난 통화의 판정은 안 바뀜
    }),
  record: (runId: string, scenario: string) =>
    queryOptions({
      queryKey: [...scenarioTestQueries.all(), runId, scenario, 'record'],
      queryFn: get<TestRecord>(`/persona-check/runs/${runId}/${scenario}/record`),
      staleTime: Infinity,
    }),
}

/** 시험 시작 — scenarios를 주면 그것만(연결 실패 다시 시험), 없으면 전체. 도구의 핵심 묶음(core)은 화면에서 안 씀 */
export const startTest = (body: {
  personaSeq: number
  version: number
  scenarios?: string[]
}): Promise<void> => api.post('/persona-check/tests', { body })
