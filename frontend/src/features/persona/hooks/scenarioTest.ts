// 시나리오 시험 결과 읽기 (순수 함수, scenarioTest.test.ts) — 표의 칸 · 변화 · [통화에 사용하기] 관문
import type { Check, Scenario, TestItem, VersionTest } from '../api/scenarioTestApi'

/** 표의 한 칸: 통과 · 실패 · 연결 실패 · 시험 중 · 대기 · 결과 없음 */
export type Cell = 'pass' | 'fail' | 'error' | 'running' | 'queued' | 'none'
type Change = '새로 실패' | '새로 통과' | '같음' | ''
/** 한 버전의 시험 상태 — none 시험 전 · running 시험 중 · partial 일부만 시험 · done 전체 시험 끝남 · stale 고치기 전 글의 결과만 있음 */
type TestState = 'none' | 'running' | 'partial' | 'done' | 'stale'

type Key = { personaSeq: number; version: number }
const same = (a: Key, b: Key | null) =>
  !!b && a.personaSeq === b.personaSeq && a.version === b.version

/** 버전을 부르는 말 (화면에 '버전'이라는 말 없음). 시험 결과 위 줄 · 표 머리 · 상세 탭이 같이 씀
 *  통화에 쓰는 버전 = '통화에 쓰는 내용', 사용 중 상담가의 최신 = '고친 내용', 그 상담가의 더 옛 버전 = '이전 내용', 다른 상담가 = 그 이름 */
export function sideLabel(me: Key & { isHead: boolean }, active: Key | null, name: string) {
  if (same(me, active)) return '통화에 쓰는 내용'
  if (me.personaSeq !== active?.personaSeq) return name
  return me.isHead ? '고친 내용' : '이전 내용'
}

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
    // 끝남 = 통과 · 실패 판정이 났음. 연결 실패는 시험을 못 한 것 → 다시 시험해야 전체 시험이 끝남
    const judged = (id: string) => {
      const c = cellOf(
        mine.items.find((i) => i.scenario === id),
        false,
      )
      return c === 'pass' || c === 'fail'
    }
    return { state: scenarios.every((s) => judged(s.id)) ? 'done' : 'partial', shown: mine }
  }
  const before = me.isHead
    ? tests
        .filter((t) => t.personaSeq === me.personaSeq && t.version < me.version && !same(t, active))
        .sort((a, b) => b.version - a.version)[0]
    : undefined
  return before ? { state: 'stale', shown: before } : { state: 'none', shown: null }
}

/** 통화에 쓰는 버전을 시험한 적이 없으면(이름만 바꿔 시험 없이 반영한 버전) 내용이 같은 앞 버전의 결과를 그 버전 것으로 옮겨 봄
 *  — 시험 결과 표 · 상세 · 비교 기준이 모두 같은 결과를 봄 (안 옮기면 이름을 바꾼 뒤 '통화에 쓰는 내용'이 '결과 없음') */
export function withActiveTests(
  tests: VersionTest[],
  versions: { version: number; talk: string }[],
  active: Key | null,
): VersionTest[] {
  const base = baseOf(tests, versions, active)
  if (!active || !base || base.version === active.version) return tests
  return tests.map((t) => (t === base ? { ...t, version: active.version } : t))
}

/** 통화에 쓰는 내용의 시험 결과. 그 버전 것이 없으면 AI가 받는 것(프롬프트 · 목소리)이 같은 바로 앞 버전들의 결과
 *  versions = 그 상담가의 버전들(순서 무관), talk = 프롬프트 · 목소리를 합친 글. 목록을 받기 전(빈 배열)이면 그 버전 것만 */
export function baseOf(
  tests: VersionTest[],
  versions: { version: number; talk: string }[],
  active: Key | null,
): VersionTest | null {
  if (!active) return null
  const of = (version: number) => tests.find((t) => same(t, { ...active, version }))
  const talk = versions.find((v) => v.version === active.version)?.talk
  for (const v of [...versions].sort((a, b) => b.version - a.version)) {
    if (v.version > active.version) continue
    if (v.talk !== talk) break
    const t = of(v.version)
    if (t) return t
  }
  return of(active.version) ?? null
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

/** [남은 N개 시험]에 보낼 시나리오 — 연결 실패 + 결과 없음(AI 배포 등으로 중간에 끊긴 묶음).
 *  일부만 시험한 이 버전의 결과일 때만: 시험 전이면 [전체 시험]과 같고, 고치기 전 결과(stale)에는 없음. 끝난 것은 다시 걸지 않음(요금) */
export function restOf(state: TestState, rows: { id: string; now: Cell }[]): string[] {
  if (state !== 'partial') return []
  const rest = rows.filter((x) => x.now === 'error' || x.now === 'none').map((x) => x.id)
  // 끝난 것이 하나도 없으면(시작하자마자 멈춤 · 전부 연결 실패) 남은 것 = 전체 — [전체 시험]과 같은 버튼을 하나 더 두지 않음
  return rest.length === rows.length ? [] : rest
}

/** 실패 · 확인 필요 판정이 통화의 어느 말에서 났는지 — 대화 줄 번호, 알 수 없으면 null (값만 틀린 코드 검사는 위치가 없음)
 *  1) 행동 확인 '어김: <AI가 한 말>' · '확인 필요: <AI가 한 말>' → 그 AI 말 (고객의 "네"가 인용 안에 들어 있어도 고객 줄로 가지 않게)
 *  2) 대본 진행 '말하지 못한 발화: [4, 5]' → 고객이 마지막으로 한 대본 문장(3번) = 통화가 더 나아가지 못한 곳
 *  ponytail: 판정기의 문구를 읽는 것이라 문구가 바뀌면 못 찾음(null). 판정기가 실패 시각을 주게 되면 그 시각으로 찾기 */
export function failLine(c: Check, lines: Line[], script: string[]): number | null {
  // 대화 기록이 아직 안 왔으면(판정이 먼저 도착) 찾을 줄이 없음 — 없는 줄 번호를 돌려주면 화면이 깨짐
  if ((c.status !== 'fail' && c.status !== 'warn') || lines.length === 0) return null
  const actual = typeof c.actual === 'string' ? c.actual : ''
  const quoted = /^(어김|확인 필요):/.exec(actual)
  if (quoted) {
    const said = actual.slice(quoted[0].length).trim()
    const i = said
      ? lines.findIndex(([, who, x]) => who === 'AI' && (x.includes(said) || said.includes(x)))
      : -1
    return i < 0 ? null : i
  }
  if (c.name === SCRIPT_CHECK) {
    const firstUnsaid = unsaid(actual)[0]
    const last = script[firstUnsaid - 2] // 대본 번호는 1부터
    const i = lines.findIndex(([, who, x]) => who === '고객' && x === last)
    return i < 0 ? lines.length - 1 : i // 못 찾으면 통화의 마지막 말
  }
  return null
}

/** 판정기가 주는 대본 진행 항목 이름. 판정기 문구는 그대로 두고 화면에서만 바꿈 — 이미 저장된 결과도 같은 이름으로 보이게 */
const SCRIPT_CHECK = '대본 진행'
/** '말하지 못한 발화: [4, 5]' → [4, 5] (대본 번호는 1부터) */
const unsaid = (actual: unknown): number[] =>
  (/\[([\d,\s]+)\]/.exec(String(actual ?? ''))?.[1] ?? '').split(',').map(Number).filter(Boolean)

/** 결과표 · 대화 표시에 쓸 문구. 대본 진행만 바꿈: 항목 '고객 대본 완료', 정답 '모든 대사 진행',
 *  실패면 '진행 못 한 대사: <대사>'(여럿이면 줄바꿈), 대화 줄 표시 '이후 대본 중단' */
export function shownCheck(c: Check, script: string[]) {
  if (c.name !== SCRIPT_CHECK)
    return { name: c.name, expected: c.expected, actual: c.actual, flag: c.name }
  const missed = c.status === 'fail' ? unsaid(c.actual) : []
  return {
    name: '고객 대본 완료',
    expected: '모든 대사 진행',
    actual:
      c.status === 'pass'
        ? '모든 대사 진행'
        : missed.length
          ? `진행 못 한 대사: ${missed.map((n) => script[n - 1] ?? `${n}번 대사`).join('\n')}`
          : c.actual,
    flag: '이후 대본 중단',
  }
}
