// 시나리오 시험 결과 읽기 (순수 함수, scenarioTest.test.ts) — 표의 칸 · 변화 · [통화에 사용하기] 관문
import type { Check, Scenario, TestItem, VersionTest } from '@/features/persona/api/scenarioTestApi'

/** 표의 한 칸: 통과 · 실패 · 연결 실패 · 시험 중 · 대기 · 결과 없음 */
export type Cell = 'pass' | 'fail' | 'error' | 'running' | 'queued' | 'none'
export type Change = '새로 실패' | '새로 통과' | '같음' | ''
/** 한 버전의 시험 상태 — none 시험 전 · running 시험 중 · partial 일부만 시험 · done 전체 시험 끝남 · stale 고치기 전 글의 결과만 있음 */
export type TestState = 'none' | 'running' | 'partial' | 'done' | 'stale'

type Key = { personaSeq: number; version: number }
const same = (a: Key, b: Key | null) =>
  !!b && a.personaSeq === b.personaSeq && a.version === b.version

/** 묶음이 돌다가 꺼졌으면(interrupted) 못 끝낸 것은 결과 없음 */
export function cellOf(item: TestItem | undefined, running: boolean): Cell {
  if (!item) return 'none'
  if (item.status === 'error') return 'error'
  if (item.status === 'done') return item.passed ? 'pass' : 'fail'
  return running ? item.status : 'none'
}

/** 통화에 사용 중인 버전과 이 버전을 비교 — 둘 다 통과 · 실패로 끝났을 때만 */
export function changeOf(base: Cell, now: Cell): Change {
  const done = (c: Cell) => c === 'pass' || c === 'fail'
  if (!done(base) || !done(now)) return ''
  return base === now ? '같음' : now === 'fail' ? '새로 실패' : '새로 통과'
}

/** 이 버전의 결과와 상태. 이 버전을 시험한 적이 없고 최신 버전(head)이면, 고치기 전(더 낮은 번호, 통화에 사용 중인 버전 제외) 결과를 대신 보여 줌 = stale */
export function testOf(
  tests: VersionTest[],
  scenarios: Scenario[],
  me: Key & { isHead: boolean },
  active: Key | null,
): { state: TestState; shown: VersionTest | null } {
  const mine = tests.find((t) => same(t, me))
  if (mine) {
    if (mine.status === 'running') return { state: 'running', shown: mine }
    const ended = (id: string) => {
      const c = cellOf(
        mine.items.find((i) => i.scenario === id),
        false,
      )
      return c !== 'none'
    }
    return { state: scenarios.every((s) => ended(s.id)) ? 'done' : 'partial', shown: mine }
  }
  const before = me.isHead
    ? tests
        .filter((t) => t.personaSeq === me.personaSeq && t.version < me.version && !same(t, active))
        .sort((a, b) => b.version - a.version)[0]
    : undefined
  return before ? { state: 'stale', shown: before } : { state: 'none', shown: null }
}

/** 표 줄 — 시나리오 순서 그대로. 통화에 사용 중(base) · 이 버전(now) · 변화 */
export function rowsOf(scenarios: Scenario[], base: VersionTest | null, now: VersionTest | null) {
  const cell = (t: VersionTest | null, id: string) =>
    cellOf(
      t?.items.find((i) => i.scenario === id),
      t?.status === 'running',
    )
  return scenarios.map((s) => {
    const b = cell(base, s.id)
    const n = cell(now, s.id)
    return { ...s, base: b, now: n, change: changeOf(b, n) }
  })
}

type Line = [number, 'AI' | '고객', string]

/** 실패한 판정이 통화의 어느 말에서 났는지 — 대화 줄 번호, 알 수 없으면 null (값만 틀린 코드 검사는 위치가 없음)
 *  1) 판정이 시각(at)을 주면 그때 하던 말  2) 행동 확인 '어김: <AI가 한 말>' → 그 말
 *  3) 대본 진행 '말하지 못한 발화: [4, 5]' → 고객이 마지막으로 한 대본 문장(3번) = 통화가 더 나아가지 못한 곳
 *  ponytail: 2 · 3은 판정기의 문구를 읽는 것이라 문구가 바뀌면 못 찾음(null). 판정기가 at을 주면 1만 남기면 됨 */
export function failLine(c: Check, lines: Line[], script: string[]): number | null {
  // 대화 기록이 아직 안 왔으면(판정이 먼저 도착) 찾을 줄이 없음 — 없는 줄 번호를 돌려주면 화면이 깨짐
  if (c.status !== 'fail' || lines.length === 0) return null
  if (typeof c.at === 'number') {
    const at = c.at
    return Math.max(
      lines.findLastIndex(([sec]) => sec <= at),
      0,
    )
  }
  const actual = typeof c.actual === 'string' ? c.actual : ''
  if (actual.startsWith('어김:')) {
    const said = actual.slice(3).trim()
    const i = said ? lines.findIndex(([, , x]) => x.includes(said) || said.includes(x)) : -1
    return i < 0 ? null : i
  }
  if (c.name === '대본 진행') {
    const firstUnsaid = Number(/\[(\d+)/.exec(actual)?.[1])
    const last = script[firstUnsaid - 2] // 대본 번호는 1부터
    const i = lines.findIndex(([, who, x]) => who === '고객' && x === last)
    return i < 0 ? lines.length - 1 : i // 못 찾으면 통화의 마지막 말
  }
  return null
}
