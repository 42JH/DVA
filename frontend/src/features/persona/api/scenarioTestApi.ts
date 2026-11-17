// 시나리오 시험 (11/12) — 페르소나 글을 통화에 쓰기 전에, 정해진 고객 대본으로 AI에게 전화를 걸어 보는 시험
// 주소와 모양은 시험 창구(ai/persona_check)의 것 그대로. 백엔드는 관리자 확인 뒤 /api/persona-check/* 를 창구로 넘기기만 함(저장 · 가공 없음)
// JSON 응답은 백엔드의 기본 모양 { data, meta }로 감싸져 옴(녹음만 파일 그대로) → unwrap으로 알맹이를 꺼냄
// 창구는 결과를 자기 쪽 폴더에 보관. '어느 버전의 시험인지'는 화면이 시작할 때 붙인 tag로 남고, 버전별로 모으는 일은 화면이 함 (scenarioTestMap.ts)
// 시험 통화는 창구 안의 가짜 백엔드를 써서 통화 내역 · 주문 · 고객 · 통계에 남지 않음
import { queryOptions } from '@tanstack/react-query'
import { api, API_BASE_URL } from '@/shared/api/client'
import {
  runsToTests,
  runBody,
  tagOf,
  unwrap,
  type RunDto,
  type TestItem,
  type VersionTest,
} from './scenarioTestMap'

export type { TestItem, VersionTest }

/** 화면을 켜는 스위치 — 늘 켜짐(가짜 모드 · 실제 백엔드 · 배포 모두. 백엔드 중계가 모든 서버에 있음, 11/12)
 *  끄려면 VITE_SCENARIO_TEST=false → 화면과 [통화에 사용하기] 관문이 함께 사라짐 */
export const SCENARIO_TEST = import.meta.env.VITE_SCENARIO_TEST !== 'false'
/** 반영 전 시험 — 꺼 두면 [통화에 반영] · [통화에 사용하기]가 시험 없이 바로 확인 창 (시나리오 시험 화면은 그대로)
 *  11/15 사용자: 지금은 임시로 시험 없이 반영. ponytail: 임시 스위치 — 다시 켜려면 VITE_TEST_BEFORE_APPLY=true (또는 기본값을 true로) */
export const TEST_BEFORE_APPLY = SCENARIO_TEST && import.meta.env.VITE_TEST_BEFORE_APPLY === 'true'

export interface Scenario {
  id: string // 'A1' — AI 파트 문서의 번호
  name: string
  group: string // 업무 (접수 · 조회 · 취소 …)
  available?: boolean // false = 이 환경에서 돌릴 수 없음(FAQ 검색 서버 미연결). 목록에서 뺌
}

/** 시나리오 내용 (보기 전용 — 시나리오는 AI 파트가 시험 창구의 파일로 관리, 화면에서 고치지 않음) */
export interface ScenarioScript extends Scenario {
  caller: string // 전화한 사람 ('등록 고객 김민수' · '신규 고객')
  lines: { text: string; optional: boolean }[] // 고객 대본. optional = 상황에 따라 안 할 수 있는 말
  expected: { name: string; value: unknown }[] // 정답 — 판정 결과표의 코드 검사와 같은 이름 · 값(숫자 · 묶음일 수 있음)
  checks: string[] // 행동 확인 문장
}

/** 판정 한 줄 — 코드 검사(정답 값 / 실제 값)와 행동 확인(문장 · '지킴' / '어김: …')이 같은 모양으로 섞여 옴 */
export interface Check {
  name: string
  status: 'pass' | 'fail' | 'skip' | 'warn' // skip = 채점 안 함, warn = 확인 필요(덧붙인 말 · 받아쓰기 오류, 실패로 세지 않음). 사유는 note
  expected: unknown
  actual: unknown
  note?: string
}
export interface Verdict {
  passed: boolean
  checks: Check[]
}

/** 통화 기록 — [통화 안 초, 말한 쪽, 말] */
export interface TestRecord {
  customer: { lines: [number, 'AI' | '고객', string][] }
  liveSeconds: number
  audioUrl: string | null // 녹음 주소 — 창구의 …/audio (쿠키로 인증되는 같은 주소라 재생기에 바로 넣음)
}

const get = async <T>(path: string, signal?: AbortSignal) =>
  unwrap<T>(await api.get<unknown>(`/persona-check${path}`, { signal }))

export const scenarioTestQueries = {
  all: () => ['personaTests'] as const,
  scenarios: () =>
    queryOptions({
      queryKey: [...scenarioTestQueries.all(), 'scenarios'],
      // 돌릴 수 없는 시나리오는 뺌 — 남겨 두면 '전체 시험'이 영영 끝나지 않은 것으로 보임
      queryFn: async ({ signal }) =>
        (await get<Scenario[]>('/scenarios', signal)).filter((s) => s.available !== false),
      staleTime: Infinity,
    }),
  script: (id: string) =>
    queryOptions({
      queryKey: [...scenarioTestQueries.all(), 'scenarios', id],
      queryFn: ({ signal }) => get<ScenarioScript>(`/scenarios/${id}`, signal),
      staleTime: Infinity,
    }),
  tests: () =>
    queryOptions({
      queryKey: [...scenarioTestQueries.all(), 'tests'],
      queryFn: async ({ signal }) => runsToTests(await get<RunDto[]>('/runs', signal)),
      // 시험이 도는 동안만 2초마다 다시 받음 — 표 · 카드 · 상세가 같은 규칙
      refetchInterval: (q) => (q.state.data?.some((t) => t.status === 'running') ? 2000 : false),
      staleTime: 5_000, // 늦게 붙는 부품이 방금 받은 것을 또 부르지 않게 (personaQueries와 같은 이유). 시작 · 중단 뒤에는 invalidate
    }),
  verdict: (runId: string, scenario: string) =>
    queryOptions({
      queryKey: [...scenarioTestQueries.all(), runId, scenario, 'verdict'],
      queryFn: ({ signal }) => get<Verdict>(`/runs/${runId}/${scenario}/verdict`, signal),
      staleTime: Infinity, // 끝난 통화의 판정은 안 바뀜
    }),
  record: (runId: string, scenario: string) =>
    queryOptions({
      queryKey: [...scenarioTestQueries.all(), runId, scenario, 'record'],
      queryFn: async ({ signal }): Promise<TestRecord> => {
        const rec = await get<Omit<TestRecord, 'audioUrl'> & { audioUrl?: string | null }>(
          `/runs/${runId}/${scenario}/record`,
          signal,
        )
        // 가짜 서버는 녹음 주소를 기록에 넣어 줌(브라우저 안에서 만든 무음). 실제 창구는 따로 요청하는 주소
        return {
          ...rec,
          audioUrl: rec.audioUrl ?? `${API_BASE_URL}/persona-check/runs/${runId}/${scenario}/audio`,
        }
      },
      staleTime: Infinity,
    }),
}

const CONCURRENCY = 2 // 동시에 거는 통화 수 — 창구가 자기 상한(PERSONA_CHECK_MAX_CONCURRENCY)까지로 줄임

/** 시험 시작 — 그 버전의 페르소나 글로 통화를 걺. scenarios를 주면 그것만(남은 것 시험), 없으면 전체
 *  voiceId null = AI 기본 음성. 묶음에 '상담가 번호:버전' 표시를 붙여 나중에 버전별로 모음
 *  요금이 드는 요청: 글이 비었거나 scenarios가 빈 배열이면 보내지 않고 실패(runBody). 실패해도 자동으로 다시 보내지 않음 */
export const startTest = async (input: {
  personaSeq: number
  version: number
  promptText: string
  voiceId: string | null
  scenarios?: string[]
}): Promise<void> => {
  await api.post('/persona-check/runs', { body: runBody({ ...input, concurrency: CONCURRENCY }) })
}

/** 시험 멈춤 — 그 버전에서 돌고 있는 묶음을 모두 멈춤(남은 것 시험을 하면 묶음이 여럿)
 *  창구 POST /runs/{runId}/stop: 돌던 통화는 끊고, 아직 안 건 시나리오는 걸지 않음 → 시험 안 함으로 남아 [남은 N개 시험]으로 이어 돌림
 *  이미 끝난 묶음에 보내도 202(두 번 눌러도 같음). 백엔드가 같은 주소로 중계 (11/14, 끝난 묶음 202 · 없는 묶음 404) */
export const stopTest = async (input: { personaSeq: number; version: number }): Promise<void> => {
  const tag = encodeURIComponent(tagOf(input.personaSeq, input.version))
  const runs = await get<RunDto[]>(`/runs?tag=${tag}`)
  await Promise.all(
    runs
      .filter((r) => r.status === 'running')
      .map((r) => api.post(`/persona-check/runs/${r.runId}/stop`)),
  )
}
