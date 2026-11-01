// 실행: npx tsx src/shared/lib/callStats.test.ts  (프레임워크 없이 assert만)
import assert from 'node:assert/strict'
import { avgDurationSec } from './callStats'

const at = (sec: number) => new Date(Date.UTC(2026, 10, 2, 0, 0, sec)).toISOString()

// 끝난 통화만 평균, 시각이 빠지거나 거꾸로인 통화는 뺌
assert.equal(
  avgDurationSec([
    { startedAt: at(0), endedAt: at(60) },
    { startedAt: at(0), endedAt: at(120) },
    { startedAt: at(0), endedAt: null }, // 진행 중
    { startedAt: at(30), endedAt: at(0) }, // 거꾸로
  ]),
  90,
)
// 셀 통화가 없으면 null
assert.equal(avgDurationSec([]), null)
console.log('callStats ok')
