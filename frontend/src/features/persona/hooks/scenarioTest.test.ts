// 실행: npx tsx src/features/persona/hooks/scenarioTest.test.ts  (프레임워크 없이 assert만)
import assert from 'node:assert/strict'
import type { Scenario, TestItem, VersionTest } from '@/features/persona/api/scenarioTestApi'
import {
  changeOf,
  failLine,
  restOf,
  rowsOf,
  shownCheck,
  sideLabel,
  testOf,
  type Cell,
} from './scenarioTest'

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

// 일부만 돌렸으면 partial, 전부 통과 · 실패로 판정나면 done, 도는 중이면 running
const some = test(8, 'done', [item('A1', 'done', true)])
assert.equal(testOf([some], scenarios, head, active).state, 'partial')
const all = test(8, 'done', [
  item('A1', 'done', false),
  item('B3', 'error', null),
  item('E1', 'done', true),
])
// 연결 실패가 하나라도 남으면 끝난 게 아님 — 창구 고장으로 전부 연결 실패여도 [통화에 사용하기]가 열리면 안 됨
assert.equal(testOf([all], scenarios, head, active).state, 'partial')
const broken = test(
  8,
  'done',
  scenarios.map((s) => item(s.id, 'error', null)),
)
assert.equal(testOf([broken], scenarios, head, active).state, 'partial')
const judged = test(8, 'done', [
  item('A1', 'done', false),
  item('B3', 'done', true),
  item('E1', 'done', true),
])
assert.equal(testOf([judged], scenarios, head, active).state, 'done') // 실패가 있어도 판정이 났으면 끝남
assert.equal(testOf([{ ...all, status: 'running' }], scenarios, head, active).state, 'running')
// 돌다가 꺼진 묶음 — 못 끝낸 것은 결과 없음 → 전체 시험이 끝난 게 아님
const cut = test(8, 'interrupted', [
  item('A1', 'done', true),
  item('B3', 'running', null),
  item('E1', 'queued', null),
])
assert.equal(testOf([cut], scenarios, head, active).state, 'partial')
// [남은 N개 시험] — 끊긴 것(결과 없음)과 연결 실패만, 끝난 것은 다시 걸지 않음
const rowsAs = (now: Cell[]) => now.map((c, i) => ({ id: ['A1', 'B3', 'E1'][i], now: c }))
assert.deepEqual(restOf('partial', rowsAs(['pass', 'none', 'error'])), ['B3', 'E1'])
assert.deepEqual(restOf('partial', rowsAs(['fail', 'pass', 'none'])), ['E1'])
assert.deepEqual(restOf('none', rowsAs(['none', 'none', 'none'])), []) // 시험 전은 [전체 시험]
assert.deepEqual(restOf('stale', rowsAs(['pass', 'error', 'none'])), []) // 고치기 전 글의 결과
assert.deepEqual(restOf('done', rowsAs(['pass', 'fail', 'pass'])), [])

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
const fail = (name: string, actual: unknown) =>
  failLine({ name, status: 'fail', expected: '', actual }, talk, script)
assert.equal(fail('연락처를 묻지 않는다', '어김: 보내는 분 연락처를 알려 주세요.'), 2) // AI가 한 말
assert.equal(fail('대본 진행', '말하지 못한 발화: [3]'), 3) // 마지막으로 한 대본 문장(2번)
assert.equal(fail('대본 진행', '말하지 못한 발화: [1, 2, 3]'), 4) // 한 문장도 못 했으면 마지막 말
assert.equal(fail('물품', '없음'), null) // 값만 틀린 것은 위치를 모름
assert.equal(
  failLine({ name: '대본 진행', status: 'pass', expected: '', actual: '' }, talk, script),
  null,
)
// 대화 기록보다 판정이 먼저 온 때 — 줄이 없으니 위치도 없음 (실제 창구에 붙였을 때 화면이 깨졌던 경우, 11/12)
const noLines = (name: string, actual: unknown) =>
  failLine({ name, status: 'fail', expected: '', actual }, [], script)
assert.equal(noLines('대본 진행', '말하지 못한 발화: [3]'), null)
assert.equal(noLines('연락처를 묻지 않는다', '어김: 보내는 분 연락처를 알려 주세요.'), null)
// 대본 진행 → 화면 문구 (판정기 문구는 그대로, 11/13)
const shown = (status: 'pass' | 'fail', actual: unknown) =>
  shownCheck({ name: '대본 진행', status, expected: '필수 발화를 모두 말함', actual }, script)
assert.deepEqual(shown('fail', '말하지 못한 발화: [3]'), {
  name: '고객 대본 완료',
  expected: '모든 대사 진행',
  actual: '진행 못 한 대사: 대전 유성구요.',
  flag: '이후 대본 중단',
})
assert.equal(
  shown('fail', '말하지 못한 발화: [2, 3]').actual,
  '진행 못 한 대사: 010-7777-8888이요.\n대전 유성구요.',
)
assert.equal(shown('fail', '말하지 못한 발화: [9]').actual, '진행 못 한 대사: 9번 대사') // 대본을 아직 못 불러옴
assert.equal(shown('pass', '필수 발화를 모두 말함').actual, '모든 대사 진행')
assert.equal(
  shownCheck({ name: '물품', status: 'fail', expected: 'a', actual: 'b' }, script).name,
  '물품',
)
// 버전을 부르는 말 — 통화에 쓰는 버전 · 같은 상담가의 최신 · 옛 버전 · 다른 상담가
const live = { personaSeq: 1, version: 3 }
assert.equal(
  sideLabel({ personaSeq: 1, version: 3, isHead: true }, live, '빠른 접수형'),
  '통화에 쓰는 내용',
)
assert.equal(
  sideLabel({ personaSeq: 1, version: 4, isHead: true }, live, '빠른 접수형'),
  '고친 내용',
)
assert.equal(
  sideLabel({ personaSeq: 1, version: 2, isHead: false }, live, '빠른 접수형'),
  '이전 내용',
)
assert.equal(sideLabel({ personaSeq: 2, version: 1, isHead: true }, live, '친절형'), '친절형')
console.log('scenarioTest ok')
