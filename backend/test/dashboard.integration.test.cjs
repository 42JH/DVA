require('reflect-metadata');
const { test, before, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const token = randomBytes(32).toString('hex');
process.env.AI_INSIGHTS_TOKEN = token;
const { applicationFixture, createTestPool } = require('./helpers/application.cjs');
const f = applicationFixture();
afterEach(async () => {
  const { DashboardRepository } = require('../dist/dashboard/dashboard.repository');
  const repository = f.app.get(DashboardRepository);
  const client = await f.pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    for (const type of ['ALL', 'NEW', 'EXISTING']) {
      const shared = await repository.performance(type, client);
      for (const method of ['stageDropoffs', 'registrationTime', 'complaintCalls', 'responseWait'])
        assert.deepEqual(
          shared[method],
          await repository[method](type, client),
          type + ' ' + method,
        );
    }
    await client.query('COMMIT');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
const paths = ['stage-dropoffs', 'registration-time', 'complaint-calls', 'response-wait'];
const get = (path, customerType, actor = 0, headers = {}) =>
  f.get(
    '/api/dashboard/' +
      path +
      (customerType === undefined
        ? ''
        : '?' +
          (typeof customerType === 'string' && customerType.includes('=')
            ? customerType
            : new URLSearchParams({ customerType }))),
    actor,
    headers,
  );
async function data(response) {
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ['data', 'meta']);
  assert.equal(body.meta.requestId, response.headers.get('x-request-id'));
  return body.data;
}
const read = async (path, customerType) => data(await get(path, customerType));
const near = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);
const complaint = (type) => ({
  type,
  evidenceText: '대시보드 비공개 불편 근거',
  offsetSeconds: 1,
  utteranceOrders: [],
});
const post = (c, section, body) =>
  fetch(f.base + `/api/ai/calls/${c.id}/${section}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerCallId: c.providerCallId, ...body }),
  });
async function sent(response) {
  assert.equal(response.status, 204, await response.text());
}

const previousState = { calls: [], versions: [] };
before(async () => {
  previousState.calls = (
    await f.pool.query('SELECT call_session_seq FROM call_sessions WHERE deleted_at IS NULL')
  ).rows.map((row) => row.call_session_seq);
  previousState.versions = (
    await f.pool.query(
      "SELECT ai_persona_version_seq,status FROM ai_persona_versions WHERE status IN ('ACTIVE','PENDING')",
    )
  ).rows;
});
after(async () => {
  // The shared fixture may already have closed its pool; preserve subsequent runtime checks independently.
  const pool = createTestPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "UPDATE ai_persona_versions SET status='INACTIVE' WHERE status IN ('ACTIVE','PENDING')",
    );
    for (const version of previousState.versions)
      await client.query(
        'UPDATE ai_persona_versions SET status=$2 WHERE ai_persona_version_seq=$1',
        [version.ai_persona_version_seq, version.status],
      );
    await client.query(
      'UPDATE call_sessions SET deleted_at=NULL WHERE call_session_seq=ANY($1::int[])',
      [previousState.calls],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
});

// All data is in the guarded disposable integration DB; each all-time cohort is independent.
beforeEach(async () => {
  await f.pool.query(
    'UPDATE call_sessions SET deleted_at=statement_timestamp() WHERE deleted_at IS NULL',
  );
  await f.pool.query(
    "UPDATE ai_persona_versions SET status='INACTIVE' WHERE status IN ('ACTIVE','PENDING')",
  );
});

async function call(changes = {}) {
  const opts = {
    isNewCustomer: true,
    parcels: 0,
    durationMs: 180000,
    hasComplaint: false,
    complaints: [],
    persona: null,
    analysed: true,
    ...changes,
  };
  const providerCallId = 'rtc_dashboard_read_private_' + randomUUID();
  const start = new Date(Date.now() - 86400000),
    end = new Date(start.getTime() + opts.durationMs);
  const c = {
    providerCallId,
    id: (
      await f.pool.query(
        `INSERT INTO call_sessions(provider_call_id,incoming_at,started_at,ended_at)
    VALUES($1,$2,$3,$4) RETURNING call_session_seq`,
        [
          providerCallId,
          start,
          opts.pbx === false || opts.ongoing ? null : start,
          opts.pbx === false || opts.ongoing ? null : end,
        ],
      )
    ).rows[0].call_session_seq,
  };
  if (opts.analysed && !opts.ongoing)
    await sent(
      await post(c, 'analysis', {
        startedAt: start.toISOString(),
        endedAt: new Date(start.getTime() + (opts.aiDurationMs ?? opts.durationMs)).toISOString(),
        aiPersonaVersionSeq: opts.persona,
        isNewCustomer: opts.isNewCustomer,
        registeredParcelCount: opts.parcels,
        repeatQuestionCount: null,
        hasComplaint: opts.hasComplaint,
        complaints: opts.complaints,
      }),
    );
  if (opts.stage !== undefined)
    await sent(await post(c, 'stage-metrics', { dropoffStage: opts.stage }));
  if (opts.wait !== undefined) await sent(await post(c, 'response-wait-metrics', opts.wait));
  if (opts.deleted) await sent(await f.write('DELETE', '/api/calls', { callSessionSeqs: [c.id] }));
  if (opts.expired)
    await f.pool.query(
      "UPDATE call_sessions SET incoming_at=statement_timestamp()-interval '5 years 1 day' WHERE call_session_seq=$1",
      [c.id],
    );
  return c;
}

async function versions(count = 3) {
  const persona = (
    await f.pool.query('INSERT INTO ai_personas(code) VALUES($1) RETURNING ai_persona_seq', [
      'dashboard-persona-' + randomUUID(),
    ])
  ).rows[0].ai_persona_seq;
  const result = [];
  for (let version = 1; version <= count; version++)
    result.push(
      (
        await f.pool.query(
          `INSERT INTO ai_persona_versions(ai_persona_seq,version,name,prompt_text,turn_wait_level)
    VALUES($1,$2,$3,'비공개 프롬프트','NORMAL') RETURNING ai_persona_version_seq`,
          [persona, version, '상담 버전 ' + version],
        )
      ).rows[0].ai_persona_version_seq,
    );
  return result;
}
async function apply(version) {
  const { DatabaseService } = require('../dist/database/database.service');
  const { AiSettingsRepository } = require('../dist/ai-settings/ai-settings.repository');
  const repo = f.app.get(AiSettingsRepository);
  await f.app.get(DatabaseService).transaction(async (client) => {
    await repo.lock(client);
    await repo.queue(version, randomUUID(), f.ids[0], client);
    await repo.apply(version, client);
  });
}
const zeroWait = () => ({ totalWaitMs: 0, latencyStats: [] });
const sampleWait = () => ({
  totalWaitMs: 12000,
  latencyStats: [
    { processType: 'CUSTOMER_LOOKUP', totalLatencyMs: 4000, measurementCount: 2 },
    { processType: 'ORDER_SAVE', totalLatencyMs: 8000, measurementCount: 2 },
  ],
});

test('all dashboard routes require an active administrator and validate only customerType', async () => {
  for (const path of paths) {
    await f.error(await get(path, undefined, 99), 401, 'UNAUTHORIZED');
    await f.error(
      await get(path, undefined, 99, { Authorization: 'Bearer ' + token }),
      401,
      'UNAUTHORIZED',
    );
    for (const actor of [0, 1, 2])
      assert.equal((await data(await get(path, undefined, actor))).customerType, 'ALL');
    for (const query of [
      'customerType=',
      'customerType=all',
      'customerType=OTHER',
      'customerType=NEW&customerType=EXISTING',
      'from=2026-11-04',
      'to=2026-11-05',
      'limit=20',
      'offset=0',
    ])
      await f.error(await get(path, query), 400, 'INVALID_REQUEST');
  }
  await f.pool.query("UPDATE admin_users SET status='INACTIVE' WHERE admin_user_seq=$1", [
    f.ids[0],
  ]);
  try {
    for (const path of paths) await f.error(await get(path), 401, 'UNAUTHORIZED');
  } finally {
    await f.pool.query("UPDATE admin_users SET status='ACTIVE' WHERE admin_user_seq=$1", [
      f.ids[0],
    ]);
  }
});

test('empty cohorts return measured counts of zero and null ratios/averages with fixed bounded rows', async () => {
  const stage = await read(paths[0]),
    reg = await read(paths[1]),
    complaint = await read(paths[2]),
    wait = await read(paths[3]);
  for (const result of [stage, reg, complaint, wait]) {
    assert.equal(result.endedCallCount, 0);
    assert.equal(result.unclassifiedCustomerCallCount, 0);
  }
  assert.equal(stage.dropoffRatePercent, null);
  assert.equal(stage.stages.length, 8);
  assert.ok(stage.stages.every((x) => x.callCount === 0 && x.dropoffRatePercent === null));
  assert.equal(reg.averageSecondsPerParcel, null);
  assert.deepEqual(reg.comparison, {
    current: null,
    previous: null,
    previousMinusCurrentSeconds: null,
  });
  assert.equal(complaint.complaintRatePercent, null);
  assert.equal(complaint.typeTotalCount, 0);
  assert.equal(complaint.types.length, 6);
  assert.ok(complaint.types.every((x) => x.callCount === 0 && x.sharePercent === null));
  assert.equal(wait.waitRatePercent, null);
  assert.equal(wait.processes.length, 7);
  assert.ok(wait.processes.every((x) => x.measurementCount === 0 && x.averageLatencyMs === null));
});

test('all four cards share new/existing/all, unknown, closed, soft-delete and retention boundaries', async () => {
  await call({
    stage: 'RECIPIENT_INFO',
    parcels: 2,
    hasComplaint: true,
    complaints: [complaint('INFORMATION_RECOGNITION_ERROR')],
    wait: sampleWait(),
  });
  await call({
    isNewCustomer: false,
    stage: 'NONE',
    parcels: 1,
    durationMs: 60000,
    wait: zeroWait(),
  });
  await call({ isNewCustomer: null, stage: 'ITEM_INFO', hasComplaint: null });
  await call({ analysed: false });
  await call({ ongoing: true });
  await call({ stage: 'ORDER_CANCEL', parcels: 100, wait: sampleWait(), deleted: true });
  await call({ stage: 'ORDER_CANCEL', parcels: 100, wait: sampleWait(), expired: true });
  for (const path of paths) {
    const all = await read(path),
      fresh = await read(path, 'NEW'),
      existing = await read(path, 'EXISTING');
    assert.equal(all.endedCallCount, 4);
    assert.equal(all.unclassifiedCustomerCallCount, 2);
    assert.equal(fresh.endedCallCount, 1);
    assert.equal(fresh.unclassifiedCustomerCallCount, 0);
    assert.equal(existing.endedCallCount, 1);
    assert.equal(existing.unclassifiedCustomerCallCount, 0);
  }
  const stage = await read(paths[0]);
  assert.equal(stage.assessedCallCount, 3);
  assert.equal(stage.unassessedCallCount, 1);
  assert.equal(stage.dropoffCallCount, 2);
  near(stage.dropoffRatePercent, 200 / 3);
  const reg = await read(paths[1]);
  assert.equal(reg.registrationCallCount, 2);
  assert.equal(reg.registeredParcelCount, 3);
  assert.equal(reg.unmeasuredCallCount, 1);
  assert.equal(reg.totalCallDurationMs, 240000);
  assert.equal(reg.averageSecondsPerParcel, 80);
  assert.equal((await read(paths[1], 'NEW')).averageSecondsPerParcel, 90);
  assert.equal((await read(paths[1], 'EXISTING')).averageSecondsPerParcel, 60);
  const complaints = await read(paths[2]);
  assert.equal(complaints.assessedCallCount, 2);
  assert.equal(complaints.unassessedCallCount, 2);
  assert.equal(complaints.complaintRatePercent, 50);
  const waits = await read(paths[3]);
  assert.equal(waits.measuredCallCount, 2);
  assert.equal(waits.unmeasuredCallCount, 2);
  assert.equal(waits.waitRatePercent, 5);
  assert.equal(waits.totalCallDurationMs, 240000);
  assert.equal(waits.totalWaitMs, 12000);
});

test('dropoff uses a single exact final stage and normal/unknown remain distinct', async () => {
  const stages = [
    'SENDER_INFO',
    'RECIPIENT_INFO',
    'ITEM_INFO',
    'CONFIRMATION',
    'PAYMENT_GUIDANCE',
    'FAQ_ANSWER',
    'ORDER_LOOKUP',
    'ORDER_CANCEL',
  ];
  for (const stage of stages) await call({ stage });
  await call({ stage: 'NONE' });
  await call();
  const result = await read(paths[0]);
  assert.equal(result.endedCallCount, 10);
  assert.equal(result.assessedCallCount, 9);
  assert.equal(result.dropoffCallCount, 8);
  assert.equal(result.unassessedCallCount, 1);
  near(result.dropoffRatePercent, 800 / 9);
  assert.deepEqual(
    result.stages.map((x) => x.stage),
    stages,
  );
  for (const item of result.stages) {
    assert.equal(item.callCount, 1);
    near(item.dropoffRatePercent, 100 / 9);
    assert.equal(Object.hasOwn(item, 'enteredCallCount'), false);
  }
});

test('registration uses complete PBX call time with AI fallback and confirmed parcel counts', async () => {
  await call({ parcels: 2, durationMs: 180000, aiDurationMs: 120000 });
  assert.equal((await read(paths[1])).averageSecondsPerParcel, 90);
  await call({ parcels: 2, durationMs: 180000, pbx: false });
  await call({ parcels: 0, durationMs: 600000 });
  await call({ parcels: null, durationMs: 600000 });
  const result = await read(paths[1]);
  assert.equal(result.registrationCallCount, 2);
  assert.equal(result.registeredParcelCount, 4);
  assert.equal(result.totalCallDurationMs, 360000);
  assert.equal(result.averageSecondsPerParcel, 90);
  assert.equal(result.unmeasuredCallCount, 1);
});

test('registration bars compare exact current/previous versions with weighted customer-scoped averages', async () => {
  const [old, current, latest] = await versions();
  await apply(old);
  await apply(current);
  await call({ persona: old, parcels: 1, durationMs: 120000 });
  await call({ persona: old, parcels: 2, durationMs: 240000, isNewCustomer: false });
  await call({ persona: current, parcels: 2, durationMs: 180000 });
  await call({ persona: current, parcels: 3, durationMs: 120000, isNewCustomer: false });
  const result = await read(paths[1]);
  assert.equal(result.averageSecondsPerParcel, 82.5);
  assert.equal(result.registeredParcelCount, 8);
  const compare = result.comparison;
  assert.equal(compare.current.aiPersonaVersionSeq, current);
  assert.equal(compare.previous.aiPersonaVersionSeq, old);
  assert.equal(compare.current.aiPersonaSeq, compare.previous.aiPersonaSeq);
  assert.notEqual(compare.current.aiPersonaVersionSeq, latest);
  assert.equal(compare.current.averageSecondsPerParcel, 60);
  assert.equal(compare.previous.averageSecondsPerParcel, 120);
  assert.equal(compare.previousMinusCurrentSeconds, 60);
  assert.equal(compare.current.registeredParcelCount, 5);
  assert.equal(compare.previous.registeredParcelCount, 3);
  const fresh = (await read(paths[1], 'NEW')).comparison,
    existing = (await read(paths[1], 'EXISTING')).comparison;
  assert.equal(fresh.current.averageSecondsPerParcel, 90);
  assert.equal(fresh.previousMinusCurrentSeconds, 30);
  assert.equal(existing.current.averageSecondsPerParcel, 40);
  assert.equal(existing.previousMinusCurrentSeconds, 80);
});

test('comparison survives reactivation/PENDING and missing history never selects an arbitrary version', async () => {
  const [first] = await versions(1),
    [second] = await versions(1);
  await apply(first);
  let result = (await read(paths[1])).comparison;
  assert.equal(result.current.aiPersonaVersionSeq, first);
  assert.equal(result.previous, null);
  assert.equal(result.current.averageSecondsPerParcel, null);
  await apply(second);
  const { AiSettingsRepository } = require('../dist/ai-settings/ai-settings.repository');
  const { DatabaseService } = require('../dist/database/database.service');
  const repo = f.app.get(AiSettingsRepository);
  await f.app.get(DatabaseService).transaction(async (client) => {
    await repo.lock(client);
    await repo.queue(first, randomUUID(), f.ids[0], client);
  });
  assert.equal(
    (
      await f.pool.query(
        'SELECT applied_at FROM ai_persona_versions WHERE ai_persona_version_seq=$1',
        [first],
      )
    ).rows[0].applied_at,
    null,
  );
  result = (await read(paths[1])).comparison;
  assert.equal(result.current.aiPersonaVersionSeq, second);
  assert.equal(result.previous.aiPersonaVersionSeq, first);
  await f.app.get(DatabaseService).transaction(async (client) => {
    await repo.lock(client);
    await repo.apply(first, client);
  });
  result = (await read(paths[1])).comparison;
  assert.equal(result.current.aiPersonaVersionSeq, first);
  assert.equal(result.previous.aiPersonaVersionSeq, second);
  await f.pool.query(
    'UPDATE ai_persona_versions SET previous_active_version_seq=NULL WHERE ai_persona_version_seq=$1',
    [first],
  );
  assert.equal((await read(paths[1])).comparison.previous, null);
});

test('complaint rates count calls once, type rows deduplicate within a call and retain legacy coverage', async () => {
  await call({
    hasComplaint: true,
    complaints: [
      complaint('INFORMATION_RECOGNITION_ERROR'),
      complaint('INFORMATION_RECOGNITION_ERROR'),
      complaint('SLOW_RESPONSE'),
    ],
  });
  await call({
    hasComplaint: true,
    complaints: [complaint('INFORMATION_RECOGNITION_ERROR'), complaint('INTENT_RECOGNITION_ERROR')],
  });
  await call({
    hasComplaint: true,
    complaints: [complaint('REPEATED_QUESTION'), complaint('AI_REFUSAL')],
  });
  await call();
  await call({ hasComplaint: null });
  const result = await read(paths[2]);
  assert.equal(result.assessedCallCount, 4);
  assert.equal(result.unassessedCallCount, 1);
  assert.equal(result.complaintCallCount, 2);
  assert.equal(result.complaintRatePercent, 50);
  assert.equal(result.typeTotalCount, 4);
  assert.equal(result.legacyTypeCallCount, 1);
  const byType = Object.fromEntries(result.types.map((x) => [x.type, x]));
  assert.equal(byType.INFORMATION_RECOGNITION_ERROR.callCount, 2);
  assert.equal(byType.INFORMATION_RECOGNITION_ERROR.sharePercent, 50);
  assert.equal(byType.SLOW_RESPONSE.callCount, 1);
  assert.equal(byType.INTENT_RECOGNITION_ERROR.callCount, 1);
  assert.equal(byType.UNSUPPORTED_ANSWER.callCount, 0);
  assert.equal(
    result.types.reduce((sum, x) => sum + x.sharePercent, 0),
    100,
  );
});

test('response waits use matching call duration and weighted latency summaries without P95 or overlap double counting', async () => {
  await call({ durationMs: 60000, wait: sampleWait() });
  await call({
    durationMs: 180000,
    wait: {
      totalWaitMs: 6000,
      latencyStats: [
        { processType: 'CUSTOMER_LOOKUP', totalLatencyMs: 3000, measurementCount: 1 },
        { processType: 'ORDER_SAVE', totalLatencyMs: 6000, measurementCount: 3 },
      ],
    },
  });
  await call({ durationMs: 60000, wait: zeroWait() });
  await call({ durationMs: 300000 });
  const invalid = await call({ wait: sampleWait() });
  await f.pool.query(
    "UPDATE call_sessions SET ended_at=started_at+interval '5 seconds' WHERE call_session_seq=$1",
    [invalid.id],
  );
  const result = await read(paths[3]);
  assert.equal(result.measuredCallCount, 3);
  assert.equal(result.unmeasuredCallCount, 1);
  assert.equal(result.invalidWaitCallCount, 1);
  assert.equal(result.totalWaitMs, 18000);
  assert.equal(result.totalCallDurationMs, 300000);
  assert.equal(result.waitRatePercent, 6);
  const byType = Object.fromEntries(result.processes.map((x) => [x.processType, x]));
  assert.equal(byType.CUSTOMER_LOOKUP.measurementCount, 3);
  assert.equal(byType.CUSTOMER_LOOKUP.totalLatencyMs, 7000);
  near(byType.CUSTOMER_LOOKUP.averageLatencyMs, 7000 / 3);
  assert.equal(byType.ORDER_SAVE.measurementCount, 5);
  assert.equal(byType.ORDER_SAVE.averageLatencyMs, 2800);
  assert.equal(byType.FAQ_LOOKUP.averageLatencyMs, null);
  assert.doesNotMatch(JSON.stringify(result), /p95|P95/);
});

test('measured zero duration is distinct from missing duration and does not divide by zero', async () => {
  await call({ durationMs: 0, parcels: 1, stage: 'NONE', wait: zeroWait() });
  assert.equal((await read(paths[0])).dropoffRatePercent, 0);
  assert.equal((await read(paths[1])).averageSecondsPerParcel, 0);
  const wait = await read(paths[3]);
  assert.equal(wait.measuredCallCount, 1);
  assert.equal(wait.totalCallDurationMs, 0);
  assert.equal(wait.waitRatePercent, null);
});

test('the real retention finalizer removes metrics with expired analysis and preserves another call', async () => {
  const retained = await call({ stage: 'NONE', wait: zeroWait() });
  const expired = await call({ stage: 'RECIPIENT_INFO', wait: sampleWait() });
  const claimId = randomUUID();
  await f.pool.query(
    "UPDATE call_sessions SET incoming_at=statement_timestamp()-interval '5 years 1 day',purge_claim_id=$2,purge_claimed_until=statement_timestamp()+interval '5 minutes' WHERE call_session_seq=$1",
    [expired.id, claimId],
  );
  const { RetentionRepository } = require('../dist/retention/retention.repository');
  assert.equal(
    await f.app
      .get(RetentionRepository)
      .finishCall({ id: expired.id, phone: null, claimId, keys: [] }),
    true,
  );
  for (const table of ['call_sessions', 'call_analyses', 'call_dashboard_metrics']) {
    assert.equal(
      (await f.pool.query(`SELECT 1 FROM ${table} WHERE call_session_seq=$1`, [expired.id]))
        .rowCount,
      0,
    );
    assert.equal(
      (await f.pool.query(`SELECT 1 FROM ${table} WHERE call_session_seq=$1`, [retained.id]))
        .rowCount,
      1,
    );
  }
  for (const path of paths) assert.equal((await read(path)).endedCallCount, 1);
});

test('query failures remain redacted errors and Swagger exposes four cookie-authenticated contracts', async () => {
  const { DashboardRepository } = require('../dist/dashboard/dashboard.repository');
  const repo = f.app.get(DashboardRepository);
  for (const [path, method] of [
    ['stage-dropoffs', 'stageDropoffs'],
    ['registration-time', 'registrationTime'],
    ['complaint-calls', 'complaintCalls'],
    ['response-wait', 'responseWait'],
  ]) {
    const original = repo[method];
    repo[method] = async () => {
      throw new Error('SELECT dashboard-private-value');
    };
    try {
      const body = await f.error(await get(path), 500, 'INTERNAL_ERROR');
      assert.doesNotMatch(JSON.stringify(body), /SELECT|dashboard-private/);
    } finally {
      repo[method] = original;
    }
  }
  assert.doesNotMatch(
    JSON.stringify(f.logs),
    /비공개 불편 근거|비공개 프롬프트|rtc_dashboard_read_private_|Bearer /,
  );
});

test('AI 품질은 AI 오류와 ai_service 불만만 집계하고 참고·다른 책임·미상은 구분한다', async () => {
  for (const complaints of [
    [{ type: 'DISSATISFACTION_EXPRESSION', target: 'ai_service', level: 'mild' }],
    [{ type: 'DISSATISFACTION_EXPRESSION', target: 'price_policy', level: 'explicit' }],
    [{ type: 'DISSATISFACTION_EXPRESSION', target: 'delivery_other', level: 'mild' }],
    [{ type: 'DISSATISFACTION_EXPRESSION' }],
    [{ type: 'UNSUPPORTED_ANSWER' }],
    [{ type: 'REPEATED_QUESTION' }],
    [
      { type: 'SLOW_RESPONSE' },
      { type: 'SLOW_RESPONSE' },
      { type: 'UNSUPPORTED_ANSWER' },
      { type: 'DISSATISFACTION_EXPRESSION', target: 'ai_service', level: 'explicit' },
      { type: 'DISSATISFACTION_EXPRESSION', target: 'price_policy', level: 'mild' },
    ],
  ]) {
    const c = await call();
    await f.pool.query(
      'UPDATE call_analyses SET has_complaint=true,complaints=$2::jsonb WHERE call_session_seq=$1',
      [c.id, JSON.stringify(complaints.map((item) => ({ ...complaint(item.type), ...item })))],
    );
  }
  await call();
  await call({ hasComplaint: null });
  const result = await read(paths[2]);
  assert.equal(result.assessedCallCount, 8);
  assert.equal(result.unassessedCallCount, 1);
  assert.equal(result.complaintCallCount, 2);
  assert.equal(result.complaintRatePercent, 25);
  assert.equal(result.typeTotalCount, 3);
  assert.equal(result.legacyTypeCallCount, 1);
  const types = Object.fromEntries(result.types.map((item) => [item.type, item]));
  assert.equal(types.DISSATISFACTION_EXPRESSION.callCount, 2);
  near(types.DISSATISFACTION_EXPRESSION.sharePercent, 200 / 3);
  assert.equal(types.SLOW_RESPONSE.callCount, 1);
  assert.deepEqual(types.UNSUPPORTED_ANSWER, {
    type: 'UNSUPPORTED_ANSWER',
    callCount: 0,
    sharePercent: null,
    referenceOnly: true,
  });
  assert.ok(
    result.types
      .filter((item) => item.type !== 'UNSUPPORTED_ANSWER')
      .every((item) => item.referenceOnly === false),
  );
});
