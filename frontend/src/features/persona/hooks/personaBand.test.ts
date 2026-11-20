// 실행: npm test
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bandStep, confirmCopy, nameI, type Confirming } from './personaBand'

const none = { state: 'none', allPass: false, stopped: null, fail: 0 }
const running = { ...none, state: 'running' }
const allPass = { ...none, state: 'done', allPass: true }
const failed = { ...none, state: 'done', fail: 2 }
const stopped = { ...none, state: 'partial', stopped: { at: '2026-11-13T19:00:00' } }

test('사용 중 상담가 — 고친 내용이 없으면 띠 없음, 있으면 시험 상태를 따라감', () => {
  const who = { applying: false, switching: false, unapplied: true }
  assert.equal(bandStep({ ...who, unapplied: false }, allPass), null)
  assert.equal(bandStep(who, none), 'unapplied')
  assert.equal(bandStep(who, running), 'testing')
  assert.equal(bandStep(who, stopped), 'stopped')
  assert.equal(bandStep(who, failed), 'review')
  assert.equal(bandStep(who, { ...failed, state: 'partial' }), 'review') // 연결 실패가 섞인 일부 시험
  assert.equal(bandStep(who, allPass), 'unapplied') // 통과해도 반영 전 — [통화에 반영]이 시험 없이 반영
  assert.equal(bandStep({ ...who, applying: true }, running), 'applying')
})

test('통화에 안 쓰는 상담가(6번) — 시험 전엔 띠 없음, 통과하면 시험 통과 띠', () => {
  const who = { applying: false, switching: true, unapplied: false }
  assert.equal(bandStep(who, none), null)
  assert.equal(bandStep(who, running), 'testing')
  assert.equal(bandStep(who, allPass), 'passed')
  assert.equal(bandStep(who, stopped), 'stopped')
  assert.equal(bandStep(who, failed), 'review')
  assert.equal(bandStep({ ...who, applying: true }, allPass), 'applying')
})

const fast = { name: '빠른 접수형', inUse: true }
const kind = { name: '친절형', inUse: false }
const base = {
  step: null,
  current: fast,
  inUseName: fast.name,
  liveCalls: null,
  sameTalk: false,
  test: { failed: ['접수', '조회'], toRun: 10, resume: false, allPass: false, total: 10 },
  find: (seq: number) => (seq === 1 ? fast : seq === 2 ? kind : undefined),
} as const
const copy = (c: Confirming, more: Partial<Parameters<typeof confirmCopy>[1]> = {}) =>
  confirmCopy(c, { ...base, ...more })

test('이름 끝 글자의 받침으로 조사를 고름', () => {
  assert.equal(nameI('친절형'), '친절형이')
  assert.equal(nameI('김민수'), '김민수가')
  assert.equal(nameI('Fast'), 'Fast가') // 한글이 아니면 받침 없음으로
})

test('띠의 [통화에 반영] — 시험부터(통과해도 반영은 따로) · 남은 것만', () => {
  assert.deepEqual(copy({ kind: 'test' }), {
    title: '통화에 반영하기 전에 시험할까요?',
    note: '시나리오 10개를 모두 돌린 뒤, 결과를 보고 통화에 반영합니다.',
    okLabel: '시험 시작',
  })
  const rest = { ...base.test, toRun: 3, resume: true }
  assert.match(copy({ kind: 'test' }, { test: rest })!.note, /^남은 시나리오 3개를 돌린 뒤,/)
  // 6번 — 다른 상담가는 시험만 (통과해도 저절로 바꾸지 않음)
  assert.deepEqual(copy({ kind: 'test' }, { current: kind }), {
    title: '통화에 쓰기 전에 친절형을 시험할까요?',
    note: '시나리오 10개를 모두 돌린 뒤, 결과를 보고 통화에 사용할지 정합니다.',
    okLabel: '시험 시작',
  })
})

test('시험 없이 반영 · 다른 상담가로 바꾸기', () => {
  assert.equal(
    copy({ kind: 'use', personaSeq: 1 })!.note,
    '반영하면 다음 통화부터 고친 내용으로 응대합니다.',
  )
  assert.equal(
    copy({ kind: 'use', personaSeq: 1 }, { test: { ...base.test, allPass: true } })!.note,
    '시나리오 10개를 모두 통과했습니다. 반영하면 다음 통화부터 고친 내용으로 응대합니다.',
  )
  assert.equal(
    copy({ kind: 'use', personaSeq: 1 }, { sameTalk: true })!.note,
    '프롬프트와 목소리가 통화에 쓰는 내용과 같아 시험 없이 반영합니다.',
  )
  assert.deepEqual(copy({ kind: 'use', personaSeq: 2 }, { liveCalls: 2 }), {
    title: '친절형을 통화에 사용할까요?',
    note: '다음 통화부터 빠른 접수형 대신 친절형이 응대합니다. 지금 통화 중인 2건은 바뀌지 않습니다.',
    okLabel: '사용하기',
  })
  // 통화에 쓰는 상담가가 없으면 '대신' 없이, 통화 중이 0건이면 뒷말 없이
  assert.equal(
    copy({ kind: 'use', personaSeq: 2 }, { inUseName: null, liveCalls: 0 })!.note,
    '다음 통화부터 친절형이 응대합니다.',
  )
  assert.equal(copy({ kind: 'use', personaSeq: 9 }), null) // 그새 지워진 상담가
})

test('확인하고 반영 — 실패 이름을 같이, 그새 상태가 바뀌면 닫음', () => {
  assert.equal(copy({ kind: 'review' }), null)
  assert.deepEqual(copy({ kind: 'review' }, { step: 'review' }), {
    title: '실패한 시나리오 2개가 있습니다. 통화에 반영할까요?',
    note: '반영하면 다음 통화부터 고친 내용으로 응대합니다.',
    okLabel: '반영',
    failed: ['접수', '조회'],
  })
  assert.deepEqual(copy({ kind: 'review' }, { step: 'review', current: kind }), {
    title: '실패한 시나리오 2개가 있습니다. 친절형을 통화에 사용할까요?',
    note: '다음 통화부터 빠른 접수형 대신 친절형이 응대합니다.',
    okLabel: '사용하기',
    failed: ['접수', '조회'],
  })
})

test('시험 중단 · 삭제는 빨간 버튼, 불러오기는 확인 창 없음', () => {
  assert.equal(copy({ kind: 'stop' }), null) // 그새 시험이 끝남
  assert.deepEqual(copy({ kind: 'stop' }, { step: 'testing' }), {
    title: '시험을 중단할까요?',
    note: '지금까지 돌린 결과는 남습니다. 통화에는 반영되지 않고, 다시 시험해야 반영할 수 있습니다.',
    okLabel: '중단',
    danger: true,
  })
  assert.deepEqual(copy({ kind: 'delete', personaSeq: 2 }), {
    title: '친절형을 삭제할까요?',
    note: '삭제하면 되돌릴 수 없습니다.',
    okLabel: '삭제',
    danger: true,
  })
  assert.equal(copy(null), null)
})
