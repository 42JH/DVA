const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { NestFactory } = require('@nestjs/core');
const { Pool } = require('pg');

// The runner creates a disposable PostgreSQL container. Never run this against production.
assert.equal(process.env.DB_NAME, 'dva_webhook_test');
assert.equal(process.env.NODE_ENV, 'test');
assert.ok(['db', '127.0.0.1'].includes(process.env.DB_HOST));
const token = randomBytes(32).toString('hex');
process.env.PBX_WEBHOOK_TOKEN = token;
const { AppModule } = require('../dist/app.module');
const { configureApplication } = require('../dist/configure-application');
let app, base, pool;
const payload = {
  recordingId: 'test-call-1',
  callFrom: '01000000000',
  callTo: '07000000000',
  startedAt: '2026-10-23T00:00:00Z',
  endedAt: '2026-10-23T00:03:00Z',
  durationSeconds: 180,
  recordingUrl: 'https://example.invalid/recordings/test.mp3?signature=test-only',
};

before(async () => {
  pool = new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  for (let attempt = 0; ; attempt++) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch (error) {
      if (attempt >= 30) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  app = await NestFactory.create(AppModule, { logger: false });
  configureApplication(app, { log: () => {} });
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});
after(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
});

async function post(body, credential = token) {
  return fetch(`${base}/webhooks/pbx/call-ended`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(credential === null ? {} : { Authorization: `Bearer ${credential}` }),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
}
async function count(id) {
  return Number(
    (
      await pool.query(
        'SELECT count(*) FROM pbx_webhooks.call_ended_events WHERE recording_id=$1',
        [id],
      )
    ).rows[0].count,
  );
}

test('unauthenticated and incorrect credentials never write a receipt', async () => {
  assert.equal((await post(payload, null)).status, 401);
  assert.equal((await post(payload, 'incorrect')).status, 401);
  assert.equal(await count(payload.recordingId), 0);
});

test('missing token configuration fails closed', async () => {
  delete process.env.PBX_WEBHOOK_TOKEN;
  try {
    assert.equal((await post(payload)).status, 503);
  } finally {
    process.env.PBX_WEBHOOK_TOKEN = token;
  }
  assert.equal(await count(payload.recordingId), 0);
});

test('invalid fields, calendar dates, chronology and URLs reject without persistence', async () => {
  for (const input of [
    null,
    [],
    {},
    { ...payload, recordingId: ' ' },
    { ...payload, callTo: 'not-a-number' },
    { ...payload, durationSeconds: -1 },
    { ...payload, durationSeconds: 1.5 },
    { ...payload, durationSeconds: '180' },
    { ...payload, startedAt: '2026-02-30T00:00:00Z' },
    { ...payload, startedAt: '2026-10-23T00:00:00' },
    { ...payload, endedAt: '2026-10-22T00:00:00Z' },
    { ...payload, recordingUrl: 'http://example.invalid/audio.mp3' },
    { ...payload, recordingUrl: 'https://user:password@example.invalid/audio.mp3' },
    { ...payload, recordingUrl: 'https://example.invalid/audio.mp3#fragment' },
  ]) {
    const response = await post(input);
    assert.equal(response.status, 400);
  }
  assert.equal(await count(payload.recordingId), 0);
});

test('durable receipt, idempotent retries and conflicting reuse of an ID', async () => {
  const first = await post(payload);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), {
    status: 'received',
    recordingId: payload.recordingId,
    duplicate: false,
  });
  const stored = (
    await pool.query(
      'SELECT payload, processing_status FROM pbx_webhooks.call_ended_events WHERE recording_id=$1',
      [payload.recordingId],
    )
  ).rows[0];
  assert.equal(stored.payload.recordingUrl, payload.recordingUrl);
  assert.equal(stored.payload.callTo, payload.callTo);
  assert.equal(stored.processing_status, 'RECEIVED');
  const retry = await post({
    ...payload,
    startedAt: '2026-10-23T09:00:00+09:00',
    providerExtra: true,
  });
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).duplicate, true);
  assert.equal((await post({ ...payload, callTo: '07011111111' })).status, 409);
  assert.equal(await count(payload.recordingId), 1);
});

test('concurrent delivery creates exactly one receipt', async () => {
  const input = { ...payload, recordingId: 'concurrent-call' };
  const responses = await Promise.all(Array.from({ length: 12 }, () => post(input)));
  assert.ok(responses.every((response) => response.status === 200));
  const bodies = await Promise.all(responses.map((response) => response.json()));
  assert.equal(bodies.filter((body) => !body.duplicate).length, 1);
  assert.equal(await count(input.recordingId), 1);
});

test('storage failure returns retryable 503 without exposing phone or signed URL', async () => {
  await pool.query(
    'ALTER TABLE pbx_webhooks.call_ended_events RENAME TO call_ended_events_unavailable',
  );
  try {
    const response = await post({ ...payload, recordingId: 'failed-call' });
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.ok(!text.includes(payload.callFrom) && !text.includes(payload.recordingUrl));
  } finally {
    await pool.query(
      'ALTER TABLE pbx_webhooks.call_ended_events_unavailable RENAME TO call_ended_events',
    );
  }
  assert.equal(await count('failed-call'), 0);
});

test('receipt survives backend restart and startup migration can run twice', async () => {
  await app.close();
  app = await NestFactory.create(AppModule, { logger: false });
  configureApplication(app, { log: () => {} });
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  const response = await post(payload);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).duplicate, true);
});
