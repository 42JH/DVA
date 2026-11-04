require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  CreateUnansweredQuestionDto,
} = require('../dist/unanswered-questions/dto/create-unanswered-question.dto');
const { createValidationPipe } = require('../dist/common/http/validation.pipe');
const {
  UnansweredQuestionQueryDto,
} = require('../dist/unanswered-questions/dto/unanswered-question-query.dto');
const pipe = createValidationPipe();
const input = (changes = {}) => ({
  eventId: randomUUID(),
  callSessionSeq: 120,
  providerCallId: 'rtc_question_test',
  questionText: ' 질문 원문\n주말에도 수거하나요? ',
  occurredAt: '2026-10-31T10:01:20+09:00',
  offsetSeconds: 80,
  ...changes,
});
const validate = (value) =>
  pipe.transform(value, { type: 'body', metatype: CreateUnansweredQuestionDto });

test('question input preserves original text and accepts explicit unknown, zero and safe integer seconds', async () => {
  for (const change of [
    {},
    { offsetSeconds: null },
    { offsetSeconds: 0 },
    { offsetSeconds: Number.MAX_SAFE_INTEGER },
    { questionText: '😊'.repeat(1000) },
    { providerCallId: 'x'.repeat(200) },
  ]) {
    const value = input(change);
    assert.deepEqual(JSON.parse(JSON.stringify(await validate(value))), value);
  }
});

test('question reasons accept the two codes or unclassified input without accepting workflow or query-only values', async () => {
  for (const reason of ['KB_NO_ANSWER', 'KB_UNAVAILABLE', null]) {
    const value = input({ reason });
    assert.deepEqual(JSON.parse(JSON.stringify(await validate(value))), value);
  }
  for (const reason of [
    'UNCLASSIFIED',
    'OPEN',
    'kb_no_answer',
    '',
    1,
    true,
    {},
    [],
    ['KB_NO_ANSWER'],
  ])
    await assert.rejects(() => validate(input({ reason })), { status: 400 });
});

test('questions require all six fields and reject invalid identifiers, text, time and numeric coercion', async () => {
  for (const key of Object.keys(input())) {
    const value = input();
    delete value[key];
    await assert.rejects(() => validate(value), { status: 400 });
  }
  for (const change of [
    { eventId: 'bad' },
    { eventId: null },
    { callSessionSeq: '120' },
    { callSessionSeq: 0 },
    { callSessionSeq: 1.5 },
    { callSessionSeq: 2147483648 },
    { providerCallId: '' },
    { providerCallId: 'with space' },
    { providerCallId: 'x\u0000' },
    { providerCallId: 'x'.repeat(201) },
    { questionText: null },
    { questionText: ' \n\t' },
    { questionText: 'x\u0000' },
    { questionText: 'x'.repeat(1001) },
    { occurredAt: '2026-02-30T10:00:00Z' },
    { occurredAt: '2026-10-31T10:00:00' },
    { offsetSeconds: -1 },
    { offsetSeconds: '80' },
    { offsetSeconds: 80.5 },
    { offsetSeconds: Number.MAX_SAFE_INTEGER + 1 },
  ])
    await assert.rejects(() => validate(input(change)), { status: 400 });
});

test('question collection rejects event batches, workflow state, milliseconds, latency and unrelated identity fields', async () => {
  for (const value of [null, {}, [], [input()], 'not an object'])
    await assert.rejects(() => validate(value), { status: 400 });
  for (const change of [
    { status: 'OPEN' },
    { offsetMs: 80000 },
    { responseLatencyMs: 12 },
    { customerSeq: 1 },
    { callerPhoneNumber: '01012345678' },
    { aiPersonaVersionSeq: 1 },
    { eventOrder: 1 },
    { questions: [input()] },
  ])
    await assert.rejects(() => validate(input(change)), { status: 400 });
});

const validateQuery = (value) =>
  pipe.transform(value, { type: 'query', metatype: UnansweredQuestionQueryDto });

test('question queries default to OPEN and parse bounded integer parameters without accepting repeated values', async () => {
  assert.deepEqual(JSON.parse(JSON.stringify(await validateQuery({}))), {
    limit: 20,
    offset: 0,
    status: 'OPEN',
  });
  const value = await validateQuery({
    unansweredQuestionSeq: '1',
    callSessionSeq: '2147483647',
    aiPersonaVersionSeq: '7',
    status: 'REGISTERED',
    limit: '100',
    offset: String(Number.MAX_SAFE_INTEGER),
  });
  assert.equal(value.unansweredQuestionSeq, 1);
  assert.equal(value.callSessionSeq, 2147483647);
  assert.equal(value.aiPersonaVersionSeq, 7);
  assert.equal(value.offset, Number.MAX_SAFE_INTEGER);
  for (const field of ['unansweredQuestionSeq', 'callSessionSeq', 'aiPersonaVersionSeq'])
    for (const invalid of ['0', '-1', '1.5', '1e2', '2147483648', '', ['1', '2']])
      await assert.rejects(() => validateQuery({ [field]: invalid }), { status: 400 });
});

test('question search normalizes Korean and trims input while preserving literal wildcard characters', async () => {
  for (const [q, expected] of [
    ['  주말%_  ', '주말%_'],
    ['주말'.normalize('NFD'), '주말'],
    [' \n\t', ''],
    ['😊'.repeat(200), '😊'.repeat(200)],
  ])
    assert.equal((await validateQuery({ q })).q, expected);
  for (const q of ['x'.repeat(201), 'x\0', ['one', 'two']])
    await assert.rejects(() => validateQuery({ q }), { status: 400 });
});

test('question filters distinguish reason, unclassified and all non-deleted workflow states', async () => {
  for (const reason of ['KB_NO_ANSWER', 'KB_UNAVAILABLE', 'UNCLASSIFIED']) {
    const value = await validateQuery({ reason, status: 'ALL' });
    assert.equal(value.reason, reason);
    assert.equal(value.status, 'ALL');
  }
  for (const reason of [
    'null',
    'ALL',
    'OPEN',
    'kb_no_answer',
    '',
    1,
    ['KB_NO_ANSWER', 'KB_UNAVAILABLE'],
  ])
    await assert.rejects(() => validateQuery({ reason }), { status: 400 });
});

test('question queries reject deleted state, unknown fields, malformed dates and pagination', async () => {
  for (const value of [
    { status: 'DELETED' },
    { status: 'UNKNOWN' },
    { status: ['OPEN', 'REGISTERED'] },
    { customerSeq: '1' },
    { offsetMs: '1' },
    { sort: 'DESC' },
    { from: '2026-02-30T00:00:00Z' },
    { to: '2026-10-31T00:00:00' },
    { from: ['2026-10-31T00:00:00Z', '2026-11-01T00:00:00Z'] },
    { limit: '0' },
    { limit: '101' },
    { limit: '2.5' },
    { limit: ['1', '2'] },
    { offset: '-1' },
    { offset: '1e2' },
    { offset: String(Number.MAX_SAFE_INTEGER + 1) },
  ])
    await assert.rejects(() => validateQuery(value), { status: 400 });
});
