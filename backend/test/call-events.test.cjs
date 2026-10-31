require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { CreateCallEventsDto } = require('../dist/call-insights/dto/create-call-events.dto');
const { createValidationPipe } = require('../dist/common/http/validation.pipe');
const pipe = createValidationPipe();
const event = (changes = {}) => ({
  eventId: randomUUID(),
  eventOrder: 1,
  kind: 'AI_ACTION',
  occurredAt: '2026-10-31T10:00:31+09:00',
  offsetSeconds: 31,
  payload: { action: 'ADDRESS_SEARCH', summaryText: '검색 결과 1건\n', orderSeq: null },
  ...changes,
});
const body = (value = event()) => ({ providerCallId: 'rtc_event_test', events: [value] });
const validate = (value) => pipe.transform(value, { type: 'body', metatype: CreateCallEventsDto });

test('events accept each discriminated payload, integer seconds, explicit nulls and 50 items', async () => {
  for (const value of [
    event(),
    event({ offsetSeconds: null }),
    event({
      kind: 'UTTERANCE',
      payload: {
        utteranceOrder: 1,
        speaker: 'CUSTOMER',
        utteranceText: ' 원문 유지\n',
        lastSentenceSeq: 2,
      },
    }),
    event({
      kind: 'BUSINESS_RESULT',
      payload: {
        action: 'INQUIRY',
        orderSeq: null,
        unansweredQuestionSeq: null,
        summaryText: '문의 안내 완료',
      },
    }),
  ]) {
    const input = body(value);
    assert.deepEqual(JSON.parse(JSON.stringify(await validate(input))), input);
  }
  assert.equal(
    (
      await validate({
        providerCallId: 'rtc',
        events: Array.from({ length: 50 }, (_, index) => event({ eventOrder: index + 1 })),
      })
    ).events.length,
    50,
  );
});

test('events require all envelope fields, reject coercion, milliseconds, latency and invalid batches', async () => {
  for (const key of Object.keys(event())) {
    const value = event();
    delete value[key];
    await assert.rejects(() => validate(body(value)), { status: 400 });
  }
  for (const change of [
    { eventId: 'invalid' },
    { eventOrder: 0 },
    { eventOrder: '1' },
    { eventOrder: 2147483648 },
    { kind: 'OTHER' },
    { occurredAt: '2026-02-30T10:00:00Z' },
    { occurredAt: '2026-10-31T10:00:00' },
    { offsetSeconds: -1 },
    { offsetSeconds: '31' },
    { offsetSeconds: 31.5 },
    { offsetSeconds: Number.MAX_SAFE_INTEGER + 1 },
    { offsetMs: 31000 },
    { responseLatencyTotalMs: 12 },
    { payload: null },
    { payload: [] },
  ])
    await assert.rejects(() => validate(body(event(change))), { status: 400 });
  for (const events of [
    null,
    [],
    {},
    [null],
    [[event()]],
    Array.from({ length: 51 }, () => event()),
  ])
    await assert.rejects(() => validate({ providerCallId: 'rtc', events }), { status: 400 });
  for (const providerCallId of ['', ' ', 'with space', 'x\u0000', 'x'.repeat(201), 123])
    await assert.rejects(() => validate({ ...body(), providerCallId }), { status: 400 });
});

test('AI actions reject status and arbitrary tool arguments while requiring nullable orderSeq', async () => {
  for (const change of [
    { action: 'OTHER' },
    { status: 'SUCCEEDED' },
    { summaryText: ' \n' },
    { summaryText: 'x'.repeat(1001) },
    { summaryText: 'x\u0000' },
    { orderSeq: undefined },
    { orderSeq: 0 },
    { orderSeq: '1' },
    { toolArguments: { credential: 'not-accepted' } },
  ])
    await assert.rejects(
      () => validate(body(event({ payload: { ...event().payload, ...change } }))),
      { status: 400 },
    );
});

test('utterance and business schemas reject wrong-kind fields, missing fields and invalid references', async () => {
  const utterance = {
    utteranceOrder: 1,
    speaker: 'AI',
    utteranceText: '안녕하세요.',
    lastSentenceSeq: 1,
  };
  const business = {
    action: 'QUESTION_UNANSWERED',
    orderSeq: null,
    unansweredQuestionSeq: null,
    summaryText: '미답변 기록',
  };
  for (const [kind, payload, changes] of [
    [
      'UTTERANCE',
      utterance,
      [
        { utteranceOrder: 0 },
        { speaker: 'ADMIN' },
        { utteranceText: ' ' },
        { utteranceText: 'x'.repeat(20001) },
        { lastSentenceSeq: 0 },
        { orderSeq: null },
      ],
    ],
    [
      'BUSINESS_RESULT',
      business,
      [
        { action: 'ADDRESS_SEARCH' },
        { unansweredQuestionSeq: 0 },
        { unansweredQuestionSeq: '1' },
        { summaryText: '' },
        { status: 'SUCCEEDED' },
      ],
    ],
  ]) {
    for (const key of Object.keys(payload)) {
      const missing = { ...payload };
      delete missing[key];
      await assert.rejects(() => validate(body(event({ kind, payload: missing }))), {
        status: 400,
      });
    }
    for (const change of changes)
      await assert.rejects(
        () => validate(body(event({ kind, payload: { ...payload, ...change } }))),
        { status: 400 },
      );
  }
});
