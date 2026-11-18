// 실행: npx tsx --tsconfig tsconfig.app.json --test src/features/stats/api/dashboardDemo.test.ts — 목데이터 불만 목록이 통계 카드 숫자와 맞는지
import assert from 'node:assert/strict'
import { complaintView } from '../complaintView'
import { demoCard, demoComplainedCalls } from './dashboardDemo'

// 전체 = 신규 + 기존 (그래프 두 막대와 건수가 맞음)
assert.equal(demoCard('stage-dropoffs', 'ALL').assessedCallCount, 1000)

const card = demoCard('complaint-calls', 'ALL')
const calls = demoComplainedCalls()
assert.equal(calls.length, card.complaintCallCount) // 133통화
assert.equal(card.typeTotalCount, 182) // 유형 다섯 개 합 (도넛)
const [ai, customer] = complaintView(card, calls).tabs
assert.equal(customer.ratio, '914통화 중 26통화') // 고객 불만 = DISSATISFACTION 통화 수
assert.ok(Number(ai.value) <= 100 && Number(customer.value) <= 100)
// 한 통화에 같은 유형이 두 번 들어가지 않음
for (const c of calls) {
  const types = c.analysis!.complaints.map((x) => x.type)
  assert.equal(new Set(types).size, types.length)
}
