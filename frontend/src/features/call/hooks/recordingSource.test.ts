// 실행: npx vitest run src/features/call/hooks  (프레임워크 없이 assert만)
import assert from 'node:assert/strict'
import { pickSource } from './useRecordingPlayer'

const rec = (seq: number, url: string | null) => ({
  recordingSeq: seq,
  url,
  expiresAt: '2026-11-02T10:04:00+09:00',
  error: null,
})

const a = pickSource(null, rec(1, 'u1'), false)
assert.equal(a?.url, 'u1')
assert.equal(pickSource(a, rec(1, 'u2'), false), a) // 같은 녹취 · 재조회로 URL 글자만 바뀜 → 쓰던 URL 그대로 (듣던 소리 유지)
assert.equal(pickSource(a, rec(1, 'u2'), true)?.url, 'u2') // 만료 · 재생 오류 뒤 새 URL → 바꿈
assert.equal(pickSource(a, rec(2, 'u3'), false)?.url, 'u3') // 다른 녹취 → 바꿈
assert.equal(pickSource(a, null, false), null) // 녹취 없음
assert.equal(pickSource(a, rec(1, null), true), a) // 새 URL 발급 실패 → 쓰던 것 유지
assert.equal(pickSource(null, rec(1, null), false), null) // 처음부터 발급 실패
assert.equal(pickSource(a, rec(1, 'u1'), true), a) // 같은 URL이 다시 옴 → 그대로 (같은 걸 또 꽂아 오류를 되풀이하지 않음)
console.log('recordingSource.test ok')
