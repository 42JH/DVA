// 실행: npx tsx src/shared/lib/dateRange.test.ts
import assert from 'node:assert/strict'
import {
  addDays,
  addMonths,
  fmtRange,
  monthGrid,
  periodToRange,
  pickRange,
  rangeDays,
  todayYmd,
} from './dateRange'

// 2026-10 달력: 10/1 목요일(firstDow 4), 31일
const g = monthGrid(2026, 10)
assert.equal(g.length, 4 + 31)
assert.deepEqual(g.slice(0, 5), [null, null, null, null, 1])
assert.equal(g[g.length - 1], 31)

assert.equal(addDays('2026-10-31', 1), '2026-11-01') // 달 넘김
assert.equal(addDays('2026-03-01', -1), '2026-02-28')

// 범위 고르기
let r = pickRange({}, '2026-10-15')
assert.deepEqual(r, { from: '2026-10-15' })
r = pickRange(r, '2026-10-01') // 앞 날짜를 두 번째로 → 뒤집힘
assert.deepEqual(r, { from: '2026-10-01', to: '2026-10-15' })
r = pickRange(r, '2026-10-20') // 완성된 뒤 클릭 → 새로 시작
assert.deepEqual(r, { from: '2026-10-20' })

assert.equal(rangeDays('2026-10-01', '2026-10-15'), 15) // 와이어프레임 '15일'
assert.equal(rangeDays('2026-10-20', '2026-10-20'), 1)

// 기간 → 서버 from/to (to 미포함)
assert.deepEqual(periodToRange('today', undefined, '2026-10-20'), {
  from: '2026-10-20',
  to: '2026-10-21',
})
assert.deepEqual(periodToRange('week', undefined, '2026-10-20'), {
  from: '2026-10-14',
  to: '2026-10-21',
}) // 와이어프레임 10-14~10-20
assert.deepEqual(periodToRange('custom', { from: '2026-10-01', to: '2026-10-15' }), {
  from: '2026-10-01',
  to: '2026-10-16',
})
assert.equal(periodToRange('custom'), null)

const today = '2026-10-20'
assert.equal(fmtRange('2026-10-01', '2026-10-15', today), '10-01 ~ 10-15')
assert.equal(fmtRange('2025-12-29', '2026-01-04', today), '2025-12-29 ~ 2026-01-04') // 한쪽이 다른 해면 양쪽 다 연도

console.log('dateRange.test ok')

// 오늘(KST) — UTC 10/31 15:00 = 한국 11/01 00:00
assert.equal(todayYmd(Date.UTC(2026, 9, 31, 15)), '2026-11-01')
assert.equal(todayYmd(Date.UTC(2026, 9, 31, 14, 59)), '2026-10-31')

// 달 이동 — 해 넘김
assert.equal(addMonths('2026-12', 1), '2027-01')
assert.equal(addMonths('2026-01', -1), '2025-12')
