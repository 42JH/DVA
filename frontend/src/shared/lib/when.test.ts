import { test } from 'node:test'
import assert from 'node:assert/strict'
import { date, dateTime } from './when'

test('날짜 형식', () => {
  assert.equal(dateTime('2026-10-25T02:11:00Z'), '2026-10-25 11:11') // TZ=Asia/Seoul
  assert.equal(date('2026-01-05T15:30:00Z'), '2026-01-06')
  assert.equal(dateTime(null), '')
  assert.equal(dateTime('nope'), '')
})
