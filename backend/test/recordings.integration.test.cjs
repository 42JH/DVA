require('reflect-metadata');
const { before, beforeEach, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createTestPool, startTestApp, businessHeaders } = require('./helpers/application.cjs');
const { ConfigService } = require('@nestjs/config');
const { PbxRecordingWorker } = require('../dist/webhooks/pbx/pbx-recording.worker');
const { RecordingStorage } = require('../dist/webhooks/pbx/recording-storage');
const { DatabaseService } = require('../dist/database/database.service');
const { PbxWebhookRepository } = require('../dist/webhooks/pbx/pbx-webhook.repository');
const { RecordingProcessingError } = require('../dist/webhooks/pbx/recording-retry');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.DB_NAME, 'dva_webhook_test');
assert.ok(['db', '127.0.0.1'].includes(process.env.DB_HOST));
process.env.SWAGGER_ENABLED = 'false';
process.env.S3_RECORDINGS_BUCKET = '';
process.env.RECORDING_ALLOWED_HOSTS = 'recordings.example.test';
process.env.PBX_WEBHOOK_TOKEN = randomUUID();
const pool = createTestPool();
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
    'UPDATE pbx_webhooks.call_ended_events SET last_attempt_at=NULL,next_attempt_at=NULL WHERE recording_id=$1',
    [id],
  );
const state = async (id) =>
  (
    await pool.query(
      `SELECT processing_status,call_session_seq,last_attempt_at,attempt_count,next_attempt_at,last_error_code,requires_review,
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
    const app = await startTestApp(apps);
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

test('new AI intake and authenticated PBX receipt connect call times and the independent recording', async () => {
  const input = {
    phoneNumber: '01098880001',
    call: { providerCallId: randomUUID(), incomingAt: '2026-10-27T01:00:02Z' },
  };
  const registered = await fetch(urls[0] + '/api/customers/context', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...businessHeaders() },
    body: JSON.stringify(input),
  });
  assert.equal(registered.status, 200);
  const id = (await registered.json()).data.callSessionSeq;
  const close = () =>
    fetch(urls[0] + '/api/calls/' + id + '/order-intake/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...businessHeaders() },
      body: JSON.stringify({ expectedIntakeVersion: 1 }),
    });
  assert.equal((await (await close()).json()).data.status, 'WAITING_PBX');
  const order = { callSessionSeq: id, orderSeq: null };
  const data = payload();
  assert.deepEqual(await receipt(data), {
    status: 'received',
    recordingId: data.recordingId,
    duplicate: false,
  });
  assert.equal((await (await close()).json()).data.status, 'NO_ORDER');
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
      headers: { 'Content-Type': 'application/json', ...businessHeaders() },
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
    headers: { ...businessHeaders(), call_session_seq: String(callId) },
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
  assert.equal((await state(data.recordingId)).attempt_count, 0);
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
  assert.equal(
    await repo.failed(
      data.recordingId,
      first.claimId,
      new RecordingProcessingError('PROCESSING_UNAVAILABLE'),
      false,
    ),
    false,
  );
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

test('disabled recording downloads preserve receipts and retry cooldown does not starve later events', async () => {
  const first = payload();
  await receipt(first);
  // A call appearing after receipt still exercises the worker's fallback matching and cooldown.
  await call();
  const config = apps[0].get(ConfigService);
  const hosts = config.get('RECORDING_ALLOWED_HOSTS');
  config.set('S3_RECORDINGS_BUCKET', '');
  config.set('RECORDING_ALLOWED_HOSTS', []);
  try {
    await workers[0].processPending();
    assert.ok((await state(first.recordingId)).last_attempt_at);
    assert.ok((await state(first.recordingId)).call_session_seq);
    assert.equal((await state(first.recordingId)).recordings, 0);
    config.set('S3_RECORDINGS_BUCKET', 'test-recordings');
    assert.equal(stores[0].configured, false);
    assert.equal(uploads, 0);
  } finally {
    config.set('S3_RECORDINGS_BUCKET', 'test-recordings');
    config.set('RECORDING_ALLOWED_HOSTS', hosts);
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
    headers: { 'Content-Type': 'application/json', ...businessHeaders() },
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

test('transient recording errors retry five times with persisted backoff, then wait for review without blocking healthy receipts', async () => {
  await call();
  const data = payload();
  await receipt(data);
  const savedPayload = (
    await pool.query('SELECT payload FROM pbx_webhooks.call_ended_events WHERE recording_id=$1', [
      data.recordingId,
    ])
  ).rows[0].payload;
  let attempts = 0;
  const goodSave = saving;
  saving = async () => {
    attempts++;
    throw new RecordingProcessingError('SOURCE_NOT_FOUND');
  };
  const delays = [1, 5, 15, 30];
  for (let attempt = 1; attempt <= 5; attempt++) {
    await workers[attempt % 2].processPending();
    const failed = await state(data.recordingId);
    assert.equal(failed.attempt_count, attempt);
    assert.equal(attempts, attempt);
    assert.equal(failed.last_error_code, 'SOURCE_NOT_FOUND');
    assert.equal(failed.requires_review, attempt === 5);
    assert.equal(failed.recordings, 0);
    if (attempt < 5) {
      const seconds = (
        await pool.query(
          'SELECT extract(epoch FROM next_attempt_at-clock_timestamp())::float AS seconds FROM pbx_webhooks.call_ended_events WHERE recording_id=$1',
          [data.recordingId],
        )
      ).rows[0].seconds;
      assert.ok(seconds > delays[attempt - 1] * 60 - 5 && seconds <= delays[attempt - 1] * 60);
      await workers[0].processPending();
      assert.equal(attempts, attempt);
      await replayable(data.recordingId);
    } else assert.equal(failed.next_attempt_at, null);
  }
  assert.equal((await receipt(data)).duplicate, true);
  await replayable(data.recordingId);
  saving = goodSave;
  await workers[0].processPending();
  assert.equal((await state(data.recordingId)).requires_review, true);
  assert.equal(uploads, 0);
  assert.deepEqual(
    (
      await pool.query('SELECT payload FROM pbx_webhooks.call_ended_events WHERE recording_id=$1', [
        data.recordingId,
      ])
    ).rows[0].payload,
    savedPayload,
  );
  const healthy = payload();
  await receipt(healthy);
  await workers[1].processPending();
  assert.equal((await state(healthy.recordingId)).processing_status, 'PROCESSED');
  assert.equal(uploads, 1);
});

test('policy errors stop after one attempt, and an explicit review reset can resume the same receipt', async () => {
  const callId = await call();
  const data = payload();
  await receipt(data);
  const goodSave = saving;
  saving = async () => {
    throw new RecordingProcessingError('SOURCE_NOT_ALLOWED', false);
  };
  await workers[0].processPending();
  const held = await state(data.recordingId);
  assert.equal(held.attempt_count, 1);
  assert.equal(held.requires_review, true);
  assert.equal(held.next_attempt_at, null);
  assert.equal(held.last_error_code, 'SOURCE_NOT_ALLOWED');
  await replayable(data.recordingId);
  saving = goodSave;
  await workers[1].processPending();
  assert.equal(uploads, 0);
  const changed = await fetch(urls[0] + '/webhooks/pbx/call-ended', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.PBX_WEBHOOK_TOKEN}`,
    },
    body: JSON.stringify({ ...data, recordingUrl: 'https://recordings.example.test/changed.mp3' }),
  });
  assert.equal(changed.status, 409);
  const resumed = await pool.query(
    `UPDATE pbx_webhooks.call_ended_events SET attempt_count=0,next_attempt_at=NULL,last_error_code=NULL,requires_review=false,last_attempt_at=NULL,claim_id=NULL,claimed_until=NULL
    WHERE recording_id=$1 AND requires_review AND processing_status='FAILED' AND (claimed_until IS NULL OR claimed_until<=clock_timestamp()) RETURNING recording_id`,
    [data.recordingId],
  );
  assert.equal(resumed.rowCount, 1);
  await workers[1].processPending();
  const done = await state(data.recordingId);
  assert.equal(done.call_session_seq, callId);
  assert.equal(done.processing_status, 'PROCESSED');
  assert.equal(done.attempt_count, 1);
  assert.equal(done.last_error_code, null);
  assert.equal(done.next_attempt_at, null);
  assert.equal(done.requires_review, false);
  assert.equal(done.recordings, 1);
});

test('attempts survive worker crashes and a fifth interrupted attempt is held without a sixth storage call', async () => {
  const callId = await call();
  const data = payload();
  await receipt(data);
  const repo = apps[0].get(PbxWebhookRepository);
  let stale;
  for (let count = 1; count <= 5; count++) {
    const claim = await repo.next(true);
    assert.ok(claim);
    assert.equal(claim.attemptCount, count - 1);
    assert.equal(await repo.match(data, 30, claim.claimId), callId);
    assert.equal(await repo.startAttempt(data.recordingId, claim.claimId), true);
    if (stale) {
      assert.equal(await repo.startAttempt(data.recordingId, stale), false);
      assert.equal(
        await repo.failed(
          data.recordingId,
          stale,
          new RecordingProcessingError('PROCESSING_UNAVAILABLE'),
          true,
        ),
        false,
      );
    }
    stale = claim.claimId;
    await pool.query(
      "UPDATE pbx_webhooks.call_ended_events SET claimed_until=clock_timestamp()-interval '1 second',last_attempt_at=NULL,next_attempt_at=NULL WHERE recording_id=$1",
      [data.recordingId],
    );
  }
  await workers[1].processPending();
  const held = await state(data.recordingId);
  assert.equal(held.attempt_count, 5);
  assert.equal(held.requires_review, true);
  assert.equal(held.last_error_code, 'ATTEMPT_INTERRUPTED');
  assert.equal(uploads, 0);
  await workers[0].processPending();
  assert.deepEqual(await state(data.recordingId), held);
});
