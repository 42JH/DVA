// 실행: npx tsx src/shared/lib/dateRange.test.ts
import assert from 'node:assert/strict'
import { addDays, addMonths, todayYmd } from './dateRange'

assert.equal(addDays('2026-10-31', 1), '2026-11-01') // 달 넘김
assert.equal(addDays('2026-03-01', -1), '2026-02-28')

// 오늘(KST) — UTC 10/31 15:00 = 한국 11/01 00:00
assert.equal(todayYmd(Date.UTC(2026, 9, 31, 15)), '2026-11-01')
assert.equal(todayYmd(Date.UTC(2026, 9, 31, 14, 59)), '2026-10-31')

// 달 이동 — 해 넘김
assert.equal(addMonths('2026-12', 1), '2027-01')
assert.equal(addMonths('2026-01', -1), '2025-12')

console.log('dateRange.test ok')
