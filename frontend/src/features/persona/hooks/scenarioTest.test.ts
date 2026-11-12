// 실행: npx tsx src/features/persona/hooks/scenarioTest.test.ts  (프레임워크 없이 assert만)
import assert from 'node:assert/strict'
import type { Scenario, TestItem, VersionTest } from '@/features/persona/api/scenarioTestApi'
import { changeOf, failLine, rowsOf, testOf } from './scenarioTest'

const scenarios: Scenario[] = ['A1', 'B3', 'E1'].map((id) => ({
  id,
  name: id,
  group: '접수',
  core: true,
}))
const item = (scenario: string, status: TestItem['status'], passed: boolean | null): TestItem => ({
  scenario,
  runId: 'r',
  status,
  passed,
  error: null,
  liveSeconds: null,
})
const test = (
  version: number,
  status: VersionTest['status'],
  items: TestItem[],
  personaSeq = 1,
): VersionTest => ({ personaSeq, version, status, startedAt: '', finishedAt: null, items })

// 변화 — 둘 다 끝났을 때만
assert.equal(changeOf('pass', 'fail'), '새로 실패')
assert.equal(changeOf('fail', 'pass'), '새로 통과')
assert.equal(changeOf('fail', 'fail'), '같음')
assert.equal(changeOf('pass', 'error'), '') // 연결 실패는 비교 안 함
assert.equal(changeOf('none', 'fail'), '')

const active = { personaSeq: 1, version: 6 }
const v6 = test(6, 'done', [
  item('A1', 'done', true),
  item('B3', 'done', true),
  item('E1', 'done', false),
])
const head = { personaSeq: 1, version: 8, isHead: true }

// 시험 전 — 통화에 사용 중인 버전의 결과는 '고치기 전 결과'로 치지 않음
assert.equal(testOf([v6], scenarios, head, active).state, 'none')
// 고치기 전 버전(v7)만 시험했으면 그 결과를 보여 주되 stale
const v7 = test(7, 'done', [item('A1', 'done', false)])
assert.deepEqual(testOf([v6, v7], scenarios, head, active), { state: 'stale', shown: v7 })
// 지난 버전을 볼 때는 다른 버전 결과를 빌려 오지 않음
assert.equal(testOf([v6, v7], scenarios, { ...head, isHead: false }, active).state, 'none')

// 핵심만 돌렸으면 partial, 전부 끝나면(연결 실패 포함) done, 도는 중이면 running
const some = test(8, 'done', [item('A1', 'done', true)])
assert.equal(testOf([some], scenarios, head, active).state, 'partial')
const all = test(8, 'done', [
  item('A1', 'done', false),
  item('B3', 'error', null),
  item('E1', 'done', true),
])
assert.equal(testOf([all], scenarios, head, active).state, 'done')
assert.equal(testOf([{ ...all, status: 'running' }], scenarios, head, active).state, 'running')
// 돌다가 꺼진 묶음 — 못 끝낸 것은 결과 없음 → 전체 시험이 끝난 게 아님
const cut = test(8, 'interrupted', [
  item('A1', 'done', true),
  item('B3', 'running', null),
  item('E1', 'queued', null),
])
assert.equal(testOf([cut], scenarios, head, active).state, 'partial')

assert.deepEqual(
  rowsOf(scenarios, v6, all).map((r) => [r.id, r.base, r.now, r.change]),
  [
    ['A1', 'pass', 'fail', '새로 실패'],
    ['B3', 'pass', 'error', ''],
    ['E1', 'fail', 'pass', '새로 통과'],
  ],
)
// 실패한 판정 → 대화의 어느 말
const talk: [number, 'AI' | '고객', string][] = [
  [1, 'AI', '안녕하세요. 접수 도와드릴까요?'],
  [3, '고객', '네. 받는 사람은 박서준이에요.'],
  [6, 'AI', '보내는 분 연락처를 알려 주세요.'],
  [9, '고객', '010-7777-8888이요.'],
  [12, 'AI', '번호를 다시 말씀해 주세요.'],
]
const script = ['네. 받는 사람은 박서준이에요.', '010-7777-8888이요.', '대전 유성구요.']
const fail = (name: string, actual: unknown, at?: number) =>
  failLine({ name, status: 'fail', expected: '', actual, at }, talk, script)
assert.equal(fail('기존 주문 상태', { 이지은: 'PAID' }, 7), 2) // 판정이 준 시각에 하던 말
assert.equal(fail('연락처를 묻지 않는다', '어김: 보내는 분 연락처를 알려 주세요.'), 2) // AI가 한 말
assert.equal(fail('대본 진행', '말하지 못한 발화: [3]'), 3) // 마지막으로 한 대본 문장(2번)
assert.equal(fail('대본 진행', '말하지 못한 발화: [1, 2, 3]'), 4) // 한 문장도 못 했으면 마지막 말
assert.equal(fail('물품', '없음'), null) // 값만 틀린 것은 위치를 모름
assert.equal(
  failLine({ name: '대본 진행', status: 'pass', expected: '', actual: '' }, talk, script),
  null,
)
// 대화 기록보다 판정이 먼저 온 때 — 줄이 없으니 위치도 없음 (실제 창구에 붙였을 때 화면이 깨졌던 경우, 11/12)
const noLines = (name: string, actual: unknown, at?: number) =>
  failLine({ name, status: 'fail', expected: '', actual, at }, [], script)
assert.equal(noLines('대본 진행', '말하지 못한 발화: [3]'), null)
assert.equal(noLines('기존 주문 상태', {}, 7), null)
console.log('scenarioTest ok')
