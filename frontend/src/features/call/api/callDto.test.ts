// 실행: npx tsx src/features/call/api/callDto.test.ts  (프레임워크 없이 assert만)
import assert from 'node:assert/strict'
import {
  OUTCOME_OF,
  RESULT_OF,
  durationSec,
  toCallDetail,
  utteranceAt,
  toCallRow,
  type CallDetailDto,
  type CallListItemDto,
} from './callDto'

const call = {
  callSessionSeq: 9101,
  customerName: '강도윤',
  callerPhoneNumber: '010-6638-2047',
  orderSeq: 10519,
  orderStatus: null,
  startedAt: '2026-11-01T04:12:08.000Z',
  endedAt: '2026-11-01T04:15:48.000Z',
  endReason: null,
  handoff: null,
}
const analysis: CallListItemDto['analysis'] = {
  result: 'REGISTERED',
  aiPersonaVersionSeq: 6,
  personaName: '빠른 접수형',
  personaVersion: 6,
  aiStartedAt: call.startedAt,
  aiEndedAt: call.endedAt,
  repeatQuestionCount: 3,
  hasComplaint: true,
  complaints: [
    {
      type: 'REPEATED_QUESTION',
      evidenceText: '세 번 물음',
      offsetSeconds: 31,
      utteranceOrders: [8, 9],
    },
  ],
  analysedAt: call.endedAt,
}

// 결과 코드 ↔ 화면 코드가 서로 되돌아감
for (const k of Object.keys(RESULT_OF) as (keyof typeof RESULT_OF)[])
  assert.equal(OUTCOME_OF[RESULT_OF[k]], k)

// 목록 줄: 분석 있음
const row = toCallRow({ ...call, analysis })
assert.equal(row.outcome, 'SUCCESS')
assert.equal(row.callerNumber, '01066382047') // 하이픈 제거
assert.equal(row.durationSec, 220)
assert.deepEqual(row.complaint, { type: 'REPEATED_QUESTION', reason: '세 번 물음' })

// 분석 전 · 시각 없음 — 성공 · 불만 없음으로 보지 않음
const bare = toCallRow({ ...call, callerPhoneNumber: null, endedAt: null, analysis: null })
assert.equal(bare.outcome, null)
assert.equal(bare.complaint, null)
assert.equal(bare.durationSec, null)
assert.equal(bare.callerNumber, '')
assert.equal(durationSec(null, call.endedAt), null)

// 상세: 녹취는 url 있는 것 우선, 페르소나 null 처리, 세 목록 변환
const detail: CallDetailDto = {
  call,
  analysis: { ...analysis, personaName: null, personaVersion: null },
  aiActionCount: 7,
  recordings: [
    {
      recordingSeq: 1,
      createdAt: call.endedAt,
      url: null,
      expiresAt: null,
      playbackError: 'NOT_FOUND',
    },
    {
      recordingSeq: 2,
      createdAt: call.endedAt,
      url: 'https://x/y',
      expiresAt: '2026-11-01T05:00:00Z',
      playbackError: null,
    },
  ],
}
const d = toCallDetail(
  detail,
  [
    {
      callUtteranceSeq: 1,
      utteranceOrder: 1,
      speaker: 'AI',
      utteranceText: '안녕\n하세요',
      lastSentenceSeq: 1,
      receivedAt: call.startedAt,
      offsetSeconds: null,
    },
  ],
  [
    {
      eventId: 'e',
      eventOrder: 3,
      occurredAt: call.startedAt,
      offsetSeconds: 94,
      summaryText: 'q',
      orderSeq: null,
      action: 'QUESTION_UNANSWERED',
      unansweredQuestionSeq: 7019,
      questionText: '착불?',
      answerText: null,
      faqEntrySeq: null,
      questionUtteranceOrder: null,
      answerUtteranceOrder: null,
    },
  ],
  [
    {
      eventId: 'a',
      eventOrder: 1,
      occurredAt: call.startedAt,
      offsetSeconds: 6,
      summaryText: '보내는 분 이름 = 강도윤',
      orderSeq: null,
      action: 'FIELD_SAVED',
    },
  ],
)
assert.equal(d.persona, null)
assert.equal(d.recording?.url, 'https://x/y')
assert.equal(d.aiActionCount, 7)
assert.deepEqual(d.utterances[0], { order: 1, atSec: null, speaker: 'AI', text: '안녕\n하세요' })
assert.deepEqual(d.results[0], {
  order: 3,
  atSec: 94,
  kind: 'QUESTION_UNANSWERED',
  orderSeq: null,
  question: '착불?',
  unansweredQuestionSeq: 7019,
})
assert.deepEqual(d.actions[0], {
  order: 1,
  atSec: 6,
  kind: 'FIELD_SAVED',
  text: '보내는 분 이름 = 강도윤',
})
assert.equal(toCallDetail({ ...detail, recordings: [] }, [], [], []).recording, null)

// 시각 → 그때 하던 말 (시각 모르는 발화는 건너뜀)
const says = [
  { order: 1, atSec: 0, speaker: 'AI' as const, text: 'a' },
  { order: 2, atSec: 5, speaker: 'CUSTOMER' as const, text: 'b' },
  { order: 3, atSec: null, speaker: 'AI' as const, text: 'c' },
  { order: 4, atSec: 7, speaker: 'AI' as const, text: 'd' },
]
assert.equal(utteranceAt(says, 6)?.order, 2)
assert.equal(utteranceAt(says, 7)?.order, 4)
assert.equal(utteranceAt(says, 100)?.order, 4)
assert.equal(utteranceAt(says, -1), null)

console.log('callDto.test.ts OK')
