require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createValidationPipe } = require('../dist/common/http/validation.pipe');
const {
  CreateStageMetricsDto,
  CreateResponseWaitMetricsDto,
} = require('../dist/call-insights/dto/create-call-dashboard-metrics.dto');
const { CreateCallAnalysisDto } = require('../dist/call-insights/dto/create-call-analysis.dto');
const {
  DROPOFF_STAGES,
  LATENCY_PROCESS_TYPES,
} = require('../dist/call-insights/call-dashboard-metrics.types');
const pipe = createValidationPipe();
const validate = (type, body) => pipe.transform(body, { type: 'body', metatype: type });
const identity = { providerCallId: 'rtc_dashboard_input' };
const stat = () => ({ processType: 'CUSTOMER_LOOKUP', totalLatencyMs: 4000, measurementCount: 2 });
const wait = () => ({ ...identity, totalWaitMs: 12000, latencyStats: [stat()] });

test('dashboard stage accepts all eight final stages and NONE, and requires one identity/stage', async () => {
  for (const dropoffStage of DROPOFF_STAGES) {
    const input = { ...identity, dropoffStage };
    assert.deepEqual(
      JSON.parse(JSON.stringify(await validate(CreateStageMetricsDto, input))),
      input,
    );
  }
  for (const input of [
    identity,
    { dropoffStage: 'NONE' },
    { ...identity, dropoffStage: null },
    { ...identity, dropoffStage: 'none' },
    { ...identity, dropoffStage: ['NONE'] },
    { ...identity, dropoffStage: 'NONE', enteredStages: [] },
    { ...identity, dropoffStage: 'NONE', customerAbandoned: false },
  ])
    await assert.rejects(() => validate(CreateStageMetricsDto, input), { status: 400 });
});

test('dashboard metrics reject malformed provider identity without implicit conversion', async () => {
  for (const providerCallId of ['', 'with space', 'x\u0000y', 'x'.repeat(201), 1, null, {}, []])
    for (const type of [CreateStageMetricsDto, CreateResponseWaitMetricsDto])
      await assert.rejects(
        () =>
          validate(type, {
            ...(type === CreateStageMetricsDto ? { ...identity, dropoffStage: 'NONE' } : wait()),
            providerCallId,
          }),
        { status: 400 },
      );
});

test('response waits accept measured zero and bounded summaries for all seven process types', async () => {
  for (const input of [
    { ...identity, totalWaitMs: 0, latencyStats: [] },
    {
      ...wait(),
      totalWaitMs: Number.MAX_SAFE_INTEGER,
      latencyStats: LATENCY_PROCESS_TYPES.map((processType) => ({
        processType,
        totalLatencyMs: Number.MAX_SAFE_INTEGER,
        measurementCount: 2147483647,
      })),
    },
  ])
    assert.deepEqual(
      JSON.parse(JSON.stringify(await validate(CreateResponseWaitMetricsDto, input))),
      input,
    );
});

test('response waits require every field and reject extra, P95, raw samples and invalid numeric types', async () => {
  for (const key of Object.keys(wait())) {
    const input = wait();
    delete input[key];
    await assert.rejects(() => validate(CreateResponseWaitMetricsDto, input), { status: 400 });
  }
  for (const change of [
    { totalWaitMs: -1 },
    { totalWaitMs: '1' },
    { totalWaitMs: true },
    { totalWaitMs: 1.5 },
    { totalWaitMs: Number.MAX_SAFE_INTEGER + 1 },
    { totalWaitMs: null },
    { latencyStats: null },
    { latencyStats: {} },
    { latencyStats: [null] },
    { latencyStats: [[stat()]] },
    { latencyStats: Array.from({ length: 8 }, stat) },
    { p95: 1 },
    { samples: [] },
  ])
    await assert.rejects(() => validate(CreateResponseWaitMetricsDto, { ...wait(), ...change }), {
      status: 400,
    });
  for (const key of Object.keys(stat())) {
    const value = stat();
    delete value[key];
    await assert.rejects(
      () => validate(CreateResponseWaitMetricsDto, { ...wait(), latencyStats: [value] }),
      { status: 400 },
    );
  }
  for (const change of [
    { processType: 'OTHER' },
    { processType: null },
    { totalLatencyMs: -1 },
    { totalLatencyMs: '1' },
    { totalLatencyMs: 1.5 },
    { totalLatencyMs: Number.MAX_SAFE_INTEGER + 1 },
    { measurementCount: 0 },
    { measurementCount: '1' },
    { measurementCount: 1.5 },
    { measurementCount: 2147483648 },
    { extra: 1 },
  ])
    await assert.rejects(
      () =>
        validate(CreateResponseWaitMetricsDto, {
          ...wait(),
          latencyStats: [{ ...stat(), ...change }],
        }),
      { status: 400 },
    );
});

test('existing final analysis accepts screen complaint types alongside every legacy type', async () => {
  const { CALL_COMPLAINT_TYPES } = require('../dist/call-insights/call-insights.types');
  assert.equal(CALL_COMPLAINT_TYPES.length, 10);
  const body = {
    ...identity,
    startedAt: '2026-11-04T10:00:00+09:00',
    endedAt: '2026-11-04T10:03:00+09:00',
    aiPersonaVersionSeq: null,
    repeatQuestionCount: null,
    hasComplaint: true,
    complaints: CALL_COMPLAINT_TYPES.map((type) => ({
      type,
      evidenceText: '고객 불편 근거',
      offsetSeconds: 1,
      utteranceOrders: [],
    })),
  };
  assert.deepEqual(JSON.parse(JSON.stringify(await validate(CreateCallAnalysisDto, body))), body);
  for (const change of [{ reason: 'KB_NO_ANSWER' }, { totalWaitMs: 1 }, { dropoffStage: 'NONE' }])
    await assert.rejects(() => validate(CreateCallAnalysisDto, { ...body, ...change }), {
      status: 400,
    });
});

test('identical final wait replay remains successful after late PBX timing correction', async () => {
  const { createHash } = require('node:crypto');
  const {
    CallDashboardMetricsService,
  } = require('../dist/call-insights/call-dashboard-metrics.service');
  const hash = createHash('sha256').update(JSON.stringify(wait())).digest('hex');
  const service = new CallDashboardMetricsService(
    { transaction: (work) => work({}) },
    {
      lockCall: async () => ({
        providerCallId: identity.providerCallId,
        hasAnalysis: true,
        durationMs: 5000,
      }),
      insert: async () => false,
      findHash: async () => hash,
    },
    { recordSuccess: async () => assert.fail('A replay must not create another audit') },
  );
  await service.saveResponseWait(1, wait(), '00000000-0000-4000-8000-000000000001');
});

test('prepared statement identity depends on SQL, while request values remain bound', () => {
  const { preparedQuery } = require('../dist/database/prepared-query');
  const values = ["untrusted' value", 17];
  const first = preparedQuery('SELECT $1::text,$2::int', values);
  const second = preparedQuery('SELECT $1::text,$2::int', ['different', 23]);
  assert.equal(first.name, second.name);
  assert.notEqual(first.name, preparedQuery('SELECT $1::text').name);
  assert.ok(Buffer.byteLength(first.name) <= 63);
  assert.equal(first.text, 'SELECT $1::text,$2::int');
  assert.equal(first.values, values);
  assert.ok(!first.name.includes('untrusted'));
});
