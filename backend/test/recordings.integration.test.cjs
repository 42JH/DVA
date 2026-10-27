require('reflect-metadata');
const { before, beforeEach, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { NestFactory } = require('@nestjs/core');
const { ConfigService } = require('@nestjs/config');
const { PbxRecordingWorker } = require('../dist/webhooks/pbx/pbx-recording.worker');
const { RecordingStorage } = require('../dist/webhooks/pbx/recording-storage');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.DB_NAME, 'dva_webhook_test');
assert.ok(['db', '127.0.0.1'].includes(process.env.DB_HOST));
process.env.SWAGGER_ENABLED = 'true';
process.env.S3_RECORDINGS_BUCKET = '';
process.env.PBX_WEBHOOK_TOKEN = randomUUID();
const { AppModule } = require('../dist/app.module');
const { configureApplication } = require('../dist/configure-application');
const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});
const apps = [],
  urls = [],
  workers = [],
  stores = [];
const objects = new Map();
let uploads, saving;
const payload = () => ({
  recordingId: 'pipeline-' + randomUUID(),
  callFrom: '01098880001',
  callTo: '07012345678',
  startedAt: '2026-10-27T01:00:00Z',
  endedAt: '2026-10-27T01:03:00Z',
  durationSeconds: 180,
  recordingUrl: 'https://recordings.example.test/audio.mp3?signed=private-test',
});
const receipt = async (data) => {
  const response = await fetch(urls[0] + '/webhooks/pbx/call-ended', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.PBX_WEBHOOK_TOKEN}`,
    },
    body: JSON.stringify(data),
  });
  assert.equal(response.status, 200);
  await pool.query(
    "UPDATE pbx_webhooks.call_ended_events SET received_at=clock_timestamp()-interval '2 minutes' WHERE recording_id=$1",
    [data.recordingId],
  );
  return response.json();
};
const replayable = (id) =>
  pool.query(
    'UPDATE pbx_webhooks.call_ended_events SET last_attempt_at=NULL WHERE recording_id=$1',
    [id],
  );
const state = async (id) =>
  (
    await pool.query(
      `SELECT processing_status,call_session_seq,last_attempt_at,
 (SELECT count(*)::int FROM recordings r WHERE r.call_session_seq=e.call_session_seq) AS recordings
 FROM pbx_webhooks.call_ended_events e WHERE recording_id=$1`,
      [id],
    )
  ).rows[0];
const call = async (phone = '01098880001', offset = 0) =>
  (
    await pool.query(
      `INSERT INTO call_sessions(provider_call_id,caller_phone_number,incoming_at) VALUES($1,$2,'2026-10-27T01:00:00Z'::timestamptz+make_interval(secs=>$3)) RETURNING call_session_seq`,
      [randomUUID(), phone, offset],
    )
  ).rows[0].call_session_seq;
before(async () => {
  assert.equal(
    (
      await pool.query(
        "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='call_sessions' AND column_name='incoming_at') AS ready",
      )
    ).rows[0].ready,
    true,
    'run the integration suite with its schema setup',
  );
  for (let index = 0; index < 2; index++) {
    const app = await NestFactory.create(AppModule, { logger: false });
    configureApplication(app, { log: () => {} });
    await app.listen(0, '127.0.0.1');
    apps.push(app);
    urls.push(await app.getUrl());
    app.get(ConfigService).set('S3_RECORDINGS_BUCKET', 'test-recordings');
    const store = app.get(RecordingStorage);
    store.save = (...args) => saving(...args);
    stores.push(store);
    workers.push(app.get(PbxRecordingWorker));
  }
});
beforeEach(async () => {
  // Guarded disposable DB only. Remove receipts from prior suites so the worker processes this scenario.
  await pool.query('DELETE FROM pbx_webhooks.call_ended_events');
  await pool.query(
    "UPDATE call_sessions SET incoming_at=NULL WHERE caller_phone_number='01098880001'",
  );
  objects.clear();
  uploads = 0;
  saving = async (id, callId) => {
    if (!objects.has(id)) {
      uploads++;
      objects.set(id, { callId, key: `recordings/${id}` });
    }
    assert.equal(objects.get(id).callId, callId);
    return objects.get(id).key;
  };
});
after(async () => {
  for (const app of apps) await app.close();
  await pool.end();
});

test('real AI result and authenticated PBX receipt connect order, call times and S3 reference', async () => {
  const response = await fetch(urls[0] + '/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({
      outcome: 'INCOMPLETE',
      call: {
        providerCallId: randomUUID(),
        callerPhoneNumber: '+821098880001',
        incomingAt: '2026-10-27T01:00:02Z',
      },
      parcels: [],
    }),
  });
  assert.equal(response.status, 201);
  const order = (await response.json()).data;
  const data = payload();
  assert.deepEqual(await receipt(data), {
    status: 'received',
    recordingId: data.recordingId,
    duplicate: false,
  });
  assert.equal(uploads, 0);
  await workers[0].processPending();
  const stored = await state(data.recordingId);
  assert.equal(stored.processing_status, 'PROCESSED');
  assert.equal(stored.call_session_seq, order.callSessionSeq);
  assert.equal(stored.recordings, 1);
  const session = (
    await pool.query(
      'SELECT order_seq,started_at,ended_at,incoming_at FROM call_sessions WHERE call_session_seq=$1',
      [order.callSessionSeq],
    )
  ).rows[0];
  assert.equal(session.order_seq, order.orderSeq);
  assert.equal(session.started_at.toISOString(), '2026-10-27T01:00:00.000Z');
  assert.equal(session.ended_at.toISOString(), '2026-10-27T01:03:00.000Z');
  assert.equal(session.incoming_at.toISOString(), '2026-10-27T01:00:02.000Z');
  assert.equal((await receipt(data)).duplicate, true);
  await workers[1].processPending();
  assert.equal(uploads, 1);
});

test('webhook arriving before the AI result remains pending and reconciles on the next attempt', async () => {
  const data = payload();
  await receipt(data);
  await workers[0].processPending();
  assert.equal((await state(data.recordingId)).processing_status, 'RECEIVED');
  assert.equal(uploads, 0);
  const id = await call();
  await replayable(data.recordingId);
  await workers[1].processPending();
  assert.equal((await state(data.recordingId)).call_session_seq, id);
  assert.equal((await state(data.recordingId)).processing_status, 'PROCESSED');
});

test('matching refuses ambiguous candidates, a wrong phone and timestamps outside the window', async () => {
  const data = payload();
  await call('01098880002', 0);
  await call('01098880001', 31);
  await receipt(data);
  await workers[0].processPending();
  assert.equal((await state(data.recordingId)).call_session_seq, null);
  await call('01098880001', 1);
  await call('01098880001', 10);
  await replayable(data.recordingId);
  await workers[0].processPending();
  assert.equal((await state(data.recordingId)).call_session_seq, null);
  assert.equal(uploads, 0);
});

test('S3 failure preserves the assigned call and retries without creating a recording row', async () => {
  const id = await call(),
    data = payload();
  await receipt(data);
  const goodSave = saving;
  saving = async () => {
    throw new Error('storage unavailable; private-url-must-not-be-logged');
  };
  await workers[0].processPending();
  const failed = await state(data.recordingId);
  assert.equal(failed.processing_status, 'FAILED');
  assert.equal(failed.call_session_seq, id);
  assert.equal(failed.recordings, 0);
  await call('01098880001', 1);
  saving = goodSave;
  await replayable(data.recordingId);
  await workers[1].processPending();
  assert.equal((await state(data.recordingId)).call_session_seq, id);
  assert.equal((await state(data.recordingId)).processing_status, 'PROCESSED');
});

test('S3 success followed by a DB failure rolls back the reference and reuses the object after restart', async () => {
  const id = await call(),
    data = payload();
  await receipt(data);
  await pool.query(`CREATE FUNCTION recording_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.processing_status='PROCESSED' THEN RAISE EXCEPTION 'injected persistence failure'; END IF;
    RETURN NEW; END $$;
    CREATE TRIGGER recording_test_failure BEFORE UPDATE ON pbx_webhooks.call_ended_events FOR EACH ROW EXECUTE FUNCTION recording_test_fail()`);
  try {
    await workers[0].processPending();
  } finally {
    await pool.query(
      'DROP TRIGGER recording_test_failure ON pbx_webhooks.call_ended_events; DROP FUNCTION recording_test_fail()',
    );
  }
  assert.equal(uploads, 1);
  assert.equal((await state(data.recordingId)).recordings, 0);
  assert.equal((await state(data.recordingId)).processing_status, 'FAILED');
  await replayable(data.recordingId);
  await workers[1].processPending();
  assert.equal((await state(data.recordingId)).call_session_seq, id);
  assert.equal((await state(data.recordingId)).recordings, 1);
  assert.equal(uploads, 1);
});

test('only one application instance processes the durable queue at a time', async () => {
  await call();
  const data = payload();
  await receipt(data);
  const original = saving;
  let entered, release;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  saving = async (...args) => {
    entered();
    await wait;
    return original(...args);
  };
  const first = workers[0].processPending();
  await started;
  try {
    await workers[1].processPending();
    assert.equal((await state(data.recordingId)).recordings, 0);
  } finally {
    release();
  }
  await first;
  assert.equal(uploads, 1);
  assert.equal((await state(data.recordingId)).recordings, 1);
});

test('disabled S3 and recent receipts remain durable; retry cooldown does not starve later events', async () => {
  await call();
  const first = payload();
  await receipt(first);
  apps[0].get(ConfigService).set('S3_RECORDINGS_BUCKET', '');
  try {
    await workers[0].processPending();
    assert.equal((await state(first.recordingId)).last_attempt_at, null);
  } finally {
    apps[0].get(ConfigService).set('S3_RECORDINGS_BUCKET', 'test-recordings');
  }
  await pool.query(
    'UPDATE pbx_webhooks.call_ended_events SET received_at=clock_timestamp() WHERE recording_id=$1',
    [first.recordingId],
  );
  await workers[0].processPending();
  assert.equal(uploads, 0);
  const later = payload();
  later.callFrom = '01098880003';
  await call(later.callFrom);
  await receipt(later);
  await workers[0].processPending();
  assert.equal((await state(later.recordingId)).processing_status, 'PROCESSED');
  assert.equal((await state(first.recordingId)).processing_status, 'RECEIVED');
});

test('PBX Swagger describes durable acknowledgment, authentication, routing and recording fields', async () => {
  const spec = await (await fetch(urls[0] + '/api/docs-json')).json();
  const operation = spec.paths['/webhooks/pbx/call-ended'].post;
  assert.deepEqual(operation.tags, ['PBX']);
  assert.deepEqual(operation.security, [{ bearer: [] }]);
  assert.deepEqual(
    operation.servers.map((server) => server.url),
    ['/api', '/'],
  );
  assert.match(operation.description, /비동기/);
  assert.equal(operation.requestBody.content['application/json'].schema.required.length, 7);
  assert.equal(
    operation.responses[200].content['application/json'].schema.properties.duplicate.type,
    'boolean',
  );
  for (const status of [400, 401, 409, 503]) assert.ok(operation.responses[status]);
});
