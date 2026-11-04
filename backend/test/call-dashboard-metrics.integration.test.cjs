require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { ConfigService } = require('@nestjs/config');
const { AuditService } = require('../dist/audit/audit.service');
const token = randomBytes(32).toString('hex');
process.env.AI_INSIGHTS_TOKEN = token;
const { applicationFixture } = require('./helpers/application.cjs');
const f = applicationFixture();
const post = (call, section, body, headers = {}, base = f.base) =>
  fetch(`${base}/api/ai/calls/${call.id}/${section}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
const stage = (call, dropoffStage = 'NONE') => ({
  providerCallId: call.providerCallId,
  dropoffStage,
});
const wait = (call) => ({
  providerCallId: call.providerCallId,
  totalWaitMs: 12000,
  latencyStats: [
    { processType: 'CUSTOMER_LOOKUP', totalLatencyMs: 4000, measurementCount: 2 },
    { processType: 'ORDER_SAVE', totalLatencyMs: 8000, measurementCount: 2 },
  ],
});
async function ok(response) {
  assert.equal(response.status, 204, await response.clone().text());
  assert.equal(await response.text(), '');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(response.headers.get('x-request-id'));
}
async function createCall(analysed = true) {
  const providerCallId = 'rtc_dashboard_private_' + randomUUID();
  const id = (
    await f.pool.query(
      `INSERT INTO call_sessions(provider_call_id,incoming_at,started_at,ended_at)
    VALUES($1,statement_timestamp()-interval '3 minutes',statement_timestamp()-interval '3 minutes',statement_timestamp()) RETURNING call_session_seq`,
      [providerCallId],
    )
  ).rows[0].call_session_seq;
  const call = { id, providerCallId };
  if (analysed) {
    const times = (
      await f.pool.query(
        'SELECT started_at,ended_at FROM call_sessions WHERE call_session_seq=$1',
        [id],
      )
    ).rows[0];
    await ok(
      await post(call, 'analysis', {
        providerCallId,
        startedAt: times.started_at.toISOString(),
        endedAt: times.ended_at.toISOString(),
        aiPersonaVersionSeq: null,
        isNewCustomer: true,
        registeredParcelCount: 2,
        repeatQuestionCount: null,
        hasComplaint: false,
        complaints: [],
      }),
    );
  }
  return call;
}
const stored = async (call) =>
  (await f.pool.query('SELECT * FROM call_dashboard_metrics WHERE call_session_seq=$1', [call.id]))
    .rows[0];

test('both metric endpoints enforce the dedicated service token, including administrator requests', async () => {
  const c = await createCall();
  for (const [section, body] of [
    ['stage-metrics', stage(c)],
    ['response-wait-metrics', wait(c)],
  ]) {
    for (const headers of [
      { Authorization: '' },
      { Authorization: 'Bearer wrong' },
      { Authorization: '', Cookie: f.cookies[0], Origin: f.origin },
      { Authorization: 'Bearer ' + token + ', Bearer ' + token },
    ])
      await f.error(await post(c, section, body, headers), 401, 'UNAUTHORIZED');
    const config = f.app.get(ConfigService);
    config.set('AI_INSIGHTS_TOKEN', '');
    try {
      await f.error(await post(c, section, body), 503, 'DEPENDENCY_UNAVAILABLE');
    } finally {
      config.set('AI_INSIGHTS_TOKEN', token);
    }
  }
  assert.equal(await stored(c), undefined);
});

test('metrics require valid call ownership and an existing final analysis', async () => {
  const c = await createCall(false);
  for (const [section, body] of [
    ['stage-metrics', stage(c)],
    ['response-wait-metrics', wait(c)],
  ]) {
    await f.error(await post(c, section, body), 409, 'INVALID_STATE');
    await f.error(
      await post(c, section, { ...body, providerCallId: 'another-call' }),
      403,
      'FORBIDDEN',
    );
    await f.error(await post({ ...c, id: 2147483647 }, section, body), 404, 'NOT_FOUND');
    for (const id of [0, -1, 'abc', 2147483648])
      await f.error(await post({ ...c, id }, section, body), 400, 'INVALID_REQUEST');
  }
  assert.equal(await stored(c), undefined);
});

test('concurrent cross-instance writes preserve independent sections and one success audit each', async () => {
  const c = await createCall();
  const before = (
    await f.pool.query(
      'SELECT to_jsonb(c) AS call,to_jsonb(a) AS analysis FROM call_sessions c JOIN call_analyses a USING(call_session_seq) WHERE c.call_session_seq=$1',
      [c.id],
    )
  ).rows;
  const app2 = await f.start();
  const base2 = await app2.getUrl();
  await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      Promise.all([
        post(c, 'stage-metrics', stage(c, 'RECIPIENT_INFO'), {}, i % 2 ? base2 : f.base).then(ok),
        post(c, 'response-wait-metrics', wait(c), {}, i % 2 ? f.base : base2).then(ok),
      ]),
    ),
  );
  const first = await stored(c);
  assert.equal(first.dropoff_stage, 'RECIPIENT_INFO');
  assert.equal(first.total_wait_ms, '12000');
  assert.ok(first.dropoff_received_at);
  assert.ok(first.response_wait_received_at);
  assert.match(first.dropoff_payload_hash, /^[a-f0-9]{64}$/);
  assert.match(first.response_wait_payload_hash, /^[a-f0-9]{64}$/);
  const equivalent = {
    latencyStats: wait(c)
      .latencyStats.toReversed()
      .map((s) => Object.fromEntries(Object.entries(s).reverse())),
    totalWaitMs: 12000,
    providerCallId: c.providerCallId,
  };
  await ok(await post(c, 'response-wait-metrics', equivalent));
  await ok(await post(c, 'stage-metrics', stage(c, 'RECIPIENT_INFO')));
  assert.deepEqual(await stored(c), first);
  assert.deepEqual(
    (
      await f.pool.query(
        'SELECT to_jsonb(c) AS call,to_jsonb(a) AS analysis FROM call_sessions c JOIN call_analyses a USING(call_session_seq) WHERE c.call_session_seq=$1',
        [c.id],
      )
    ).rows,
    before,
  );
  const audits = (
    await f.pool.query(
      "SELECT action,actor_type,metadata FROM audit_logs WHERE target_type='CALL_SESSION' AND target_seq=$1 AND result='SUCCESS' AND action IN ('CALL_DROPOFF_RECORDED','CALL_RESPONSE_WAIT_RECORDED') ORDER BY action",
      [c.id],
    )
  ).rows;
  assert.deepEqual(audits, [
    { action: 'CALL_DROPOFF_RECORDED', actor_type: 'AI', metadata: {} },
    { action: 'CALL_RESPONSE_WAIT_RECORDED', actor_type: 'AI', metadata: {} },
  ]);
});

test('conflicting final snapshots never overwrite the other section or its original timestamp', async () => {
  const c = await createCall();
  await ok(await post(c, 'response-wait-metrics', wait(c)));
  const waitOnly = await stored(c);
  assert.equal(waitOnly.dropoff_stage, null);
  await ok(await post(c, 'stage-metrics', stage(c)));
  const before = await stored(c);
  await f.error(
    await post(c, 'stage-metrics', stage(c, 'ITEM_INFO')),
    409,
    'EVENT_PAYLOAD_CONFLICT',
  );
  await f.error(
    await post(c, 'response-wait-metrics', { ...wait(c), totalWaitMs: 11000 }),
    409,
    'EVENT_PAYLOAD_CONFLICT',
  );
  await f.error(
    await post(c, 'response-wait-metrics', { ...wait(c), latencyStats: [wait(c).latencyStats[0]] }),
    409,
    'EVENT_PAYLOAD_CONFLICT',
  );
  assert.deepEqual(await stored(c), before);
  assert.equal(
    before.response_wait_received_at.getTime(),
    waitOnly.response_wait_received_at.getTime(),
  );
});

test('HTTP validates types, rejects duplicate process types and bounds actual total wait by call duration', async () => {
  const c = await createCall();
  for (const change of [
    { totalWaitMs: '0' },
    { totalWaitMs: -1 },
    { latencyStats: [null] },
    { latencyStats: [[wait(c).latencyStats[0]]] },
    { latencyStats: [wait(c).latencyStats[0], wait(c).latencyStats[0]] },
    { p95: 1 },
    { reason: 'KB_NO_ANSWER' },
  ])
    await f.error(
      await post(c, 'response-wait-metrics', { ...wait(c), ...change }),
      400,
      'INVALID_REQUEST',
    );
  await f.error(
    await post(c, 'response-wait-metrics', { ...wait(c), totalWaitMs: 180001 }),
    422,
    'VALIDATION_FAILED',
  );
  for (const change of [
    { dropoffStage: null },
    { dropoffStage: 'BAD' },
    { enteredStages: [] },
    { customerAbandoned: false },
  ])
    await f.error(
      await post(c, 'stage-metrics', { ...stage(c), ...change }),
      400,
      'INVALID_REQUEST',
    );
  assert.equal(await stored(c), undefined);
  await ok(
    await post(c, 'response-wait-metrics', { ...wait(c), totalWaitMs: 0, latencyStats: [] }),
  );
  assert.equal((await stored(c)).total_wait_ms, '0');
  assert.deepEqual((await stored(c)).latency_stats, []);
});

test('late PBX timing correction preserves exact final replays and still rejects changed snapshots', async () => {
  const c = await createCall();
  await ok(await post(c, 'response-wait-metrics', wait(c)));
  const before = await stored(c);
  await f.pool.query(
    "UPDATE call_sessions SET ended_at=started_at+interval '5 seconds' WHERE call_session_seq=$1",
    [c.id],
  );
  await ok(await post(c, 'response-wait-metrics', wait(c)));
  await f.error(
    await post(c, 'response-wait-metrics', { ...wait(c), totalWaitMs: 13000 }),
    409,
    'EVENT_PAYLOAD_CONFLICT',
  );
  assert.deepEqual(await stored(c), before);
});

test('audit failures roll back the new section and preserve an already stored section', async () => {
  const c = await createCall();
  const audit = f.app.get(AuditService);
  const original = audit.recordSuccess;
  audit.recordSuccess = async () => {
    throw new Error('dashboard audit failure');
  };
  try {
    await f.error(await post(c, 'stage-metrics', stage(c)), 500, 'INTERNAL_ERROR');
  } finally {
    audit.recordSuccess = original;
  }
  assert.equal(await stored(c), undefined);
  await ok(await post(c, 'stage-metrics', stage(c)));
  const first = await stored(c);
  audit.recordSuccess = async () => {
    throw new Error('dashboard audit failure');
  };
  try {
    await f.error(await post(c, 'response-wait-metrics', wait(c)), 500, 'INTERNAL_ERROR');
  } finally {
    audit.recordSuccess = original;
  }
  assert.deepEqual(await stored(c), first);
});

test('soft-deleted and retention-expired calls reject new metric writes and preserve saved data', async () => {
  const deleted = await createCall();
  await ok(await post(deleted, 'stage-metrics', stage(deleted)));
  const first = await stored(deleted);
  await ok(await f.write('DELETE', '/api/calls/' + deleted.id));
  for (const [section, body] of [
    ['stage-metrics', stage(deleted)],
    ['response-wait-metrics', wait(deleted)],
  ])
    await f.error(await post(deleted, section, body), 404, 'NOT_FOUND');
  assert.deepEqual(await stored(deleted), first);
  const expired = await createCall();
  await f.pool.query(
    "UPDATE call_sessions SET incoming_at=statement_timestamp()-interval '5 years 1 day' WHERE call_session_seq=$1",
    [expired.id],
  );
  await f.error(await post(expired, 'stage-metrics', stage(expired)), 404, 'NOT_FOUND');
  await f.error(await post(expired, 'response-wait-metrics', wait(expired)), 404, 'NOT_FOUND');
});

test('new complaint codes round-trip through existing final analysis and call detail without new fields', async () => {
  const c = await createCall(false);
  const times = (
    await f.pool.query('SELECT started_at,ended_at FROM call_sessions WHERE call_session_seq=$1', [
      c.id,
    ])
  ).rows[0];
  const codes = [
    'INFORMATION_RECOGNITION_ERROR',
    'INTENT_RECOGNITION_ERROR',
    'UNSUPPORTED_ANSWER',
    'SLOW_RESPONSE',
    'INTERRUPTION',
    'DISSATISFACTION_EXPRESSION',
  ];
  const complaints = codes.map((type) => ({
    type,
    evidenceText: '대시보드 전용 민감 근거',
    offsetSeconds: 1,
    utteranceOrders: [],
  }));
  const body = {
    providerCallId: c.providerCallId,
    startedAt: times.started_at.toISOString(),
    endedAt: times.ended_at.toISOString(),
    aiPersonaVersionSeq: null,
    repeatQuestionCount: null,
    hasComplaint: true,
    complaints,
  };
  await ok(await post(c, 'analysis', body));
  await ok(await post(c, 'analysis', body));
  const detail = await f.get('/api/calls/' + c.id);
  assert.equal(detail.status, 200);
  assert.deepEqual((await detail.json()).data.analysis.complaints, complaints);
  assert.doesNotMatch(
    JSON.stringify(f.logs),
    /대시보드 전용 민감 근거|rtc_dashboard_private_|Bearer /,
  );
});

test('Swagger documents separate final metrics, service credentials and removed P95/entry fields', async () => {
  const response = await f.get('/api/docs-json');
  assert.equal(response.status, 200);
  const doc = await response.json();
  for (const section of ['stage-metrics', 'response-wait-metrics']) {
    const route = doc.paths['/api/ai/calls/{id}/' + section].post;
    assert.ok(route.responses['204']);
    assert.ok(route.security.some((entry) => Object.hasOwn(entry, 'bearer')));
  }
  const schemas = doc.components.schemas;
  assert.deepEqual(schemas.CreateStageMetricsDto.required.toSorted(), [
    'dropoffStage',
    'providerCallId',
  ]);
  assert.deepEqual(schemas.CreateResponseWaitMetricsDto.required.toSorted(), [
    'latencyStats',
    'providerCallId',
    'totalWaitMs',
  ]);
  assert.equal(schemas.CallLatencyStatDto.properties.measurementCount.minimum, 1);
  assert.equal(Object.hasOwn(schemas.CallLatencyStatDto.properties, 'p95'), false);
  assert.ok(schemas.CallComplaintDto.properties.type.enum.includes('UNSUPPORTED_ANSWER'));
});
