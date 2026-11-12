import { http, HttpResponse } from 'msw'
import { API_BASE_URL } from '@/shared/api/client'
import { silentWavUrl } from './calls'
import { SAMPLES } from './scenarioSamples'
import { SCRIPTS } from './scenarioScripts'

// 가짜 시험 창구 (11/12) — 07 AI 상담가의 [시나리오 시험]. 주소 · 모양은 실제 창구(ai/persona_check)와 같음: 묶음(run) 단위, 감싸지 않은 응답
//   GET /scenarios · /scenarios/{id} · /runs?tag= · /runs/{runId}/{scenario}/verdict|record, POST /runs
// 시나리오 10개는 창구의 파일을 옮긴 것 (scenarioScripts.ts)
// 시험을 시작하면 2통씩 몇 초에 하나씩 끝남 (실제는 한 통 1~5분). 결과는 정해 둔 값:
//   새 버전은 B3 · F1 실패, B1은 그 버전에서 처음 한 번 연결 실패(다시 시험하면 통과). 통화에 사용 중인 v6은 A4 · F1 실패 → A4 새로 통과 · B3 새로 실패
//   친절형은 v1만 시험해 둠 → 최신 v2를 보면 '고치기 전 글의 결과'
// 판정 · 대화는 실제 결과 세 건(scenarioSamples.ts)을 돌려 씀 — 통과는 조회, 실패는 취소(B3만 제 것) 통화가 나옴
// 실제와 다른 것: 녹음 주소를 기록에 넣어 줌(브라우저 안에서 만든 무음). 실제 창구는 …/audio를 따로 부름
const SCENARIOS = Object.values(SCRIPTS).map(({ id, name, group, core }) => ({
  id,
  name,
  group,
  core,
  available: true,
}))
const NEW_FAILS = ['B3', 'F1']
const LANES = 2 // 동시에 도는 통화 수
const STEP_MS = 3000

type Out = 'pass' | 'fail' | 'error'
interface Slot {
  out: Out
  from: number // 통화 시작 · 끝 (ms)
  to: number
}
/** 시험 묶음 한 개 — tag = '상담가 번호:버전' (화면이 붙임) */
interface Run {
  runId: string
  tag: string | null
  createdAt: number
  slots: Record<string, Slot>
}

const seed = (tag: string, at: string, fails: string[]): Run => {
  const t = Date.parse(at)
  return {
    runId: `seed-${tag.replace(':', '-')}`,
    tag,
    createdAt: t,
    slots: Object.fromEntries(
      SCENARIOS.map((s) => [
        s.id,
        { out: fails.includes(s.id) ? 'fail' : 'pass', from: t, to: t + 600_000 } satisfies Slot,
      ]),
    ),
  }
}
// 돌린 결과는 세션 저장소에 — 새로고침해도 남고, 탭을 닫으면 처음 상태로 (테스트 환경처럼 저장소가 없으면 메모리만)
const STORE = 'mock:scenarioRuns'
const load = (): Run[] | null => {
  try {
    return JSON.parse(sessionStorage.getItem(STORE) ?? 'null') as Run[] | null
  } catch {
    return null
  }
}
const store = () => {
  try {
    sessionStorage.setItem(STORE, JSON.stringify(runs))
  } catch {
    // 못 쓰면 새로고침 때 처음 상태로 돌아갈 뿐
  }
}
const runs: Run[] = load() ?? [
  seed('1:6', '2026-10-01T18:40:00+09:00', ['A4', 'F1']),
  seed('2:1', '2026-07-31T18:30:00+09:00', ['H10']),
]

const sampleOf = (scenario: string, out: Out) =>
  out === 'pass' ? SAMPLES.pass : scenario === 'B3' ? SAMPLES.stopped : SAMPLES.fail

// 창구처럼 시간대 표시 없는 그 서버(여기서는 이 브라우저)의 시각 — '2026-11-12T09:07:52.123'
const localIso = (ms: number) =>
  new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 23)

const view = (r: Run) => {
  const now = Date.now()
  const items = SCENARIOS.filter((s) => r.slots[s.id]).map((s) => {
    const slot = r.slots[s.id]
    const ended = now >= slot.to
    const done = ended && slot.out !== 'error'
    return {
      scenario: s.id,
      name: s.name,
      group: s.group,
      status: now < slot.from ? 'queued' : !ended ? 'running' : done ? 'done' : 'error',
      passed: done ? slot.out === 'pass' : null,
      summary: null,
      error: ended && !done ? 'RuntimeError: 통화가 연결되지 않음' : null,
      seconds: ended ? Math.round((slot.to - slot.from) / 1000) : null,
      liveSeconds: done ? sampleOf(s.id, slot.out).liveSeconds : null,
    }
  })
  const finished = items.filter((i) => i.status === 'done' || i.status === 'error').length
  return {
    runId: r.runId,
    createdAt: localIso(r.createdAt),
    status: finished < items.length ? 'running' : 'done',
    tag: r.tag,
    total: items.length,
    finished,
    items,
  }
}

// 창구(FastAPI)의 오류 모양
const notFound = (detail: string) => HttpResponse.json({ detail }, { status: 404 })
/** 끝난 통화 한 건 (연결 실패 · 아직 도는 것은 기록이 없음) */
const ended = (runId: unknown, scenario: unknown) => {
  const slot = runs.find((r) => r.runId === runId)?.slots[String(scenario)]
  return slot && slot.out !== 'error' && Date.now() >= slot.to
    ? sampleOf(String(scenario), slot.out)
    : null
}

const at = `${API_BASE_URL}/persona-check`
export const scenarioTestHandlers = [
  http.get(`${at}/scenarios`, () => HttpResponse.json(SCENARIOS)),
  http.get(`${at}/scenarios/:id`, ({ params }) => {
    const s = (SCRIPTS as Record<string, (typeof SCRIPTS)['A1']>)[String(params.id)]
    return s ? HttpResponse.json({ ...s, available: true }) : notFound('없는 시나리오')
  }),
  http.get(`${at}/runs`, ({ request }) => {
    const tag = new URL(request.url).searchParams.get('tag')
    return HttpResponse.json(
      runs
        .filter((r) => tag === null || r.tag === tag)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(view),
    )
  }),
  http.post(`${at}/runs`, async ({ request }) => {
    const body = (await request.json()) as { scenarios?: string[]; tag?: string }
    const ids = body.scenarios ?? SCENARIOS.map((s) => s.id)
    const tag = body.tag ?? null
    const now = Date.now()
    const lanes = Array.from({ length: LANES }, () => now)
    const slots: Run['slots'] = {}
    for (const id of ids) {
      const i = lanes.indexOf(Math.min(...lanes))
      const first = !runs.some((r) => r.tag === tag && r.slots[id])
      const out: Out = id === 'B1' && first ? 'error' : NEW_FAILS.includes(id) ? 'fail' : 'pass'
      slots[id] = { out, from: lanes[i], to: (lanes[i] += STEP_MS) }
    }
    const runId = `mock-${now}`
    runs.push({ runId, tag, createdAt: now, slots })
    store()
    return HttpResponse.json({ runId }, { status: 202 })
  }),
  http.get(`${at}/runs/:runId/:scenario/verdict`, ({ params }) => {
    const s = ended(params.runId, params.scenario)
    if (!s) return notFound('없는 결과')
    // at(실패가 난 통화 안 시각)은 창구가 아직 안 주는 값 — 화면이 쓸 모양을 보이려고 취소 실패 예의 한 줄에만 넣음
    // (84.5초 = AI가 "취소 처리는 완료되지 않았습니다"라고 한 말)
    const checks = s.verdict.checks.map((c) =>
      s === SAMPLES.fail && c.status === 'fail' ? { ...c, at: 84.5 } : c,
    )
    return HttpResponse.json({ ...s.verdict, checks })
  }),
  http.get(`${at}/runs/:runId/:scenario/record`, ({ params }) => {
    const s = ended(params.runId, params.scenario)
    if (!s) return notFound('없는 결과')
    const last = s.lines[s.lines.length - 1][0] as number
    return HttpResponse.json({
      customer: { lines: s.lines },
      liveSeconds: s.liveSeconds,
      audioUrl: silentWavUrl(Math.ceil(last) + 10), // 가짜엔 녹음이 없어 그 길이의 무음
    })
  }),
]
