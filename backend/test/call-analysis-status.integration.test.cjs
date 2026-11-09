require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes, randomInt } = require('node:crypto');
const { ConfigService } = require('@nestjs/config');
const { AuditService } = require('../dist/audit/audit.service');
const token = randomBytes(32).toString('hex');
process.env.AI_INSIGHTS_TOKEN = token;
const { applicationFixture } = require('./helpers/application.cjs');
const f = applicationFixture();

async function call({ ended = true, incomingAt = new Date().toISOString() } = {}) {
  const providerCallId = 'rtc_status_' + randomUUID();
  const phone = '010' + randomInt(10000000, 100000000);
  const row = (
    await f.pool.query(
      "INSERT INTO call_sessions(provider_call_id,caller_phone_number,incoming_at,started_at,ended_at) VALUES($1,$2,$3,CASE WHEN $4 THEN clock_timestamp()-interval '8 minutes' END,CASE WHEN $4 THEN clock_timestamp()-interval '7 minutes' END) RETURNING call_session_seq AS id",
      [providerCallId, phone, incomingAt, ended],
    )
  ).rows[0];
  return { ...row, providerCallId, phone };
}
function post(path, body, headers = {}) {
  return fetch(f.base + path, {
    method: 'POST',
    headers: Object.fromEntries(
      Object.entries({
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        ...headers,
      }).filter(([, value]) => value !== undefined),
    ),
    body: JSON.stringify(body),
  });
}
const failure = (c, body = { providerCallId: c.providerCallId }, headers = {}) =>
  post('/api/ai/calls/' + c.id + '/analysis/failure', body, headers);
const analyse = (c) =>
  post('/api/ai/calls/' + c.id + '/analysis', {
    providerCallId: c.providerCallId,
    startedAt: new Date(Date.now() - 480000).toISOString(),
    endedAt: new Date(Date.now() - 420000).toISOString(),
    aiPersonaVersionSeq: null,
    repeatQuestionCount: null,
    hasComplaint: null,
    complaints: [],
  });
async function accepted(response) {
  assert.equal(response.status, 204, await response.clone().text());
  assert.equal(await response.text(), '');
}
async function state(c, expected, recordedAt = null) {
  const detail = await f.get('/api/calls/' + c.id);
  assert.equal(detail.status, 200, await detail.clone().text());
  const data = (await detail.json()).data;
  assert.equal(data.call.analysisStatus, expected);
  assert.equal(data.call.recordedAt, recordedAt);
  assert.equal(data.analysis !== null, expected === 'COMPLETED');
  const list = await f.get('/api/calls?callerPhoneNumber=' + c.phone);
  assert.equal(list.status, 200, await list.clone().text());
  const body = await list.json();
  assert.equal(body.total_count, 1);
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].callSessionSeq, c.id);
  assert.equal(body.data[0].analysisStatus, expected);
  assert.equal(body.data[0].recordedAt, recordedAt);
  assert.equal(body.hasNext, false);
  return data;
}
const stamp = async (c) =>
  (
    await f.pool.query('SELECT analysis_failed_at FROM call_sessions WHERE call_session_seq=$1', [
      c.id,
    ])
  ).rows[0].analysis_failed_at;
const audits = async (c) =>
  (
    await f.pool.query(
      "SELECT count(*)::int AS n FROM audit_logs WHERE target_type='CALL_SESSION' AND target_seq=$1 AND action='CALL_ANALYSIS_FAILED' AND result='SUCCESS'",
      [c.id],
    )
  ).rows[0].n;

test('list and detail expose PENDING independently of elapsed time and PBX completion', async () => {
  await state(await call(), 'PENDING');
  await state(await call({ ended: false }), 'PENDING');
});

test('failure uses the existing insights credential, never a business token or administrator cookie', async () => {
  const c = await call();
  for (const headers of [
    { Authorization: undefined },
    { Authorization: 'Bearer wrong' },
    { Authorization: 'Bearer ' + process.env.AI_BUSINESS_TOKEN },
    { Authorization: undefined, Cookie: f.cookies[2], Origin: f.origin },
  ])
    await f.error(await failure(c, undefined, headers), 401, 'UNAUTHORIZED');
  const config = f.app.get(ConfigService);
  config.set('AI_INSIGHTS_TOKEN', '');
  try {
    await f.error(await failure(c), 503, 'DEPENDENCY_UNAVAILABLE');
  } finally {
    config.set('AI_INSIGHTS_TOKEN', token);
  }
  assert.equal(await stamp(c), null);
});

test('failure validates its minimal body, call identity and deleted/expired boundaries before persistence', async () => {
  const c = await call();
  for (const body of [
    {},
    { providerCallId: '' },
    { providerCallId: 12 },
    { providerCallId: 'x'.repeat(201) },
    { providerCallId: 'rtc wrong' },
    { providerCallId: c.providerCallId, failedAt: new Date().toISOString() },
  ])
    await f.error(await failure(c, body), 400, 'INVALID_REQUEST');
  await f.error(await failure(c, { providerCallId: 'rtc_other' }), 403, 'FORBIDDEN');
  for (const id of ['0', 'bad', '2147483648'])
    await f.error(await failure({ ...c, id }), 400, 'INVALID_REQUEST');
  await f.error(await failure({ ...c, id: 2147483647 }), 404, 'NOT_FOUND');
  const removed = await call();
  await f.pool.query(
    'UPDATE call_sessions SET deleted_at=clock_timestamp() WHERE call_session_seq=$1',
    [removed.id],
  );
  await f.error(await failure(removed), 404, 'NOT_FOUND');
  const expired = await call({ incomingAt: '2020-01-01T00:00:00Z' });
  await f.error(await failure(expired), 404, 'NOT_FOUND');
  for (const item of [c, removed, expired]) assert.equal(await stamp(item), null);
});

test('final failure is idempotent, retains its first receipt and changes no PBX or business data', async () => {
  const c = await call({ ended: false });
  const snapshot = async () =>
    (
      await f.pool.query(
        "SELECT to_jsonb(c)-'analysis_failed_at' AS data FROM call_sessions c WHERE call_session_seq=$1",
        [c.id],
      )
    ).rows[0].data;
  const before = await snapshot();
  await accepted(await failure(c));
  const first = await stamp(c);
  assert.ok(first instanceof Date);
  await accepted(await failure(c));
  assert.deepEqual(await stamp(c), first);
  assert.deepEqual(await snapshot(), before);
  assert.equal(await audits(c), 1);
  await state(c, 'FAILED');
});

test('a recovered successful analysis takes precedence and late failure never downgrades it', async () => {
  const c = await call();
  await accepted(await failure(c));
  const first = await stamp(c);
  await accepted(await analyse(c));
  await state(c, 'COMPLETED');
  await accepted(await failure(c));
  assert.deepEqual(await stamp(c), first);
  const successful = await call();
  await accepted(await analyse(successful));
  await accepted(await failure(successful));
  assert.equal(await stamp(successful), null);
  assert.equal(await audits(successful), 0);
  await state(successful, 'COMPLETED');
});

test('concurrent reports create one failure audit and concurrent success remains completed', async () => {
  const c = await call();
  for (const response of await Promise.all(Array.from({ length: 8 }, () => failure(c))))
    await accepted(response);
  assert.equal(await audits(c), 1);
  const mixed = await call();
  for (const response of await Promise.all([analyse(mixed), failure(mixed), failure(mixed)]))
    await accepted(response);
  await state(mixed, 'COMPLETED');
});

test('failure evidence rolls back when its success audit cannot be stored', async () => {
  const c = await call();
  const audit = f.app.get(AuditService);
  const original = audit.recordSuccess;
  audit.recordSuccess = async function (event, ...args) {
    if (event.action === 'CALL_ANALYSIS_FAILED')
      throw new Error('Injected analysis failure audit error');
    return original.call(this, event, ...args);
  };
  try {
    await f.error(await failure(c), 500, 'INTERNAL_ERROR');
  } finally {
    audit.recordSuccess = original;
  }
  assert.equal(await stamp(c), null);
  assert.equal(await audits(c), 0);
  await state(c, 'PENDING');
  await accepted(await failure(c));
});

test('recordedAt is the earliest saved recording without duplicate calls or analysis inference', async () => {
  const c = await call();
  const earlier = new Date(Date.now() - 120000).toISOString();
  const later = new Date(Date.now() - 60000).toISOString();
  await f.pool.query(
    'INSERT INTO recordings(call_session_seq,object_key,created_at) VALUES($1,$2,$3),($1,$4,$5)',
    [c.id, 'recordings/' + randomUUID(), later, 'recordings/' + randomUUID(), earlier],
  );
  await state(c, 'PENDING', earlier);
  await accepted(await failure(c));
  await state(c, 'FAILED', earlier);
  await accepted(await analyse(c));
  await state(c, 'COMPLETED', earlier);
});

test('Swagger documents the shared call fields and the AI-only minimal failure contract', async () => {
  const response = await fetch(f.base + '/api/docs-json');
  assert.equal(response.status, 200);
  const spec = await response.json();
  const properties = spec.components.schemas.CallDto.properties;
  assert.deepEqual(properties.analysisStatus.enum, ['PENDING', 'COMPLETED', 'FAILED']);
  assert.equal(properties.recordedAt.nullable, true);
  assert.equal(properties.recordedAt.format, 'date-time');
  const operation = spec.paths['/api/ai/calls/{id}/analysis/failure'].post;
  assert.ok(operation.responses['204']);
  assert.deepEqual(operation.security, [{ bearer: [] }]);
  const name = operation.requestBody.content['application/json'].schema.$ref.split('/').at(-1);
  assert.deepEqual(Object.keys(spec.components.schemas[name].properties), ['providerCallId']);
});
