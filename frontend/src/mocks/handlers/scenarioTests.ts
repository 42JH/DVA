import { http, HttpResponse } from 'msw'
import { API_BASE_URL } from '@/shared/api/client'
import { silentWavUrl } from './calls'
import { SAMPLES } from './scenarioSamples'
import { SCRIPTS } from './scenarioScripts'

// 가짜 시나리오 시험 (11/12) — 07 AI 상담가의 [시나리오 시험]. 백엔드 API가 없어 주소 · 모양은 임시 (features/persona/api/scenarioTestApi.ts)
// 시나리오 10개는 시험 도구의 파일을 옮긴 것 (scenarioScripts.ts)
// 시험을 시작하면 2통씩 몇 초에 하나씩 끝남 (실제는 한 통 1~5분). 결과는 정해 둔 값:
//   새 버전은 B3 · F1 실패, B1은 처음 한 번 연결 실패(다시 시험하면 통과). 통화에 사용 중인 v6은 A4 · F1 실패 → A4 새로 통과 · B3 새로 실패
//   친절형은 v1만 시험해 둠 → 최신 v2를 보면 '고치기 전 글의 결과'
// 판정 · 대화는 실제 결과 세 건(scenarioSamples.ts)을 돌려 씀 — 통과는 조회, 실패는 취소(B3만 제 것) 통화가 나옴
const SCENARIOS = Object.values(SCRIPTS).map(({ id, name, group, core }) => ({
  id,
  name,
  group,
  core,
}))
const NEW_FAILS = ['B3', 'F1']
const LANES = 2 // 동시에 도는 통화 수
const STEP_MS = 3000

type Out = 'pass' | 'fail' | 'error'
interface Slot {
  runId: string
  out: Out
  from: number // 통화 시작 · 끝 (ms)
  to: number
}
interface Entry {
  personaSeq: number
  version: number
  startedAt: number
  slots: Map<string, Slot>
}

const seed = (personaSeq: number, version: number, at: string, fails: string[]): Entry => {
  const t = Date.parse(at)
  return {
    personaSeq,
    version,
    startedAt: t,
    slots: new Map(
      SCENARIOS.map((s) => [
        s.id,
        {
          runId: `seed-${personaSeq}-${version}`,
          out: fails.includes(s.id) ? 'fail' : 'pass',
          from: t,
          to: t + 600_000,
        },
      ]),
    ),
  }
}
// 돌린 결과는 세션 저장소에 — 새로고침해도 남고, 탭을 닫으면 처음 상태로 (테스트 환경처럼 저장소가 없으면 메모리만)
const STORE = 'mock:scenarioTests'
const load = (): Entry[] | null => {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORE) ?? 'null') as
      (Omit<Entry, 'slots'> & { slots: [string, Slot][] })[] | null
    return saved && saved.map((e) => ({ ...e, slots: new Map(e.slots) }))
  } catch {
    return null
  }
}
const store = () => {
  try {
    sessionStorage.setItem(
      STORE,
      JSON.stringify(entries.map((e) => ({ ...e, slots: [...e.slots] }))),
    )
  } catch {
    // 못 쓰면 새로고침 때 처음 상태로 돌아갈 뿐
  }
}
const entries: Entry[] = load() ?? [
  seed(1, 6, '2026-10-01T18:40:00+09:00', ['A4', 'F1']),
  seed(2, 1, '2026-07-31T18:30:00+09:00', ['H10']),
]

const sampleOf = (scenario: string, out: Out) =>
  out === 'pass' ? SAMPLES.pass : scenario === 'B3' ? SAMPLES.stopped : SAMPLES.fail

const view = (e: Entry) => {
  const now = Date.now()
  const slots = [...e.slots.values()]
  const end = Math.max(...slots.map((s) => s.to))
  return {
    personaSeq: e.personaSeq,
    version: e.version,
    status: now < end ? 'running' : 'done',
    startedAt: new Date(e.startedAt).toISOString(),
    finishedAt: now < end ? null : new Date(end).toISOString(),
    items: SCENARIOS.flatMap((s) => {
      const slot = e.slots.get(s.id)
      if (!slot) return []
      const ended = now >= slot.to
      const done = ended && slot.out !== 'error'
      return [
        {
          scenario: s.id,
          runId: slot.runId,
          status: now < slot.from ? 'queued' : !ended ? 'running' : done ? 'done' : 'error',
          passed: done ? slot.out === 'pass' : null,
          error: ended && !done ? '통화가 연결되지 않았습니다' : null,
          liveSeconds: done ? sampleOf(s.id, slot.out).liveSeconds : null,
        },
      ]
    }),
  }
}

const notFound = () =>
  HttpResponse.json(
    { error: { code: 'NOT_FOUND', message: '시험 결과가 없습니다.', details: [] } },
    { status: 404 },
  )
/** 끝난 통화 한 건 (연결 실패 · 아직 도는 것은 기록이 없음) */
const ended = (runId: unknown, scenario: unknown) => {
  for (const e of entries) {
    const slot = e.slots.get(String(scenario))
    if (slot && slot.runId === runId && slot.out !== 'error' && Date.now() >= slot.to)
      return sampleOf(String(scenario), slot.out)
  }
  return null
}

export const scenarioTestHandlers = [
  http.get(`${API_BASE_URL}/persona-check/scenarios`, () => HttpResponse.json({ data: SCENARIOS })),
  http.get(`${API_BASE_URL}/persona-check/scenarios/:id`, ({ params }) => {
    const s = (SCRIPTS as Record<string, (typeof SCRIPTS)['A1']>)[String(params.id)]
    return s ? HttpResponse.json({ data: s }) : notFound()
  }),
  http.get(`${API_BASE_URL}/persona-check/tests`, () =>
    HttpResponse.json({ data: entries.map(view) }),
  ),
  http.post(`${API_BASE_URL}/persona-check/tests`, async ({ request }) => {
    const body = (await request.json()) as {
      personaSeq: number
      version: number
      core?: boolean
      scenarios?: string[]
    }
    const ids = body.scenarios ?? SCENARIOS.filter((s) => !body.core || s.core).map((s) => s.id)
    let e = entries.find((x) => x.personaSeq === body.personaSeq && x.version === body.version)
    if (!e) entries.push((e = { ...body, startedAt: 0, slots: new Map() }))
    const now = Date.now()
    e.startedAt = now
    const runId = `mock-${now}`
    const lanes = Array.from({ length: LANES }, () => now)
    for (const id of ids) {
      const i = lanes.indexOf(Math.min(...lanes))
      const first = !e.slots.has(id)
      const out: Out = id === 'B1' && first ? 'error' : NEW_FAILS.includes(id) ? 'fail' : 'pass'
      e.slots.set(id, { runId, out, from: lanes[i], to: (lanes[i] += STEP_MS) })
    }
    store()
    return HttpResponse.json({ data: { runId } }, { status: 202 })
  }),
  http.get(`${API_BASE_URL}/persona-check/runs/:runId/:scenario/verdict`, ({ params }) => {
    const s = ended(params.runId, params.scenario)
    if (!s) return notFound()
    // at(실패가 난 통화 안 시각)은 도구가 아직 안 주는 값 — 화면이 쓸 모양을 보이려고 취소 실패 예의 한 줄에만 넣음
    // (84.5초 = AI가 "취소 처리는 완료되지 않았습니다"라고 한 말)
    const checks = s.verdict.checks.map((c) =>
      s === SAMPLES.fail && c.status === 'fail' ? { ...c, at: 84.5 } : c,
    )
    return HttpResponse.json({ data: { ...s.verdict, checks } })
  }),
  http.get(`${API_BASE_URL}/persona-check/runs/:runId/:scenario/record`, ({ params }) => {
    const s = ended(params.runId, params.scenario)
    if (!s) return notFound()
    const last = s.lines[s.lines.length - 1][0] as number
    return HttpResponse.json({
      data: {
        customer: { lines: s.lines },
        liveSeconds: s.liveSeconds,
        audioUrl: silentWavUrl(Math.ceil(last) + 10), // 가짜엔 녹음이 없어 그 길이의 무음
      },
    })
  }),
]
