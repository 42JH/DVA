require('reflect-metadata');
const { before, beforeEach, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { NestFactory } = require('@nestjs/core');
const { ConfigService } = require('@nestjs/config');
const { PbxRecordingWorker } = require('../dist/webhooks/pbx/pbx-recording.worker');
const { RecordingStorage } = require('../dist/webhooks/pbx/recording-storage');
const { DatabaseService } = require('../dist/database/database.service');
const { PbxWebhookRepository } = require('../dist/webhooks/pbx/pbx-webhook.repository');
const { ConsultationsRepository } = require('../dist/consultations/consultations.repository');
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

test('call context without an order is matched to its recording and retries never reopen the call', async () => {
  const input = {
    phoneNumber: '01098880001',
    call: { providerCallId: randomUUID(), incomingAt: '2026-10-27T01:00:02Z' },
  };
  const start = () =>
    fetch(urls[0] + '/api/customers/context', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  const response = await start();
  assert.equal(response.status, 200);
  const callId = (await response.json()).data.callSessionSeq;
  const data = payload();
  await receipt(data);
  await workers[0].processPending();
  const stored = await state(data.recordingId);
  assert.equal(stored.processing_status, 'PROCESSED');
  assert.equal(stored.call_session_seq, callId);
  assert.equal(stored.recordings, 1);
  assert.equal(uploads, 1);
  const session = async () =>
    (
      await pool.query(
        'SELECT order_seq,started_at,ended_at FROM call_sessions WHERE call_session_seq=$1',
        [callId],
      )
    ).rows[0];
  const ended = await session();
  assert.equal(ended.order_seq, null);
  assert.equal(ended.ended_at.toISOString(), '2026-10-27T01:03:00.000Z');
  const repeated = await start();
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).data.callSessionSeq, callId);
  assert.deepEqual(await session(), ended);
  const orders = await fetch(urls[0] + '/api/orders', {
    headers: { call_session_seq: String(callId) },
  });
  assert.equal(orders.status, 409);
  await workers[1].processPending();
  assert.equal(uploads, 1);
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

test('two instances never upload the same live claim and storage I/O holds no pool connection', async () => {
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
    const connections = apps[0].get(DatabaseService).pool;
    assert.equal(connections.totalCount - connections.idleCount, 0);
    await workers[1].processPending();
    assert.equal((await state(data.recordingId)).recordings, 0);
  } finally {
    release();
  }
  await first;
  assert.equal(uploads, 1);
  assert.equal((await state(data.recordingId)).recordings, 1);
});

test('a different receipt progresses while another instance waits for storage', async () => {
  await call();
  const firstData = payload();
  await receipt(firstData);
  const original = saving;
  let entered, release;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  saving = async (...args) => {
    if (args[0] === firstData.recordingId) {
      entered();
      await wait;
    }
    return original(...args);
  };
  const first = workers[0].processPending();
  await started;
  try {
    const second = { ...payload(), callFrom: '01098880004' };
    await call(second.callFrom);
    await receipt(second);
    await workers[1].processPending();
    assert.equal((await state(second.recordingId)).processing_status, 'PROCESSED');
    assert.equal((await state(firstData.recordingId)).recordings, 0);
  } finally {
    release();
    await first;
  }
  assert.equal(uploads, 2);
});

test('expired claims recover and stale completion, failure and release cannot replace a new owner', async () => {
  const callId = await call(),
    data = payload();
  await receipt(data);
  const repo = apps[0].get(PbxWebhookRepository);
  const first = await repo.next(true);
  assert.equal(await repo.next(true), undefined);
  assert.equal(await repo.match(data, 30, first.claimId), callId);
  await pool.query(
    "UPDATE pbx_webhooks.call_ended_events SET claimed_until=clock_timestamp()-interval '1 second',last_attempt_at=clock_timestamp()-interval '6 minutes' WHERE recording_id=$1",
    [data.recordingId],
  );
  assert.equal(
    await repo.processed(data.recordingId, callId, 'recordings/stale', first.claimId),
    false,
  );
  const second = await repo.next(true);
  assert.notEqual(second.claimId, first.claimId);
  await repo.failed(data.recordingId, first.claimId);
  await repo.release(data.recordingId, first.claimId);
  assert.equal(await repo.match(data, 30, first.claimId), null);
  assert.equal(
    await repo.processed(data.recordingId, callId, 'recordings/stale', first.claimId),
    false,
  );
  assert.equal((await state(data.recordingId)).recordings, 0);
  assert.equal(
    await repo.processed(
      data.recordingId,
      callId,
      'recordings/current-' + randomUUID(),
      second.claimId,
    ),
    true,
  );
  assert.equal((await state(data.recordingId)).processing_status, 'PROCESSED');
  assert.equal((await state(data.recordingId)).recordings, 1);
  await assert.rejects(
    pool.query('UPDATE pbx_webhooks.call_ended_events SET claim_id=$2 WHERE recording_id=$1', [
      data.recordingId,
      randomUUID(),
    ]),
    (error) => error.code === '23514',
  );
});

test('a date-filtered call is readable before upload and receives its recording on the same call after upload', async () => {
  const id = await call('01098880001', 2);
  const repository = apps[0].get(ConsultationsRepository);
  const query = {
    callerPhoneNumber: '01098880001',
    from: '2026-10-27T01:00:00Z',
    to: '2026-10-27T01:01:00Z',
    limit: 100,
    offset: 0,
  };
  const read = async () =>
    (await repository.findMany(query)).rows.find((row) => row.callSessionSeq === id);
  assert.equal((await read()).startedAt.toISOString(), '2026-10-27T01:00:02.000Z');
  assert.deepEqual(await repository.findRecordings(id), []);
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
  const pending = workers[0].processPending();
  await started;
  try {
    const row = await read();
    assert.equal(row.callSessionSeq, id);
    assert.equal(row.startedAt.toISOString(), '2026-10-27T01:00:00.000Z');
    assert.deepEqual(await repository.findRecordings(id), []);
  } finally {
    release();
  }
  await pending;
  assert.equal((await read()).callSessionSeq, id);
  assert.equal((await repository.findRecordings(id)).length, 1);
  assert.equal(uploads, 1);
});

test('disabled S3 and recent receipts remain durable; retry cooldown does not starve later events', async () => {
  await call();
  const first = payload();
  await receipt(first);
  apps[0].get(ConfigService).set('S3_RECORDINGS_BUCKET', '');
  try {
    await workers[0].processPending();
    assert.ok((await state(first.recordingId)).last_attempt_at);
    assert.ok((await state(first.recordingId)).call_session_seq);
    assert.equal((await state(first.recordingId)).recordings, 0);
    assert.equal(uploads, 0);
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

test('unregistered calls leave no call, audit or recording and unmatched PBX receipts expire after 30 minutes', async () => {
  const data = { ...payload(), callFrom: '01098889999' };
  const counts = async () =>
    (
      await pool.query(`SELECT (SELECT count(*) FROM call_sessions) AS calls,
      (SELECT count(*) FROM audit_logs) AS audits, (SELECT count(*) FROM recordings) AS recordings,
      (SELECT count(*) FROM empty_ai_order_results) AS empty_results`)
    ).rows[0];
  const before = await counts();
  const initial = await fetch(urls[0] + '/api/customers/context', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber: data.callFrom }),
  });
  assert.equal(initial.status, 200);
  assert.equal(Object.hasOwn((await initial.json()).data, 'callSessionSeq'), false);
  await receipt(data);
  await pool.query(
    "UPDATE pbx_webhooks.call_ended_events SET received_at=clock_timestamp()-interval '29 minutes 50 seconds' WHERE recording_id=$1",
    [data.recordingId],
  );
  await workers[0].processPending();
  assert.equal((await state(data.recordingId)).processing_status, 'RECEIVED');
  assert.equal(uploads, 0);
  await pool.query(
    "UPDATE pbx_webhooks.call_ended_events SET received_at=clock_timestamp()-interval '30 minutes' WHERE recording_id=$1",
    [data.recordingId],
  );
  await workers[0].processPending();
  assert.equal(await state(data.recordingId), undefined);
  assert.deepEqual(await counts(), before);
  await workers[1].processPending();
  assert.equal(uploads, 0);
});

test('expired unmatched receipts are removed with S3 disabled while registered orderless calls are retained', async () => {
  const unmatched = { ...payload(), callFrom: '01098889998' };
  const matched = payload();
  const callId = await call();
  await receipt(unmatched);
  await receipt(matched);
  await pool.query(
    "UPDATE pbx_webhooks.call_ended_events SET received_at=clock_timestamp()-interval '31 minutes'",
  );
  const config = apps[0].get(ConfigService);
  config.set('S3_RECORDINGS_BUCKET', '');
  try {
    await workers[0].processPending();
    assert.equal(await state(unmatched.recordingId), undefined);
    assert.equal((await state(matched.recordingId)).call_session_seq, callId);
    assert.equal((await state(matched.recordingId)).processing_status, 'RECEIVED');
    assert.equal(uploads, 0);
    const attempted = (await state(matched.recordingId)).last_attempt_at;
    await replayable(matched.recordingId);
    await workers[0].processPending();
    assert.equal((await state(matched.recordingId)).last_attempt_at, null);
    assert.ok(attempted);
  } finally {
    config.set('S3_RECORDINGS_BUCKET', 'test-recordings');
  }
  await workers[0].processPending();
  assert.equal((await state(matched.recordingId)).processing_status, 'PROCESSED');
  assert.equal(uploads, 1);
});

test('application bootstrap cleans expired unmatched receipts even with S3 disabled', async () => {
  const data = { ...payload(), callFrom: '01098889994' };
  await receipt(data);
  await pool.query(
    "UPDATE pbx_webhooks.call_ended_events SET received_at=clock_timestamp()-interval '31 minutes' WHERE recording_id=$1",
    [data.recordingId],
  );
  const app = await NestFactory.create(AppModule, { logger: false });
  app.get(ConfigService).set('S3_RECORDINGS_BUCKET', '');
  try {
    await app.init();
  } finally {
    await app.close();
  }
  assert.equal(await state(data.recordingId), undefined);
  assert.equal(uploads, 0);
});

test('linked S3 failures older than 30 minutes keep their receipt and retry on the same call', async () => {
  const callId = await call();
  const data = payload();
  await receipt(data);
  await pool.query(
    "UPDATE pbx_webhooks.call_ended_events SET received_at=clock_timestamp()-interval '1 day' WHERE recording_id=$1",
    [data.recordingId],
  );
  const goodSave = saving;
  saving = async () => {
    throw new Error('storage unavailable');
  };
  await workers[0].processPending();
  assert.equal((await state(data.recordingId)).processing_status, 'FAILED');
  assert.equal((await state(data.recordingId)).call_session_seq, callId);
  saving = goodSave;
  await replayable(data.recordingId);
  await workers[1].processPending();
  assert.equal((await state(data.recordingId)).processing_status, 'PROCESSED');
  assert.equal(uploads, 1);
});

test('expiry cannot remove a live claim or a receipt claimed by another worker', async () => {
  const data = { ...payload(), callFrom: '01098889997' };
  await receipt(data);
  await pool.query(
    "UPDATE pbx_webhooks.call_ended_events SET received_at=clock_timestamp()-interval '31 minutes' WHERE recording_id=$1",
    [data.recordingId],
  );
  const repo = apps[0].get(PbxWebhookRepository);
  const first = await repo.next(true);
  await workers[1].processPending();
  assert.ok(await state(data.recordingId));
  await pool.query(
    "UPDATE pbx_webhooks.call_ended_events SET claimed_until=clock_timestamp()-interval '1 second' WHERE recording_id=$1",
    [data.recordingId],
  );
  const second = await repo.next(true);
  assert.notEqual(second.claimId, first.claimId);
  await repo.discardExpired(data.recordingId, first.claimId);
  assert.ok(await state(data.recordingId));
  await repo.discardExpired(data.recordingId, second.claimId);
  assert.equal(await state(data.recordingId), undefined);
});

test('unmatched corrupt or conflicting historical receipts also expire without blocking later valid recordings', async () => {
  const corrupt = { ...payload(), callFrom: '01098889996' };
  await receipt(corrupt);
  await pool.query(
    "UPDATE pbx_webhooks.call_ended_events SET payload='{}'::jsonb,received_at=clock_timestamp()-interval '31 minutes' WHERE recording_id=$1",
    [corrupt.recordingId],
  );
  const conflictId = await call();
  await pool.query(
    "UPDATE call_sessions SET started_at='2026-10-27T01:00:00Z',ended_at='2026-10-27T01:02:00Z' WHERE call_session_seq=$1",
    [conflictId],
  );
  const conflicting = payload();
  await receipt(conflicting);
  await pool.query(
    "UPDATE pbx_webhooks.call_ended_events SET received_at=clock_timestamp()-interval '31 minutes' WHERE recording_id=$1",
    [conflicting.recordingId],
  );
  const valid = { ...payload(), callFrom: '01098889995' };
  await call(valid.callFrom);
  await receipt(valid);
  await workers[0].processPending();
  assert.equal(await state(corrupt.recordingId), undefined);
  assert.equal(await state(conflicting.recordingId), undefined);
  assert.equal((await state(valid.recordingId)).processing_status, 'PROCESSED');
  assert.equal(uploads, 1);
});
