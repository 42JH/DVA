// 시험 창구의 묶음(run) → 화면의 버전별 결과 (순수 함수, scenarioTestMap.test.ts)
// 창구는 묶음 단위로만 알고 '어느 버전의 시험인지'는 화면이 시작할 때 붙인 tag로 남김 → 화면이 tag별로 모아 시나리오마다 최신 결과를 고름

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
  startedAt: string // 가장 최근 묶음을 시작한 때
  finishedAt: string | null // 창구가 끝난 때를 주지 않아 지금은 늘 null
  items: TestItem[]
}

/** 창구의 묶음 (GET /runs 한 항목 = GET /runs/{runId}) — 쓰는 칸만 */
export interface RunDto {
  runId: string
  createdAt: string // '2026-11-12T09:07:52.123' (창구 서버의 시각)
  status: 'running' | 'done' | 'interrupted' // interrupted = 돌던 중에 창구가 꺼짐
  tag?: string | null
  items: Omit<TestItem, 'runId'>[]
}

/** 시험을 시작할 때 붙이는 표시 — '상담가 번호:버전' */
export const tagOf = (personaSeq: number, version: number) => `${personaSeq}:${version}`
const TAG = /^(\d+):(\d+)$/

/** 묶음 목록 → 버전별 결과. 표시가 없거나 모양이 다른 묶음(창구를 직접 불러 돌린 것)은 뺌
 *  시나리오마다 가장 최근 묶음의 결과. 돌다가 꺼진 묶음의 못 끝낸 항목은 그 전 결과를 가리지 않음 */
export function runsToTests(runs: RunDto[]): VersionTest[] {
  const newest = [...runs].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || b.runId.localeCompare(a.runId),
  )
  const byTag = new Map<string, RunDto[]>()
  for (const run of newest) {
    if (!run.tag || !TAG.test(run.tag)) continue
    byTag.set(run.tag, [...(byTag.get(run.tag) ?? []), run])
  }
  return [...byTag].map(([tag, list]) => {
    const [, personaSeq, version] = TAG.exec(tag)!
    const items = new Map<string, TestItem>()
    for (const run of list)
      for (const i of run.items) {
        const ended = i.status === 'done' || i.status === 'error'
        if (items.has(i.scenario) || (!ended && run.status !== 'running')) continue
        items.set(i.scenario, {
          scenario: i.scenario,
          runId: run.runId,
          status: i.status,
          passed: i.passed,
          error: i.error,
          liveSeconds: i.liveSeconds,
        })
      }
    return {
      personaSeq: Number(personaSeq),
      version: Number(version),
      status: list.some((r) => r.status === 'running') ? 'running' : 'done',
      startedAt: list[0].createdAt,
      finishedAt: null,
      items: [...items.values()],
    }
  })
}
