require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  CreateUnansweredQuestionDto,
} = require('../dist/unanswered-questions/dto/create-unanswered-question.dto');
const { createValidationPipe } = require('../dist/common/http/validation.pipe');
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
