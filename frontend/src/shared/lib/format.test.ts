// 실행: npx tsx src/shared/lib/format.test.ts  (프레임워크 없이 assert만 — 규칙이 깨지면 여기서 먼저 터짐)
import assert from 'node:assert/strict'
import {
  fmtDate,
  fmtDateTime,
  fmtDateTimeDay,
  fmtDay,
  fmtDayRange,
  fmtDetailTime,
  fmtClock,
  fmtDuration,
  fmtListTime,
  fmtPctSplit,
  fmtPhone,
} from './format'

const t = '2026-10-20T14:33:05+09:00' // 화요일

assert.equal(fmtDateTime(t), '10-20 14:33')
assert.equal(fmtDate(t), '2026-10-20')
assert.equal(fmtDateTimeDay(t), '10-20 (화) 14:33')
assert.equal(fmtDuration(220), '3분 40초')
assert.equal(fmtDuration(52), '0분 52초')
assert.equal(fmtDuration(3903), '1시간 5분 03초') // 한 시간 넘는 통화 (11/02)
assert.equal(fmtClock(220), '03:40')
assert.equal(fmtClock(3903), '1:05:03')
assert.equal(fmtPhone('01066382047'), '010-6638-2047')
assert.equal(fmtPhone('0312345678'), '031-234-5678') // 10자리
assert.equal(fmtPhone('1588'), '1588') // 모르는 길이는 그대로

// 연도 규칙: 올해면 한 줄, 작년 포함 다른 해면 날짜 · 시각 두 줄
const now = new Date('2026-10-20T15:00:00+09:00')
assert.deepEqual(fmtListTime(t, now), ['10-20 14:33'])
assert.deepEqual(fmtListTime('2025-12-29T13:40:00+09:00', now), ['2025-12-29', '13:40'])
assert.equal(fmtDetailTime(t, { seconds: true, now }), '10-20 (화) 14:33:05')
assert.equal(fmtDetailTime('2025-12-29T13:40:00+09:00', { now }), '2025-12-29 (월) 13:40')
assert.equal(fmtDay('2026-10-02T00:00:00+09:00', now), '10-02 (금)')
assert.equal(fmtDay('2025-12-29T00:00:00+09:00', now), '2025-12-29 (월)')
assert.equal(fmtDayRange('2026-10-02T00:00', '2026-10-20T00:00', now), '10-02 (금) ~ 10-20 (화)')
assert.equal(
  fmtDayRange('2025-12-29T00:00', '2026-10-31T00:00', now),
  '2025-12-29 (월) ~ 2026-10-31 (토)',
) // 한쪽이 다른 해면 양쪽 다

// 비율 합 100 맞춤 (따로 반올림하면 85 · 10 · 4 = 99)
assert.deepEqual(fmtPctSplit([854, 96, 44]), ['86%', '10%', '4%'])
assert.deepEqual(fmtPctSplit([1, 1, 1]), ['34%', '33%', '33%'])
assert.deepEqual(fmtPctSplit([1, 1, 1], 1), ['33.4%', '33.3%', '33.3%'])
assert.deepEqual(fmtPctSplit([0, 0, 0]), ['—', '—', '—'])
assert.deepEqual(fmtPctSplit([0, 5, 0]), ['0%', '100%', '0%'])

console.log('format.test ok')
