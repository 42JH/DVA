import { test } from 'node:test'
import assert from 'node:assert/strict'
import { callState, memberOf, stateKey } from './callState'

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()

test('통화 상태 — 통화 중 · 분석 중 · 분석 실패 · 분석 완료 (백엔드 판정)', () => {
  const s = (d: Parameters<typeof callState>[0]) => callState(d).label
  const ended = { startedAt: ago(9), endedAt: ago(8) }
  assert.equal(
    s({ startedAt: ago(1), endedAt: null, analysis: null, analysisStatus: 'PENDING' }),
    '통화 중',
  )
  assert.equal(s({ ...ended, analysis: null, analysisStatus: 'PENDING' }), '분석 중')
  assert.equal(s({ ...ended, analysis: null, analysisStatus: 'FAILED' }), '분석 실패')
  assert.equal(s({ ...ended, analysis: null, analysisStatus: 'EXPIRED' }), '분석 만료')
  assert.equal(s({ ...ended, analysis: {}, analysisStatus: 'COMPLETED' }), '분석 완료')
  assert.equal(s({ ...ended, analysis: {}, analysisStatus: 'FAILED' }), '분석 완료') // 정상 분석이 실패보다 우선
})

test('고객 소속 — 기업 · 개인 · 미확인', () => {
  assert.equal(memberOf({ organizationName: '별빛스튜디오', customerSeq: 3 }), '별빛스튜디오')
  assert.equal(memberOf({ organizationName: null, customerSeq: 3 }), '개인')
  assert.equal(memberOf({ organizationName: null, customerSeq: null }), '')
})

test('상태 필터 — callState 글자와 짝', () => {
  assert.equal(stateKey('통화 중'), 'live')
  assert.equal(stateKey('분석 중'), 'pending')
  assert.equal(stateKey('분석 실패'), 'failed')
  assert.equal(stateKey('분석 완료'), 'done')
})
