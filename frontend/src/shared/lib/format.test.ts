// 실행: npx tsx src/shared/lib/format.test.ts  (프레임워크 없이 assert만 — 규칙이 깨지면 여기서 먼저 터짐)
import assert from 'node:assert/strict'
import {
  fmtDate,
  fmtDateTime,
  fmtDateTimeDay,
  fmtDetailTime,
  fmtDuration,
  fmtListTime,
  fmtPhone,
} from './format'

const t = '2026-10-20T14:33:05+09:00' // 화요일

assert.equal(fmtDateTime(t), '10.20 14:33')
assert.equal(fmtDate(t), '2026.10.20')
assert.equal(fmtDateTimeDay(t), '10.20 (화) 14:33')
assert.equal(fmtDuration(220), '3분 40초')
assert.equal(fmtDuration(52), '0분 52초')
assert.equal(fmtPhone('01066382047'), '010-6638-2047')
assert.equal(fmtPhone('0312345678'), '031-234-5678') // 10자리
assert.equal(fmtPhone('1588'), '1588') // 모르는 길이는 그대로

// 연도 규칙: 올해면 한 줄, 작년 포함 다른 해면 날짜 · 시각 두 줄
const now = new Date('2026-10-20T15:00:00+09:00')
assert.deepEqual(fmtListTime(t, now), ['10.20 14:33'])
assert.deepEqual(fmtListTime('2025-12-29T13:40:00+09:00', now), ['2025.12.29', '13:40'])
assert.equal(fmtDetailTime(t, { seconds: true, now }), '10.20 (화) 14:33:05')
assert.equal(fmtDetailTime('2025-12-29T13:40:00+09:00', { now }), '2025.12.29 (월) 13:40')

console.log('format.test ok')
