require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Reflector } = require('@nestjs/core');
const { CreateCallAnalysisDto } = require('../dist/call-insights/dto/create-call-analysis.dto');
const { CallInsightsGuard } = require('../dist/call-insights/call-insights.guard');
const { createValidationPipe } = require('../dist/common/http/validation.pipe');
const { validateEnvironment } = require('../dist/config/environment');
const pipe = createValidationPipe();

test('analysis token is optional and configuration errors disclose only its field name', () => {
  const environment = {
    NODE_ENV: 'test',
    DB_HOST: 'db',
    DB_USER: 'test_user',
    DB_PASSWORD: 'test-only-password',
    DB_NAME: 'dva_webhook_test',
    AI_AGENT_URL: 'http://ai.invalid:8000',
  };
  const token = 'analysis-test-only-token-with-at-least-32-characters';
  assert.equal(validateEnvironment(environment).AI_INSIGHTS_TOKEN, undefined);
  assert.equal(
    validateEnvironment({ ...environment, AI_INSIGHTS_TOKEN: '' }).AI_INSIGHTS_TOKEN,
    undefined,
  );
  assert.equal(
    validateEnvironment({ ...environment, AI_INSIGHTS_TOKEN: token }).AI_INSIGHTS_TOKEN,
    token,
  );
  for (const value of ['short', token + ' ', token + '\n', '한'.repeat(32), 123, null])
    assert.throws(() => validateEnvironment({ ...environment, AI_INSIGHTS_TOKEN: value }), {
      message: 'Invalid environment variables: AI_INSIGHTS_TOKEN',
    });
});
const complaint = () => ({
  type: 'REPEATED_QUESTION',
  evidenceText: ' 같은 질문을 반복해 고객이 불편함을 표현함\n',
  offsetSeconds: 31,
  utteranceOrders: [3, 4, 5, 6],
});
const input = () => ({
  providerCallId: 'rtc_test_call_analysis',
  startedAt: '2026-10-30T10:00:00+09:00',
  endedAt: '2026-10-30T10:03:40+09:00',
  aiPersonaVersionSeq: null,
  repeatQuestionCount: 2,
  hasComplaint: true,
  complaints: [complaint()],
});
const validate = (body) => pipe.transform(body, { type: 'body', metatype: CreateCallAnalysisDto });

const summary = () => ({
  isNewCustomer: true,
  registeredParcelCount: 3,
  faqAnswerCount: 2,
  orderLookupCount: 1,
  cancelledParcelCount: 1,
  hasHandoffRequest: true,
  hasCallbackRequest: true,
});

test('call summary accepts mixed outcomes, measured zero, false and unknown without coercion', async () => {
  for (const values of [
    summary(),
    {
      ...summary(),
      isNewCustomer: false,
      hasHandoffRequest: false,
      hasCallbackRequest: false,
      registeredParcelCount: 0,
    },
    Object.fromEntries(Object.keys(summary()).map((key) => [key, null])),
    { ...summary(), faqAnswerCount: 2147483647 },
  ]) {
    const body = { ...input(), ...values };
    assert.deepEqual(JSON.parse(JSON.stringify(await validate(body))), body);
  }
});

test('call summary rejects invalid counts, non-boolean flags and obsolete field names', async () => {
  for (const key of [
    'registeredParcelCount',
    'faqAnswerCount',
    'orderLookupCount',
    'cancelledParcelCount',
  ])
    for (const value of [-1, 1.5, '1', true, 2147483648, {}, []])
      await assert.rejects(() => validate({ ...input(), [key]: value }), { status: 400 });
  for (const key of ['isNewCustomer', 'hasHandoffRequest', 'hasCallbackRequest'])
    for (const value of ['true', 'false', 'T', 'F', 0, 1, {}, []])
      await assert.rejects(() => validate({ ...input(), [key]: value }), { status: 400 });
  for (const change of [{ customerType: 'NEW' }, { shipmentLookupCount: 1 }])
    await assert.rejects(() => validate({ ...input(), ...change }), { status: 400 });
});

test('analysis accepts explicit unknown values and preserves complaint evidence without coercion', async () => {
  const body = input();
  assert.deepEqual(JSON.parse(JSON.stringify(await validate(body))), body);
  const unknown = {
    ...body,
    aiPersonaVersionSeq: null,
    repeatQuestionCount: null,
    hasComplaint: null,
    complaints: [],
  };
  assert.deepEqual(JSON.parse(JSON.stringify(await validate(unknown))), unknown);
  const unlinked = { ...complaint(), offsetSeconds: null, utteranceOrders: [] };
  assert.deepEqual(
    JSON.parse(JSON.stringify((await validate({ ...body, complaints: [unlinked] })).complaints[0])),
    unlinked,
  );
});

test('analysis requires core fields and rejects string numbers, removed result and hidden latency fields', async () => {
  for (const key of Object.keys(input())) {
    const body = input();
    delete body[key];
    await assert.rejects(() => validate(body), { status: 400 });
  }
  for (const change of [
    { providerCallId: '' },
    { providerCallId: 'with space' },
    { providerCallId: 'x\u0000y' },
    { providerCallId: 'x'.repeat(201) },
    { startedAt: '2026-02-30T10:00:00+09:00' },
    { startedAt: '2026-10-30T10:00:00' },
    { endedAt: '2026-10-30' },
    { aiPersonaVersionSeq: 0 },
    { aiPersonaVersionSeq: '7' },
    { aiPersonaVersionSeq: 2147483648 },
    { result: 'REGISTERED' },
    { result: null },
    { repeatQuestionCount: -1 },
    { repeatQuestionCount: '2' },
    { repeatQuestionCount: 1.5 },
    { hasComplaint: 'true' },
    { responseLatencyTotalMs: 8400 },
    { responseLatencySampleCount: 6 },
    { complaints: null },
    { complaints: {} },
    { complaints: [null] },
    { complaints: [[complaint()]] },
    { complaints: Array.from({ length: 21 }, complaint) },
  ])
    await assert.rejects(() => validate({ ...input(), ...change }), { status: 400 });
});

test('complaint validation bounds evidence and requires unique integer references in this call', async () => {
  for (const key of Object.keys(complaint())) {
    const value = complaint();
    delete value[key];
    await assert.rejects(() => validate({ ...input(), complaints: [value] }), { status: 400 });
  }
  for (const change of [
    { type: 'OTHER' },
    { evidenceText: ' \n ' },
    { evidenceText: 'x'.repeat(1001) },
    { evidenceText: 'evidence\u0000text' },
    { offsetSeconds: -1 },
    { offsetSeconds: '31' },
    { offsetSeconds: Number.MAX_SAFE_INTEGER + 1 },
    { offsetSeconds: 31.5 },
    { offsetMs: 31000 },
    { utteranceOrders: null },
    { utteranceOrders: [1, 1] },
    { utteranceOrders: [0] },
    { utteranceOrders: ['1'] },
    { utteranceOrders: [[1]] },
    { utteranceOrders: [2147483648] },
    { arbitraryToolArguments: { password: 'not-accepted' } },
  ])
    await assert.rejects(
      () => validate({ ...input(), complaints: [{ ...complaint(), ...change }] }),
      { status: 400 },
    );
});

function guarded(token, authorization, rawCount = 1) {
  const request = {
    auditActorType: 'AI',
    requestId: '00000000-0000-4000-8000-000000000001',
    params: { id: '120' },
    rawHeaders: Array.from({ length: rawCount }, () => ['Authorization', authorization]).flat(),
    get: () => authorization,
  };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => function handler() {},
  };
  const guard = new CallInsightsGuard({ get: () => token }, new Reflector(), {
    recordFailure: async () => assert.fail('Unannotated route must not invent an audit operation'),
  });
  return { guard, context, request };
}

test('analysis guard rejects absent, wrong and duplicate service credentials before identifying an AI', async () => {
  const token = 'analysis-test-service-token-with-at-least-32-characters';
  for (const [authorization, count] of [
    [undefined, 0],
    ['', 0],
    ['Bearer wrong-token', 1],
    ['Basic ' + token, 1],
    ['Bearer ' + token, 2],
  ]) {
    const value = guarded(token, authorization, count);
    await assert.rejects(() => value.guard.canActivate(value.context), { status: 401 });
    assert.equal(value.request.auditActorType, undefined);
  }
  const disabled = guarded(undefined, 'Bearer ' + token);
  await assert.rejects(() => disabled.guard.canActivate(disabled.context), { status: 503 });
  const valid = guarded(token, 'Bearer ' + token);
  assert.equal(await valid.guard.canActivate(valid.context), true);
  assert.equal(valid.request.auditActorType, 'AI');
});
