// 실행: npm test
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Scenario, VersionTest } from '@/features/persona/api/scenarioTestApi'
import { pledgeStep, type Pledge } from './applyPledge'

const scenarios: Scenario[] = [
  { id: 'A1', name: '접수', group: '접수' },
  { id: 'B1', name: '조회', group: '조회' },
]
const item = (scenario: string, passed: boolean | null, status: 'done' | 'error' = 'done') => ({
  scenario,
  runId: 'r',
  status,
  passed,
  error: null,
  liveSeconds: 60,
})
const run = (status: VersionTest['status'], items: VersionTest['items']): VersionTest => ({
  personaSeq: 1,
  version: 8,
  status,
  startedAt: '2026-11-13T19:00:00.000',
  finishedAt: null,
  items,
})
const p: Pledge = { personaSeq: 1, version: 8, before: null, at: 1000 }
const live = { head: { version: 8 }, appliedVersion: 7, applyingVersion: null }
const allPass = run('done', [item('A1', true), item('B1', true)])

test('시험 중이면 기다림, 모두 통과로 끝나면 반영', () => {
  assert.equal(pledgeStep(p, live, [run('running', [])], scenarios, 2000), 'wait')
  assert.equal(pledgeStep(p, live, [allPass], scenarios, 2000), 'apply')
})

test('실패 · 연결 실패 · 중단이면 반영하지 않음', () => {
  const failed = run('done', [item('A1', true), item('B1', false)])
  const noCall = run('done', [item('A1', true), item('B1', null, 'error')])
  const stopped = run('stopped', [item('A1', true)])
  for (const t of [failed, noCall, stopped])
    assert.equal(pledgeStep(p, live, [t], scenarios, 2000), 'drop')
})

test('방금 건 시험이 목록에 안 보이면 기다리다가 3분 뒤 버림', () => {
  assert.equal(pledgeStep(p, live, [], scenarios, 2000), 'wait')
  assert.equal(pledgeStep(p, live, [], scenarios, 1000 + 180_000), 'drop')
  // 다시 시험(남은 것만): 전 시험 결과가 그대로 보이는 동안은 새 시험이 아직 안 보이는 것
  const again = { ...p, before: allPass.startedAt }
  assert.equal(pledgeStep(again, live, [allPass], scenarios, 2000), 'wait')
})

test('그새 다시 고쳤거나 이미 반영 · 반영 중이면 버림', () => {
  assert.equal(pledgeStep(p, undefined, [allPass], scenarios, 2000), 'drop')
  assert.equal(pledgeStep(p, { ...live, head: { version: 9 } }, [allPass], scenarios, 2000), 'drop')
  assert.equal(pledgeStep(p, { ...live, appliedVersion: 8 }, [allPass], scenarios, 2000), 'drop')
  assert.equal(pledgeStep(p, { ...live, applyingVersion: 8 }, [allPass], scenarios, 2000), 'drop')
})
