// 실행: npx tsx src/features/call/api/callDto.test.ts  (프레임워크 없이 assert만)
import assert from 'node:assert/strict'
import {
  durationSec,
  toCallDetail,
  utteranceAt,
  utteranceForAction,
  toCallRow,
  matchCall,
  type CallFilter,
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
  isNewCustomer: true,
  registeredParcelCount: 3,
  orderLookupCount: 0,
  cancelledParcelCount: null,
  faqAnswerCount: 2,
  hasCallbackRequest: true,
  hasHandoffRequest: false,
}

// 목록 줄: 분석 있음
const row = toCallRow({ ...call, analysis })
assert.equal(row.callerNumber, '01066382047') // 하이픈 제거
assert.equal(row.durationSec, 220)
assert.equal(row.isNew, true)
assert.deepEqual(row.counts, { accept: 3, lookup: 0, cancel: null, faq: 2 }) // null(못 모음)을 0으로 바꾸지 않음
assert.deepEqual(row.complaints, [{ type: 'REPEATED_QUESTION', reason: '세 번 물음' }])
assert.equal(row.persona, '빠른 접수형')
assert.equal(row.callbackAsked, true) // 서버 값을 그대로 (11/05 리뷰: 전엔 버려짐)
assert.equal(row.handoffAsked, false)
// 연동 전 서버(요약 칸 없음) → 모름
const old = toCallRow({
  ...call,
  analysis: { ...analysis, isNewCustomer: undefined, faqAnswerCount: undefined },
})
assert.equal(old.isNew, null)
assert.equal(old.counts?.faq, null)
assert.equal(
  toCallRow({ ...call, analysis: { ...analysis, hasCallbackRequest: null } }).callbackAsked,
  null,
) // 미수집 = 모름

// 분석 전 · 시각 없음 — 성공 · 불만 없음으로 보지 않음
const bare = toCallRow({ ...call, callerPhoneNumber: null, endedAt: null, analysis: null })
assert.equal(bare.counts, null)
assert.equal(bare.callbackAsked, null) // 분석 전 = 모름
assert.equal(bare.handoffAsked, null)
assert.deepEqual(bare.complaints, [])
assert.equal(bare.durationSec, null)
assert.equal(bare.callerNumber, '')
assert.equal(durationSec(null, call.endedAt), null)

// 04 화면 거르기 — 신규 · 상담 유형(하나라도) · 통화 시간
const none: CallFilter = { newOnly: false, kinds: [], minSec: 0, maxSec: null }
assert.equal(matchCall(row, none), true)
assert.equal(matchCall(row, { ...none, newOnly: true }), true)
assert.equal(matchCall(old, { ...none, newOnly: true }), false) // 신규인지 모름
assert.equal(matchCall(row, { ...none, kinds: ['lookup', 'faq'] }), true) // FAQ 2
assert.equal(matchCall(row, { ...none, kinds: ['lookup', 'cancel'] }), false) // 조회 0 · 취소 모름
assert.equal(matchCall(row, { ...none, minSec: 180, maxSec: 600 }), true) // 220초
assert.equal(matchCall(row, { ...none, minSec: 240 }), false)
assert.equal(matchCall(row, { ...none, maxSec: 200 }), false)
assert.equal(matchCall(bare, { ...none, minSec: 60 }), false) // 통화 시간 모름

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
      unansweredReason: 'KB_NO_ANSWER',
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
assert.equal(d.isNew, true) // 06 머리: 04 줄과 같은 신규 · 상담 유형 횟수
assert.deepEqual(d.counts, { accept: 3, lookup: 0, cancel: null, faq: 2 })
assert.equal(toCallDetail({ ...detail, analysis: null }, [], [], []).counts, null) // 분석 전
assert.deepEqual(
  [toCallDetail(detail, [], [], []).callbackAsked, toCallDetail(detail, [], [], []).handoffAsked],
  [true, false],
)
assert.equal(toCallDetail({ ...detail, analysis: null }, [], [], []).callbackAsked, null)
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
  reason: 'KB_NO_ANSWER',
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

// AI 동작 → 그 동작을 부른 고객 말: 값 조각이 든 말 > "네." 같은 짧은 대답은 건너뜀 > 그 시각의 말
const C = (order: number, atSec: number, text: string) => ({
  order,
  atSec,
  speaker: 'CUSTOMER' as const,
  text,
})
const A = (order: number, atSec: number, text: string) => ({
  order,
  atSec,
  speaker: 'AI' as const,
  text,
})
const talk = [
  A(1, 0, '보내는 분 성함을 말씀해 주세요.'),
  C(2, 5, '강도윤이요.'),
  A(3, 7, '물건을 가져갈 주소를 말씀해 주세요.'),
  C(4, 11, '강남구 역삼로 150, 5층이에요.'),
  A(5, 15, '서울 강남구 역삼로 150, 5층 맞으실까요?'),
  C(6, 19, '네.'),
  C(7, 71, '내일 오전 9시에 와 주세요.'),
  A(8, 73, '내일 09:00 맞으실까요?'),
  C(9, 77, '네.'),
]
assert.equal(utteranceForAction(talk, 20, '보내는 분 주소 = 서울 강남구 역삼로 150')?.order, 4) // 값 조각(강남구 · 역삼로 · 150)
assert.equal(utteranceForAction(talk, 6, '보내는 분 이름 = 강도윤')?.order, 2)
assert.equal(utteranceForAction(talk, 77, '수거 희망 일시 = 11.02 (월) 09:00')?.order, 7) // 값이 말에 없음 → "네." 건너뜀
assert.equal(utteranceForAction(talk, 78, '디버 접수 완료')?.order, 7) // '=' 없음 → 짧은 대답 건너뜀
assert.equal(utteranceForAction(talk, 3, '디버 접수 완료')?.order, 1) // 고객 말이 아직 없음 → 그 시각의 말

console.log('callDto.test.ts OK')
