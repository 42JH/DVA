// 실행: npm test — 통계 [AI 응대 오류 | 고객 불만] 탭 세기 (11/11 Jira 148)
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CallListItemDto } from '@/shared/call/callDto'
import type { ComplaintCalls } from './api/dashboardApi'
import { complaintView } from './complaintView'

const call = (complaints: { type: string; target?: string | null }[]) =>
  ({
    callSessionSeq: 1,
    customerSeq: 1,
    customerName: '가',
    analysis: {
      hasComplaint: true,
      complaints: complaints.map((c) => ({
        evidenceText: '',
        offsetSeconds: null,
        utteranceOrders: [],
        ...c,
      })),
    },
  }) as unknown as CallListItemDto

test('AI 응대 오류 · 고객 불만을 통화 수로 따로 셈 (근거 없는 답변 · 옛 유형은 빠짐)', () => {
  const v = complaintView({ assessedCallCount: 10 } as ComplaintCalls, [
    call([{ type: 'INFORMATION_RECOGNITION_ERROR' }, { type: 'INTERRUPTION' }]),
    call([
      { type: 'INFORMATION_RECOGNITION_ERROR' },
      { type: 'DISSATISFACTION_EXPRESSION', target: 'ai_service' },
    ]),
    call([
      { type: 'DISSATISFACTION_EXPRESSION', target: 'price_policy' },
      { type: 'DISSATISFACTION_EXPRESSION', target: 'price_policy' },
    ]),
    call([{ type: 'UNSUPPORTED_ANSWER' }, { type: 'SPEAKING_TOO_FAST' }]),
    call([{ type: 'DISSATISFACTION_EXPRESSION', target: null }]),
  ])
  const [ai, customer] = v.tabs
  assert.equal(ai.value, '20.0') // 2 / 10
  assert.deepEqual(
    ai.slices.map((s) => [s.key, s.value]),
    [
      ['INFORMATION_RECOGNITION_ERROR', 2],
      ['INTENT_RECOGNITION_ERROR', 0],
      ['SLOW_RESPONSE', 0],
      ['INTERRUPTION', 1],
    ],
  )
  assert.equal(customer.value, '30.0') // 3 / 10
  assert.deepEqual(
    customer.slices.map((s) => [s.key, s.value]),
    [
      ['ai_service', 1],
      ['price_policy', 1],
      ['delivery_other', 0],
      ['none', 1],
    ],
  )
})
