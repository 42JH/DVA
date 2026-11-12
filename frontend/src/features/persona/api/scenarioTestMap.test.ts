// 실행: npx tsx src/features/persona/api/scenarioTestMap.test.ts  (프레임워크 없이 assert만)
import assert from 'node:assert/strict'
import { runsToTests, tagOf, unwrap, type RunDto } from './scenarioTestMap'

type Item = RunDto['items'][number]
const item = (scenario: string, status: Item['status'], passed: boolean | null = null): Item => ({
  scenario,
  status,
  passed,
  error: status === 'error' ? '연결 실패' : null,
  liveSeconds: status === 'done' ? 10 : null,
})
const run = (
  runId: string,
  createdAt: string,
  tag: string | null,
  items: Item[],
  status: RunDto['status'] = 'done',
): RunDto => ({ runId, createdAt, tag, status, items })

assert.equal(tagOf(1, 7), '1:7')

// 버전(tag)별로 모이고, 표시가 없거나 모양이 다른 묶음은 빠짐
const first = run('r1', '2026-11-12T09:00:00.000', '1:7', [
  item('A1', 'done', true),
  item('B1', 'error'),
  item('B3', 'done', false),
])
const tests = runsToTests([
  first,
  run('r2', '2026-11-12T09:10:00.000', '1:6', [item('A1', 'done', false)]),
  run('r3', '2026-11-12T09:20:00.000', null, [item('A1', 'done', true)]),
  run('r4', '2026-11-12T09:30:00.000', '직접 돌림', [item('A1', 'done', true)]),
])
assert.deepEqual(tests.map((t) => [t.personaSeq, t.version, t.status, t.items.length]).sort(), [
  [1, 6, 'done', 1],
  [1, 7, 'done', 3],
])

// 연결 실패만 다시 시험 — 그 시나리오만 새 묶음의 결과로 바뀌고 나머지는 그대로. 받은 순서와 무관하게 최신이 이김
const retry = run('r5', '2026-11-12T09:40:00.000', '1:7', [item('B1', 'done', true)])
for (const order of [
  [first, retry],
  [retry, first],
]) {
  const [v7] = runsToTests(order)
  assert.deepEqual(v7.items.map((i) => [i.scenario, i.runId, i.status, i.passed]).sort(), [
    ['A1', 'r1', 'done', true],
    ['B1', 'r5', 'done', true],
    ['B3', 'r1', 'done', false],
  ])
  assert.equal(v7.startedAt, '2026-11-12T09:40:00.000') // 가장 최근 묶음을 시작한 때
}

// 다시 시험이 도는 중 — 버전은 '시험 중', 그 시나리오는 새 묶음의 상태(대기 · 시험 중)
const running = run('r6', '2026-11-12T09:50:00.000', '1:7', [item('B1', 'running')], 'running')
const [live] = runsToTests([first, running])
assert.equal(live.status, 'running')
assert.equal(live.items.find((i) => i.scenario === 'B1')?.status, 'running')

// 돌다가 꺼진 묶음 — 못 끝낸 항목은 그 전 결과를 가리지 않고, 끝낸 항목은 반영
const cut = run(
  'r7',
  '2026-11-12T10:00:00.000',
  '1:7',
  [item('A1', 'done', false), item('B3', 'running'), item('E1', 'queued')],
  'interrupted',
)
const [after] = runsToTests([first, cut])
assert.equal(after.status, 'done')
assert.deepEqual(after.items.map((i) => [i.scenario, i.runId, i.status, i.passed]).sort(), [
  ['A1', 'r7', 'done', false],
  ['B1', 'r1', 'error', null],
  ['B3', 'r1', 'done', false],
]) // E1은 한 번도 끝난 적이 없어 없음

// 같은 때 시작한 묶음은 번호가 큰 쪽이 최신
const same = runsToTests([
  run('a', '2026-11-12T11:00:00.000', '2:1', [item('A1', 'done', true)]),
  run('b', '2026-11-12T11:00:00.000', '2:1', [item('A1', 'done', false)]),
])
assert.equal(same[0].items[0].runId, 'b')
assert.deepEqual(runsToTests([]), [])
// 응답 알맹이 — 백엔드가 감싼 것({ data, meta })과 감싸지 않은 것(창구 직접 · 가짜 창구)을 둘 다 받음
const runList = [run('r1', '2026-11-12T09:00:00.000', '1:7', [])]
assert.deepEqual(unwrap({ data: runList, meta: { requestId: 'x' } }), runList) // 백엔드 기본 모양
assert.deepEqual(unwrap({ data: runList }), runList)
assert.deepEqual(unwrap(runList), runList) // 감싸지 않은 배열
assert.equal(unwrap({ data: null, meta: { requestId: 'x' } }), null)
const verdict = { scenario: 'F1', passed: false, checks: [] }
assert.deepEqual(unwrap(verdict), verdict) // 감싸지 않은 객체
const odd = { data: 1, other: 2 }
assert.deepEqual(unwrap(odd), odd) // data 말고 다른 칸이 있으면 창구의 응답으로 봄
console.log('scenarioTestMap ok')
