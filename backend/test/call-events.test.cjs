require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { normalizeCallEvents } = require('../dist/call-insights/call-event-input');
const { CreateCallEventsDto } = require('../dist/call-insights/dto/create-call-events.dto');
const { createValidationPipe } = require('../dist/common/http/validation.pipe');
const pipe = createValidationPipe();
const event = (changes = {}) => ({
  eventId: randomUUID(),
  eventOrder: 1,
  kind: 'AI_ACTION',
  occurredAt: '2026-10-31T10:00:31+09:00',
  offsetSeconds: 31,
  payload: { action: 'PIN_SEARCH', summaryText: '이름 검색 결과 1건\n', orderSeq: null },
  ...changes,
});
const body = (value = event()) => ({ providerCallId: 'rtc_event_test', events: [value] });
const validate = (value) => pipe.transform(value, { type: 'body', metatype: CreateCallEventsDto });

test('PIN and previous-order searches accept names and order context without address fields', async () => {
  for (const action of ['PIN_SEARCH', 'PREVIOUS_ORDER_SEARCH']) {
    const input = body(
      event({ payload: { action, summaryText: '지난주 김담당 주문 2건', orderSeq: null } }),
    );
    assert.deepEqual(JSON.parse(JSON.stringify(await validate(input))), input);
  }
});

test('FAQ answers require FAQ and question/answer utterance references without adding a status', async () => {
  const payload = {
    action: 'FAQ_ANSWERED',
    orderSeq: null,
    unansweredQuestionSeq: null,
    summaryText: 'FAQ로 안내',
    faqEntrySeq: 1,
    questionUtteranceOrder: 2,
    answerUtteranceOrder: 3,
  };
  const input = body(event({ kind: 'BUSINESS_RESULT', payload }));
  assert.deepEqual(JSON.parse(JSON.stringify(await validate(input))), input);
  for (const key of ['faqEntrySeq', 'questionUtteranceOrder', 'answerUtteranceOrder']) {
    for (const value of [undefined, null, 0, '1', 2147483648])
      await assert.rejects(
        () =>
          validate(body(event({ kind: 'BUSINESS_RESULT', payload: { ...payload, [key]: value } }))),
        { status: 400 },
      );
  }
  await assert.rejects(
    () =>
      validate(
        body(event({ kind: 'BUSINESS_RESULT', payload: { ...payload, status: 'SUCCEEDED' } })),
      ),
    { status: 400 },
  );
});

test('FAQ arrays validate unique positive IDs and normalize order while preserving the legacy single-ID shape', async () => {
  const payload = {
    action: 'FAQ_ANSWERED',
    orderSeq: null,
    unansweredQuestionSeq: null,
    summaryText: '여러 FAQ로 안내',
    faqEntrySeqs: [12, 2],
    questionUtteranceOrder: 1,
    answerUtteranceOrder: 2,
  };
  const input = body(event({ kind: 'BUSINESS_RESULT', payload }));
  const validated = await validate(input);
  assert.deepEqual(normalizeCallEvents(validated.events)[0].payload.faqEntrySeqs, [2, 12]);
  assert.deepEqual(payload.faqEntrySeqs, [12, 2]);
  const reordered = structuredClone(input);
  reordered.events[0].payload.faqEntrySeqs.reverse();
  assert.deepEqual(
    normalizeCallEvents(validated.events),
    normalizeCallEvents((await validate(reordered)).events),
  );
  const max = { ...payload, faqEntrySeqs: Array.from({ length: 100 }, (_, i) => i + 1) };
  await validate(body(event({ kind: 'BUSINESS_RESULT', payload: max })));
  for (const faqEntrySeqs of [
    undefined,
    null,
    [],
    [1, 1],
    [0],
    [-1],
    [1.5],
    ['1'],
    [null],
    [2147483648],
    Array.from({ length: 101 }, (_, i) => i + 1),
  ])
    await assert.rejects(
      () =>
        validate(body(event({ kind: 'BUSINESS_RESULT', payload: { ...payload, faqEntrySeqs } }))),
      { status: 400 },
    );
  assert.throws(
    () =>
      normalizeCallEvents([
        event({ kind: 'BUSINESS_RESULT', payload: { ...payload, faqEntrySeq: 12 } }),
      ]),
    { status: 400 },
  );
  assert.throws(
    () =>
      normalizeCallEvents([
        event({
          kind: 'BUSINESS_RESULT',
          payload: {
            action: 'INQUIRY',
            orderSeq: null,
            unansweredQuestionSeq: null,
            summaryText: '문의',
            faqEntrySeqs: [12],
          },
        }),
      ]),
    { status: 400 },
  );
  const legacy = { ...payload, faqEntrySeq: 12 };
  delete legacy.faqEntrySeqs;
  const normalized = normalizeCallEvents(
    (await validate(body(event({ kind: 'BUSINESS_RESULT', payload: legacy })))).events,
  )[0].payload;
  assert.deepEqual(normalized, legacy);
  assert.equal(Object.hasOwn(normalized, 'faqEntrySeqs'), false);
});

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

// Captured from CallEventsService before extracting normalization.
const legacyNormalizationInput = {
  providerCallId: 'rtc_normalization_legacy',
  events: [
    {
      eventId: 'CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC',
      eventOrder: 3,
      kind: 'BUSINESS_RESULT',
      occurredAt: '2026-10-31T10:00:31+09:00',
      offsetSeconds: 31,
      payload: {
        summaryText: 'FAQ 안내\n',
        answerUtteranceOrder: 2,
        questionUtteranceOrder: 1,
        faqEntrySeq: 12,
        unansweredQuestionSeq: null,
        orderSeq: null,
        action: 'FAQ_ANSWERED',
      },
    },
    {
      eventId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      eventOrder: 1,
      kind: 'UTTERANCE',
      occurredAt: '2026-10-31T10:00:00+09:00',
      offsetSeconds: 0,
      payload: {
        lastSentenceSeq: 7,
        utteranceText: ' 원문\n보존 ',
        speaker: 'CUSTOMER',
        utteranceOrder: 1,
      },
    },
    {
      eventId: 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB',
      eventOrder: 2,
      kind: 'AI_ACTION',
      occurredAt: '2026-10-31T01:00:20.000Z',
      offsetSeconds: 20,
      payload: {
        orderSeq: null,
        summaryText: '이름 검색 1건',
        action: 'PIN_SEARCH',
      },
    },
    {
      eventId: 'DDDDDDDD-DDDD-4DDD-8DDD-DDDDDDDDDDDD',
      eventOrder: 4,
      kind: 'BUSINESS_RESULT',
      occurredAt: '2026-10-31T10:00:40+09:00',
      offsetSeconds: null,
      payload: {
        unansweredQuestionSeq: null,
        summaryText: '문의 안내 완료',
        orderSeq: null,
        action: 'INQUIRY',
      },
    },
  ],
};
const legacyEventHashes = {
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa':
    '498884a62530f4a92dc88909d9e168dde787e15b477dd832f24a869484f38dca',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb':
    '1cbe61c9020ae05210540a4f35924af5ab1c350a5617c430cc348c572151e4aa',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc':
    'bdc6d1521c20ee8e2b35a7ce2749e87d226f828a6a8d6df2d0f5184e6a94119d',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd':
    'd3e232b1af94b6dd252ecca9cc3cd3441db6e907f5eeacdf7b3f0102238e269c',
};

test('event normalization preserves legacy hashes, received order, original text and unknown or zero offsets', () => {
  const original = structuredClone(legacyNormalizationInput);
  const normalized = normalizeCallEvents(legacyNormalizationInput.events);
  assert.deepEqual(legacyNormalizationInput, original);
  assert.deepEqual(
    normalized.map((value) => value.eventId),
    original.events.map((value) => value.eventId.toLowerCase()),
  );
  assert.equal(normalized[1].occurredAt, '2026-10-31T01:00:00.000Z');
  assert.equal(normalized[1].payload.utteranceText, ' 원문\n보존 ');
  assert.equal(normalized[1].offsetSeconds, 0);
  assert.equal(normalized[3].offsetSeconds, null);
  for (const value of normalized) {
    const hash = createHash('sha256')
      .update(
        JSON.stringify({
          callSessionSeq: 42,
          providerCallId: legacyNormalizationInput.providerCallId,
          ...value,
        }),
      )
      .digest('hex');
    assert.equal(hash, legacyEventHashes[value.eventId]);
  }
});

test('event normalization rejects invalid or year-zero timestamps with the existing error', () => {
  for (const occurredAt of ['invalid', '0000-01-01T00:00:00Z'])
    assert.throws(() => normalizeCallEvents([event({ occurredAt })]), {
      status: 422,
      message: '이벤트 발생 시각을 확인해 주세요.',
    });
});

test('event normalization detects duplicate IDs after case folding and duplicate event orders', () => {
  const first = event({ eventId: randomUUID().toUpperCase() });
  for (const second of [
    { ...first, eventId: first.eventId.toLowerCase(), eventOrder: 2 },
    { ...first, eventId: randomUUID() },
  ])
    assert.throws(() => normalizeCallEvents([first, second]), {
      status: 400,
      message: '요청 묶음 안의 이벤트 ID·순번은 중복될 수 없습니다.',
    });
});

test('event normalization preserves FAQ-only reference rules and validation error statuses', () => {
  const payload = {
    action: 'FAQ_ANSWERED',
    orderSeq: null,
    unansweredQuestionSeq: null,
    summaryText: '안내',
    faqEntrySeq: 12,
    questionUtteranceOrder: 1,
    answerUtteranceOrder: 2,
  };
  for (const field of ['orderSeq', 'unansweredQuestionSeq'])
    assert.throws(
      () =>
        normalizeCallEvents([
          event({ kind: 'BUSINESS_RESULT', payload: { ...payload, [field]: 7 } }),
        ]),
      { status: 422 },
    );
  for (const field of ['faqEntrySeq', 'questionUtteranceOrder', 'answerUtteranceOrder'])
    assert.throws(
      () =>
        normalizeCallEvents([
          event({
            kind: 'BUSINESS_RESULT',
            payload: {
              action: 'INQUIRY',
              orderSeq: null,
              unansweredQuestionSeq: null,
              summaryText: '안내',
              [field]: payload[field],
            },
          }),
        ]),
      { status: 400 },
    );
});
