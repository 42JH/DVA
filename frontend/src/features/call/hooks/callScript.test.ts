// 실행: npx tsx --tsconfig tsconfig.app.json src/features/call/hooks/callScript.test.ts  (프레임워크 없이 assert만)
import assert from 'node:assert/strict'
import type { Complaint, Utterance } from '@/shared/call/callDto'
import { faqResultTimes, focusOf, marksOf, toSegments, withLead } from './callScript'

const says: Utterance[] = [
  { order: 1, atSec: 0, speaker: 'AI', text: '안녕하세요' },
  { order: 2, atSec: 5, speaker: 'CUSTOMER', text: '강도윤이요' },
  { order: 3, atSec: 6, speaker: 'AI', text: '주소를 말씀해 주세요' },
  { order: 4, atSec: 7, speaker: 'CUSTOMER', text: '몇 번을 말해야 돼요' },
  { order: 5, atSec: null, speaker: 'AI', text: '시각을 모르는 말' },
]
const timed = withLead(says)
// 고객 말은 2초 앞에서부터 듣되 앞 말과의 중간보다 앞으로는 안 감. 화면에 쓰는 시각(labelSec)은 서버 시각 그대로
assert.deepEqual(
  timed.map((u) => [u.atSec, u.labelSec]),
  [
    [0, 0],
    [3, 5],
    [6, 6],
    [6.5, 7],
    [null, null],
  ],
)

// 짚은 줄: 그 시각의 말. 고른 줄은 다음 줄이 시작하기 전까지 붙듦
const pin = { key: 3, sec: 6 }
assert.equal(focusOf(timed, null, pin), null)
assert.equal(focusOf(timed, 4, null), 2)
assert.equal(focusOf(timed, 6.1, pin), 3)
assert.equal(focusOf(timed, 6.7, pin), 4) // 다음 줄이 시작하면 놓음
assert.equal(focusOf(timed, 5, pin), 2) // 고른 시각 앞으로 돌아가면 놓음
assert.equal(focusOf(timed, 99, { key: 4, sec: 6.5 }), 4) // 뒤에 시각을 아는 줄이 없으면 끝까지

const complaint = (over: Partial<Complaint>): Complaint => ({
  type: 'INFORMATION_RECOGNITION_ERROR',
  reason: '',
  offsetSeconds: null,
  utteranceOrders: [],
  target: null,
  level: null,
  ...over,
})
const repeated = complaint({ utteranceOrders: [3, 4] }) // AI 응대 오류 — 구간으로 묶음
const angry = complaint({
  type: 'DISSATISFACTION_EXPRESSION',
  target: 'ai_service',
  utteranceOrders: [4],
  offsetSeconds: 6.5,
}) // 고객 불만 — 그 고객 말만 표시
const segments = toSegments(timed, [repeated, angry])
assert.deepEqual(
  segments.map((s) => [s.complaint !== null, s.lines.map((l) => l.key)]),
  [
    [false, [1, 2]],
    [true, [3, 4]],
    [false, [5]],
  ],
)
assert.deepEqual(
  segments[1].lines.map((l) => [l.who, l.time, l.complaint !== undefined]),
  [
    ['AI', '00:06', false],
    ['고객', '00:07', true],
  ],
)

// 재생 바 눈금: 시각을 아는 판정만, 녹취가 늦게 시작한 만큼 당김. 길이를 모르면 없음
const went: Complaint[] = []
const marks = marksOf([repeated, angry], timed, {
  shift: 1,
  lengthSec: 10,
  go: (c) => went.push(c),
})
assert.deepEqual(
  marks.map((m) => [m.tone, m.at]),
  [
    ['stop', 0.55],
    ['wait', 0.5],
  ],
)
marks[0].onClick()
assert.equal(went[0], angry)
assert.deepEqual(marksOf([angry], timed, { shift: 0, lengthSec: 0, go: () => {} }), [])

// FAQ 결과 시각: 답한 것 · 미답변(질문이 남아 있는 것)만
const result = (kind: string, atSec: number | null, question: string | null) =>
  ({
    order: 1,
    atSec,
    kind,
    orderSeq: null,
    question,
    unansweredQuestionSeq: null,
    reason: null,
  }) as never
assert.deepEqual(
  [
    ...faqResultTimes([
      result('FAQ_ANSWERED', 10, '착불 되나요'),
      result('QUESTION_UNANSWERED', 20, null),
      result('QUESTION_UNANSWERED', 30, '환불은요'),
      result('ORDER_CREATED', 40, null),
      result('FAQ_ANSWERED', null, '시각 모름'),
    ]).keys(),
  ],
  [10, 30],
)

console.log('callScript.test ok')
