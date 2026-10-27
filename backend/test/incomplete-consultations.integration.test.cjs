require('reflect-metadata');
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Pool } = require('pg');
const { NestFactory } = require('@nestjs/core');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.DB_NAME, 'dva_webhook_test');
assert.ok(['db', '127.0.0.1'].includes(process.env.DB_HOST));
process.env.SWAGGER_ENABLED = 'true';
const { AppModule } = require('../dist/app.module');
const { configureApplication } = require('../dist/configure-application');
const {
  IncompleteConsultationsRepository,
} = require('../dist/consultations/incomplete-consultations.repository');
const { AuditService } = require('../dist/audit/audit.service');
const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});
const apps = [],
  hosts = [];
let repository;
async function start() {
  const app = await NestFactory.create(AppModule, { logger: false });
  configureApplication(app, { log: () => {} });
  await app.listen(0, '127.0.0.1');
  apps.push(app);
  hosts.push(await app.getUrl());
  return apps.length - 1;
}
before(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (
      !(await client.query("SELECT to_regclass('public.incomplete_consultations') AS present"))
        .rows[0].present
    )
      await client.query(
        readFileSync(join(__dirname, '../migrations/006-incomplete-consultations.sql'), 'utf8'),
      );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  await start();
  await start();
  repository = apps[0].get(IncompleteConsultationsRepository);
});
after(async () => {
  for (const app of apps) await app.close();
  await pool.end();
});
const payload = () => ({
  eventId: 'event-' + randomUUID(),
  providerCallId: 'provider-' + randomUUID(),
  endedAt: '2026-10-27T00:00:00Z',
  snapshot: {},
});
const post = (body, index = 0) =>
  fetch(hosts[index] + '/api/consultations/incomplete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
const counts = async () =>
  (
    await pool.query(
      'SELECT (SELECT count(*) FROM customers) AS customers, (SELECT count(*) FROM orders) AS orders, (SELECT count(*) FROM order_parcels) AS parcels, (SELECT count(*) FROM call_sessions) AS calls, (SELECT count(*) FROM incomplete_consultations) AS incomplete',
    )
  ).rows[0];
const stored = async (id) =>
  (
    await pool.query(
      'SELECT * FROM incomplete_consultations WHERE incomplete_consultation_seq=$1',
      [id],
    )
  ).rows[0];
async function saved(body, index = 0) {
  const response = await post(body, index);
  assert.equal(response.status, 201);
  return (await response.json()).data;
}
async function error(response, status, code) {
  assert.equal(response.status, status);
  assert.equal((await response.json()).error.code, code);
}

test('AI stores one end snapshot separately, preserves invalid collected text and leaves unknown causes null', async () => {
  const input = payload();
  input.snapshot = {
    parcels: [{ origin: { name: '미완료 고객', phoneNumber: '잘못 들은 번호' }, smallBoxCount: 0 }],
  };
  const before = await counts(),
    result = await saved(input),
    row = await stored(result.incompleteConsultationSeq);
  assert.equal(row.end_type, null);
  assert.equal(row.system_event, null);
  assert.equal(row.order_snapshot.paymentMethodType, null);
  assert.equal(row.order_snapshot.parcels[0].origin.phoneNumber, '잘못 들은 번호');
  assert.ok(row.collection_analysis.collectedFields.includes('parcels.0.smallBoxCount'));
  assert.ok(row.collection_analysis.missingFields.includes('paymentMethodType'));
  assert.ok(row.collection_analysis.errors.some((x) => x.reason === 'digitsOnly'));
  const after = await counts();
  for (const key of ['customers', 'orders', 'parcels']) assert.equal(after[key], before[key]);
  const call = (
    await pool.query('SELECT * FROM call_sessions WHERE call_session_seq=$1', [
      result.callSessionSeq,
    ])
  ).rows[0];
  assert.equal(call.order_seq, null);
  assert.equal(call.started_at, null);
  assert.equal(call.ended_at, null);
});

test('existing call identity and EPIC1 utterances/recordings are reused without overwrites', async () => {
  const input = payload();
  input.endType = 'TRANSPORT_CLOSED';
  input.systemEvent = 'socket.closed';
  const call = (
    await pool.query(
      "INSERT INTO call_sessions(provider_call_id,started_at,ended_at,end_reason) VALUES($1,'2026-10-26T23:58:00Z','2026-10-27T00:00:00Z','original-event') RETURNING call_session_seq",
      [input.providerCallId],
    )
  ).rows[0].call_session_seq;
  await pool.query(
    "INSERT INTO call_utterances(call_session_seq,utterance_order,speaker,utterance_text,last_sentence_seq) VALUES($1,1,'CUSTOMER','기존 발화',1)",
    [call],
  );
  await pool.query('INSERT INTO recordings(call_session_seq,object_key) VALUES($1,$2)', [
    call,
    'tests/' + randomUUID() + '.wav',
  ]);
  const result = await saved(input);
  assert.equal(result.callSessionSeq, call);
  assert.equal(
    (await pool.query('SELECT end_reason FROM call_sessions WHERE call_session_seq=$1', [call]))
      .rows[0].end_reason,
    'original-event',
  );
  assert.equal(
    (await pool.query('SELECT count(*) FROM call_utterances WHERE call_session_seq=$1', [call]))
      .rows[0].count,
    '1',
  );
  assert.equal(
    (await pool.query('SELECT count(*) FROM recordings WHERE call_session_seq=$1', [call])).rows[0]
      .count,
    '1',
  );
});

test('same event replays across app restart and canonical timezone/null input without another success audit', async () => {
  const input = payload(),
    first = await saved(input);
  const third = await start();
  assert.deepEqual(
    await saved(
      { ...input, endedAt: '2026-10-27T09:00:00+09:00', endType: null, systemEvent: null },
      third,
    ),
    first,
  );
  const audit = await pool.query(
    "SELECT actor_seq,metadata FROM audit_logs WHERE target_type='INCOMPLETE_CONSULTATION' AND target_seq=$1 AND result='SUCCESS'",
    [first.incompleteConsultationSeq],
  );
  assert.equal(audit.rowCount, 1);
  assert.equal(audit.rows[0].actor_seq, null);
  assert.deepEqual(audit.rows[0].metadata, {});
  for (const changed of [
    { ...input, eventId: randomUUID() },
    { ...input, snapshot: { paymentMethodType: 'credit' } },
  ])
    await error(await post(changed), 409, 'EVENT_PAYLOAD_CONFLICT');
  assert.deepEqual((await stored(first.incompleteConsultationSeq)).order_snapshot.parcels, []);
});

test('concurrent termination deliveries across app instances make only one call and snapshot', async () => {
  const input = payload();
  const replies = await Promise.all(Array.from({ length: 6 }, (_, i) => post(input, i % 2)));
  for (const reply of replies) assert.ok([201, 409].includes(reply.status));
  const first = await saved(input);
  for (let i = 0; i < 3; i++) assert.deepEqual(await saved(input, i % 2), first);
  assert.equal(
    (
      await pool.query('SELECT count(*) FROM call_sessions WHERE provider_call_id=$1', [
        input.providerCallId,
      ])
    ).rows[0].count,
    '1',
  );
  assert.equal(
    (
      await pool.query('SELECT count(*) FROM incomplete_consultations WHERE call_session_seq=$1', [
        first.callSessionSeq,
      ])
    ).rows[0].count,
    '1',
  );
  const client = await pool.connect(),
    locked = payload();
  try {
    await client.query('BEGIN');
    await repository.lock(client, locked.providerCallId);
    await error(await post(locked), 409, 'REQUEST_IN_PROGRESS');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  assert.equal(
    (
      await pool.query('SELECT count(*) FROM call_sessions WHERE provider_call_id=$1', [
        locked.providerCallId,
      ])
    ).rows[0].count,
    '0',
  );
});

test('snapshot or success audit failure rolls back a new call and snapshot; retry succeeds', async () => {
  const audit = apps[0].get(AuditService);
  for (const [target, method] of [
    [repository, 'insert'],
    [audit, 'recordSuccess'],
  ]) {
    const input = payload(),
      before = await counts(),
      original = target[method];
    target[method] = async () => {
      throw new Error('test injected write failure');
    };
    try {
      await error(await post(input), 500, 'INTERNAL_ERROR');
    } finally {
      target[method] = original;
    }
    assert.deepEqual(await counts(), before);
    await saved(input);
  }
});

test('invalid event envelopes and snapshots reject without database writes', async () => {
  const before = await counts();
  for (const body of [
    {},
    { ...payload(), eventId: '' },
    { ...payload(), providerCallId: ' ' },
    { ...payload(), endedAt: '2026-10-27T00:00:00' },
    { ...payload(), endedAt: '2026-02-30T00:00:00Z' },
    { ...payload(), endedAt: '2026-W43-2T00:00:00Z' },
    { ...payload(), endedAt: '2026-300T00:00:00Z' },
    { ...payload(), snapshot: null },
    { ...payload(), snapshot: { status: 'ACCEPTED' } },
    { ...payload(), endType: ' ' },
    { ...payload(), transcript: 'unsupported' },
  ])
    await error(await post(body), 400, 'INVALID_REQUEST');
  assert.deepEqual(await counts(), before);
});

test('calls already linked to orders and impossible termination chronology are not misclassified', async () => {
  const input = payload();
  const orderId = (await pool.query('INSERT INTO orders DEFAULT VALUES RETURNING order_seq'))
    .rows[0].order_seq;
  await pool.query('INSERT INTO call_sessions(provider_call_id,order_seq) VALUES($1,$2)', [
    input.providerCallId,
    orderId,
  ]);
  const before = await counts();
  await error(await post(input), 409, 'INVALID_STATE');
  assert.deepEqual(await counts(), before);
  const tooEarly = payload();
  await pool.query(
    "INSERT INTO call_sessions(provider_call_id,started_at,ended_at) VALUES($1,'2026-10-27T00:01:00Z','2026-10-27T00:02:00Z')",
    [tooEarly.providerCallId],
  );
  await error(await post(tooEarly), 400, 'INVALID_REQUEST');
});

test('new calls do not restore or share the prior incomplete snapshot', async () => {
  const firstInput = payload();
  firstInput.snapshot = { parcels: [{ origin: { phoneNumber: '01012345678', name: '앞 통화' } }] };
  const first = await saved(firstInput),
    next = await saved(payload());
  assert.notEqual(first.callSessionSeq, next.callSessionSeq);
  assert.deepEqual((await stored(next.incompleteConsultationSeq)).order_snapshot.parcels, []);
});
