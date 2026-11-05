require('reflect-metadata');
const { before, beforeEach, afterEach, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomInt, randomUUID } = require('node:crypto');
const { EventEmitter, once } = require('node:events');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createTestPool, startTestApp, businessHeaders } = require('./helpers/application.cjs');
const { NestFactory } = require('@nestjs/core');
const { migrate } = require('./helpers/migrations.cjs');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.DB_NAME, 'dva_webhook_test');
assert.ok(['db', '127.0.0.1'].includes(process.env.DB_HOST));
process.env.SWAGGER_ENABLED = 'true';
process.env.S3_RECORDINGS_BUCKET = '';
process.env.CORS_ORIGINS = 'http://localhost:5173';
process.env.PBX_WEBHOOK_TOKEN = randomBytes(32).toString('hex');
const { AppModule } = require('../dist/app.module');
const { configureApplication } = require('../dist/configure-application');
const { hashPassword } = require('../dist/auth/password');
const { ConsultationsRepository } = require('../dist/consultations/consultations.repository');
const { ActiveCallCountService } = require('../dist/consultations/active-call-count.service');
const { PbxWebhookRepository } = require('../dist/webhooks/pbx/pbx-webhook.repository');
const pool = createTestPool();
const apps = [],
  urls = [],
  connections = [];
const origin = 'http://localhost:5173';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const logs = [];
let operator, passwordHash, cookie;
const identity = () => ({
  phoneNumber: '010' + randomInt(10000000, 100000000),
  call: {
    providerCallId: 'active-' + randomUUID(),
    incomingAt: new Date(Date.now() - 60000).toISOString(),
  },
});
async function json(path, options = {}, instance = 0) {
  const response = await fetch(urls[instance] + path, {
    signal: AbortSignal.timeout(15000),
    ...options,
    headers: {
      ...(path === '/api/customers/context' ? businessHeaders() : {}),
      ...options.headers,
    },
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? JSON.parse(text) : undefined,
  };
}
async function login(user = operator) {
  const result = await json('/api/auth/login', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ loginId: user.loginId, password: 'active-count-test-password' }),
  });
  assert.equal(result.status, 200);
  return result.headers.get('set-cookie').split(';')[0];
}
async function account(role = 'OPERATOR') {
  const loginId = 'ac' + randomUUID().replaceAll('-', '').slice(0, 16);
  const result = await pool.query(
    "INSERT INTO admin_users(login_id,name,password_hash,role,status) VALUES($1,'활성 통화 테스트',$2,$3,'ACTIVE') RETURNING admin_user_seq",
    [loginId, passwordHash, role],
  );
  return { id: result.rows[0].admin_user_seq, loginId };
}
async function register(input = identity(), instance = 0) {
  const result = await json(
    '/api/customers/context',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
    instance,
  );
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return { input, id: result.body.data.callSessionSeq };
}
function ending(input, overrides = {}) {
  const startedAt = new Date(input.call.incomingAt).toISOString();
  return {
    recordingId: 'active-recording-' + randomUUID(),
    callFrom: input.phoneNumber,
    callTo: '07012345678',
    startedAt,
    endedAt: new Date(Date.parse(startedAt) + 30000).toISOString(),
    durationSeconds: 30,
    recordingUrl: 'https://recordings.example.invalid/test.mp3?signed=private-test',
    ...overrides,
  };
}
async function receipt(payload, instance = 0) {
  return json(
    '/webhooks/pbx/call-ended',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + process.env.PBX_WEBHOOK_TOKEN,
      },
      body: JSON.stringify(payload),
    },
    instance,
  );
}
async function count(instance = 0, session = cookie) {
  const result = await json(
    '/api/calls/active-count',
    { headers: session ? { Cookie: session } : {} },
    instance,
  );
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(Object.keys(result.body).sort(), ['data', 'meta']);
  assert.equal(typeof result.body.data.activeCallCount, 'number');
  assert.ok(Number.isFinite(Date.parse(result.body.data.observedAt)));
  return result.body.data.activeCallCount;
}
async function stream(instance = 1) {
  const controller = new AbortController();
  const response = await fetch(urls[instance] + '/api/calls/active-count/stream', {
    headers: { Cookie: cookie, Origin: origin },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  const reader = response.body.getReader();
  let buffer = '';
  const decoder = new TextDecoder();
  const connection = {
    close: () => {
      controller.abort();
      return reader.cancel().catch(() => {});
    },
    async next(type = 'active-call-count', timeout = 8000) {
      let timer;
      try {
        return await Promise.race([
          (async () => {
            for (;;) {
              let boundary = buffer.indexOf('\n\n');
              while (boundary >= 0) {
                const frame = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);
                const name = frame
                  .split('\n')
                  .find((line) => line.startsWith('event:'))
                  ?.slice(6)
                  .trim();
                const data = frame
                  .split('\n')
                  .filter((line) => line.startsWith('data:'))
                  .map((line) => line.slice(5).trim())
                  .join('\n');
                if (name === type && data) return JSON.parse(data);
                boundary = buffer.indexOf('\n\n');
              }
              const chunk = await reader.read();
              if (chunk.done) throw new Error('SSE closed before expected event: ' + type);
              buffer += decoder.decode(chunk.value, { stream: true }).replaceAll('\r\n', '\n');
            }
          })(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Timed out waiting for SSE: ' + type)),
              timeout,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    async until(value, timeout = 8000) {
      const deadline = Date.now() + timeout;
      for (;;) {
        const event = await connection.next(
          'active-call-count',
          Math.max(1, deadline - Date.now()),
        );
        assert.deepEqual(Object.keys(event).sort(), ['activeCallCount', 'observedAt']);
        if (event.activeCallCount === value) return event;
      }
    },
  };
  connections.push(connection);
  return connection;
}
before(async () => {
  await migrate(pool);
  passwordHash = await hashPassword('active-count-test-password');
  for (let index = 0; index < 2; index++) {
    const app = await startTestApp(apps, { log: (entry) => logs.push(entry) });
    urls.push(await app.getUrl());
  }
  operator = await account();
});
beforeEach(async () => {
  // Guarded disposable DB: previous suites' synthetic calls represent pre-feature history here.
  await pool.query('UPDATE call_sessions SET registered_at=NULL WHERE registered_at IS NOT NULL');
  await pool.query('DELETE FROM pbx_webhooks.call_ended_events');
  await pool.query("UPDATE admin_users SET status='ACTIVE' WHERE admin_user_seq=$1", [operator.id]);
  cookie = await login();
});
afterEach(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
});
after(async () => {
  for (const app of apps) await app.close();
  await pool.end();
});

test('migration excludes actual pre-feature rows, tracks new inserts and preserves historical call times', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DROP INDEX pbx_webhooks.call_ended_unlinked_identity_idx');
    await client.query('ALTER TABLE call_sessions DROP COLUMN registered_at');
    const old = (
      await client.query(
        'INSERT INTO call_sessions(provider_call_id) VALUES($1) RETURNING call_session_seq',
        ['active-legacy-' + randomUUID()],
      )
    ).rows[0].call_session_seq;
    await client.query(
      readFileSync(join(__dirname, '../migrations/044-active-call-count.sql'), 'utf8'),
    );
    const legacy = (
      await client.query(
        'SELECT registered_at,started_at,ended_at FROM call_sessions WHERE call_session_seq=$1',
        [old],
      )
    ).rows[0];
    assert.deepEqual(legacy, { registered_at: null, started_at: null, ended_at: null });
    const added = (
      await client.query(
        'INSERT INTO call_sessions(provider_call_id) VALUES($1) RETURNING registered_at',
        ['active-new-' + randomUUID()],
      )
    ).rows[0];
    assert.ok(added.registered_at instanceof Date);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('read-only caller lookup and legacy unknown calls do not enter the count; registration and replay count once', async () => {
  assert.equal(await count(), 0);
  const input = identity();
  assert.equal(
    (
      await json('/api/customers/context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: input.phoneNumber }),
      })
    ).status,
    200,
  );
  await pool.query('INSERT INTO call_sessions(provider_call_id,registered_at) VALUES($1,NULL)', [
    'legacy-' + randomUUID(),
  ]);
  assert.equal(await count(), 0);
  const first = await register(input);
  const replay = await register(input);
  assert.equal(first.id, replay.id);
  assert.equal(await count(1), 1);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM audit_logs WHERE action='CALL_STARTED' AND target_seq=$1",
        [first.id],
      )
    ).rows[0].n,
    1,
  );
});

test('counting uses the active partial index when closed and pre-feature history grows', async (context) => {
  const prefix = 'active-history-' + randomUUID() + '-';
  try {
    await pool.query(
      `INSERT INTO call_sessions(provider_call_id,registered_at,started_at,ended_at)
       SELECT $1 || n,CASE WHEN n<=20000 OR n>30000 THEN clock_timestamp() END,
         CASE WHEN n<=20000 THEN '2026-01-01T00:00:00Z'::timestamptz END,
         CASE WHEN n<=20000 THEN '2026-01-01T00:01:00Z'::timestamptz END
       FROM generate_series(1,30125) n`,
      [prefix],
    );
    await pool.query('ANALYZE call_sessions');
    assert.equal(await count(), 125);
    const plan = (
      await pool.query(
        'EXPLAIN (ANALYZE,FORMAT JSON) SELECT count(*)::int FROM call_sessions WHERE registered_at IS NOT NULL AND ended_at IS NULL',
      )
    ).rows[0]['QUERY PLAN'][0];
    assert.match(JSON.stringify(plan.Plan), /call_sessions_active_count_idx/);
    context.diagnostic(
      `30,000 historical rows / 125 active: ${plan['Execution Time']} ms DB query`,
    );
  } finally {
    await pool.query('DELETE FROM call_sessions WHERE provider_call_id LIKE $1', [prefix + '%']);
    await pool.query('ANALYZE call_sessions');
  }
});

test('PBX receipt ends a registered call before worker delay or S3 upload; replay does not decrease twice', async () => {
  const call = await register();
  const payload = ending(call.input);
  const accepted = await receipt(payload);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.duplicate, false);
  assert.equal(await count(), 0);
  const row = (
    await pool.query('SELECT ended_at FROM call_sessions WHERE call_session_seq=$1', [call.id])
  ).rows[0];
  assert.equal(row.ended_at.toISOString(), payload.endedAt);
  assert.equal((await receipt(payload)).body.duplicate, true);
  assert.equal(await count(), 0);
  assert.equal(
    (
      await pool.query('SELECT count(*)::int AS n FROM recordings WHERE call_session_seq=$1', [
        call.id,
      ])
    ).rows[0].n,
    0,
  );
});

test('a receipt arriving first is reconciled within registration, including Korean international phone notation', async () => {
  for (const prefix of ['', '+82', '0082']) {
    const input = identity();
    const payload = ending(input, {
      callFrom: prefix ? prefix + input.phoneNumber.slice(1) : input.phoneNumber,
    });
    assert.equal((await receipt(payload)).status, 200);
    const call = await register(input);
    const event = (
      await pool.query(
        'SELECT call_session_seq FROM pbx_webhooks.call_ended_events WHERE recording_id=$1',
        [payload.recordingId],
      )
    ).rows[0];
    assert.equal(event.call_session_seq, call.id);
    assert.equal(await count(), 0);
  }
});

test('simultaneous registration and receipt converge without deadlocks or duplicate calls', async () => {
  const inputs = Array.from({ length: 12 }, identity);
  const results = await Promise.all(
    inputs.map(async (input, index) => {
      const payload = ending(input);
      const [call, received, replay] = await Promise.all([
        register(input, index % 2),
        receipt(payload, (index + 1) % 2),
        register(input, (index + 1) % 2),
      ]);
      assert.equal(received.status, 200);
      assert.equal(call.id, replay.id);
      return call;
    }),
  );
  assert.equal(new Set(results.map((row) => row.id)).size, inputs.length);
  assert.equal(await count(), 0);
});

test('unregistered and ambiguous receipts do not decrease unrelated calls, and a conflicting replay remains 409', async () => {
  const first = await register();
  const second = await register({
    ...first.input,
    call: { ...first.input.call, providerCallId: 'active-' + randomUUID() },
  });
  const ambiguous = ending(first.input);
  assert.equal((await receipt(ambiguous)).status, 200);
  assert.equal(await count(), 2);
  assert.equal((await receipt({ ...ambiguous, durationSeconds: 31 })).status, 409);
  assert.equal((await receipt(ending(identity()))).status, 200);
  assert.equal(await count(), 2);
  assert.notEqual(first.id, second.id);
});

test('a bad historical receipt does not prevent a later valid receipt from closing a newly registered call', async () => {
  const input = identity();
  const good = ending(input);
  await pool.query(
    'INSERT INTO pbx_webhooks.call_ended_events(recording_id,payload) VALUES($1,$2)',
    ['corrupt-' + randomUUID(), JSON.stringify({ ...good, durationSeconds: 'invalid' })],
  );
  assert.equal((await receipt(good)).status, 200);
  await register(input);
  assert.equal(await count(), 0);
});

test('a durable receipt survives immediate matching failure and duplicate delivery can repair the call', async () => {
  const call = await register();
  const repository = apps[0].get(PbxWebhookRepository);
  const original = repository.matchReceived;
  repository.matchReceived = async () => {
    throw new Error('private database failure');
  };
  const payload = ending(call.input);
  try {
    assert.equal((await receipt(payload)).status, 200);
  } finally {
    repository.matchReceived = original;
  }
  assert.equal(await count(), 1);
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::int AS n FROM pbx_webhooks.call_ended_events WHERE recording_id=$1',
        [payload.recordingId],
      )
    ).rows[0].n,
    1,
  );
  assert.equal((await receipt(payload)).body.duplicate, true);
  assert.equal(await count(), 0);
});

test('a final NO_ORDER AI result after PBX completion preserves the closed call and creates no order', async () => {
  const call = await register();
  assert.equal((await receipt(ending(call.input))).status, 200);
  const result = await json('/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({
      outcome: 'INCOMPLETE',
      call: { ...call.input.call, callerPhoneNumber: call.input.phoneNumber },
      parcels: [],
    }),
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(result.body.data.status, 'NO_ORDER');
  assert.equal(await count(), 0);
  assert.equal(
    (await pool.query('SELECT order_seq FROM call_sessions WHERE call_session_seq=$1', [call.id]))
      .rows[0].order_seq,
    null,
  );
});

test('all ACTIVE administrator roles can read; missing, expired, inactive and disallowed-origin requests are rejected', async () => {
  for (const role of ['OPERATOR', 'SUPERVISOR', 'SYSTEM_ADMIN']) {
    const session = await login(await account(role));
    assert.equal(await count(0, session), 0);
  }
  for (const path of ['/api/calls/active-count', '/api/calls/active-count/stream']) {
    assert.equal((await json(path)).status, 401);
    assert.equal(
      (await json(path, { headers: { Cookie: cookie, Origin: 'https://not-allowed.invalid' } }))
        .status,
      403,
    );
  }
  await pool.query("UPDATE admin_users SET status='INACTIVE' WHERE admin_user_seq=$1", [
    operator.id,
  ]);
  assert.equal(
    (await json('/api/calls/active-count', { headers: { Cookie: cookie } })).status,
    401,
  );
  await pool.query("UPDATE admin_users SET status='ACTIVE' WHERE admin_user_seq=$1", [operator.id]);
  await pool.query(
    "UPDATE admin_sessions SET created_at=clock_timestamp()-interval '10 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE admin_user_seq=$1",
    [operator.id],
  );
  assert.equal(
    (await json('/api/calls/active-count', { headers: { Cookie: cookie } })).status,
    401,
  );
});

test('SSE sends an unwrapped snapshot, crosses instances, reconnects from current state and releases subscriptions', async () => {
  const connection = await stream();
  assert.equal((await connection.next()).activeCallCount, 0);
  const call = await register();
  await connection.until(1);
  assert.equal((await receipt(ending(call.input))).status, 200);
  await connection.until(0);
  await connection.close();
  const active = await register();
  assert.ok(active.id);
  const reconnect = await stream();
  assert.equal((await reconnect.next()).activeCallCount, 1);
  await reconnect.close();
  for (let i = 0; i < 40 && apps[1].get(ActiveCallCountService).updates.observed; i++)
    await delay(25);
  assert.equal(apps[1].get(ActiveCallCountService).updates.observed, false);
});

test('a burst shares one in-flight count refresh across dashboard subscriptions', async () => {
  const first = await stream(),
    second = await stream();
  await first.next();
  await second.next();
  const repository = apps[1].get(ConsultationsRepository);
  const original = repository.activeCount;
  const started = new EventEmitter();
  const firstRead = once(started, 'read', { signal: AbortSignal.timeout(8000) });
  const gate = Promise.withResolvers();
  let reads = 0;
  repository.activeCount = async function () {
    reads++;
    started.emit('read');
    await gate.promise;
    return original.call(this);
  };
  try {
    await Promise.all([firstRead, Promise.all(Array.from({ length: 35 }, () => register()))]);
    assert.equal(reads, 1, 'subscribers must share the same pending count query');
    gate.resolve();
    await Promise.all([first.until(35), second.until(35)]);
  } finally {
    gate.resolve();
    repository.activeCount = original;
  }
});

test('above 100 active calls, changes are coalesced without postponing delivery indefinitely', async () => {
  await pool.query(
    'INSERT INTO call_sessions(provider_call_id) SELECT $1 || n FROM generate_series(1,120) AS n',
    ['active-many-' + randomUUID()],
  );
  const connection = await stream();
  assert.equal((await connection.next()).activeCallCount, 120);
  const writes = (async () => {
    for (let i = 0; i < 22; i++) {
      await register();
      await delay(100);
    }
  })();
  const first = await connection.next();
  assert.ok(
    first.activeCallCount > 120 && first.activeCallCount < 142,
    'receive an update while changes are still arriving',
  );
  await writes;
  await connection.until(142);
});

test('LISTEN reconnection recovers the current value and remains usable for later changes', async () => {
  const connection = await stream();
  await connection.next();
  const service = apps[1].get(ActiveCallCountService);
  await service.listener.end();
  await register();
  await connection.until(1, 9000);
  await register();
  await connection.until(2, 9000);
});

test('periodic reconciliation recovers DB changes without an application notification', async () => {
  const connection = await stream();
  assert.equal((await connection.next()).activeCallCount, 0);
  await pool.query('INSERT INTO call_sessions(provider_call_id) VALUES($1)', [
    'active-unannounced-' + randomUUID(),
  ]);
  await connection.until(1);
});

for (const mode of ['logout', 'expired', 'inactive'])
  test(
    mode +
      ' closes the existing stream at the heartbeat authorization check and never reopens anonymously',
    async () => {
      const connection = await stream();
      await connection.next();
      if (mode === 'logout') {
        const result = await json('/api/auth/logout', {
          method: 'POST',
          headers: { Origin: origin, Cookie: cookie },
        });
        assert.equal(result.status, 204);
      } else if (mode === 'expired') {
        await pool.query(
          "UPDATE admin_sessions SET created_at=clock_timestamp()-interval '10 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE admin_user_seq=$1",
          [operator.id],
        );
      } else {
        await pool.query("UPDATE admin_users SET status='INACTIVE' WHERE admin_user_seq=$1", [
          operator.id,
        ]);
      }
      assert.deepEqual(await connection.next('session-expired'), { code: 'UNAUTHORIZED' });
      assert.equal(
        (await json('/api/calls/active-count', { headers: { Cookie: cookie } })).status,
        401,
      );
    },
  );

test('DB failures are redacted JSON before streaming and terminal events after streaming, never a false zero', async () => {
  const repository = apps[1].get(ConsultationsRepository),
    original = repository.activeCount;
  const connection = await stream();
  await connection.next();
  repository.activeCount = async () => {
    throw new Error('SELECT private-token-and-phone');
  };
  try {
    const get = await json('/api/calls/active-count', { headers: { Cookie: cookie } }, 1);
    assert.equal(get.status, 503);
    assert.equal(get.body.error.code, 'DEPENDENCY_UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(get.body), /private-token|SELECT/);
    const initial = await json(
      '/api/calls/active-count/stream',
      { headers: { Cookie: cookie } },
      1,
    );
    assert.equal(initial.status, 503);
    await register();
    assert.deepEqual(await connection.next('stream-error'), { code: 'DEPENDENCY_UNAVAILABLE' });
  } finally {
    repository.activeCount = original;
  }
});

test('Swagger describes GET and SSE contracts, and request logs contain no cookies or phone values', async () => {
  const result = await json('/api/docs-json');
  assert.ok(
    result.body.paths['/api/calls/active-count'].get.responses['200'].content['application/json'],
  );
  assert.ok(
    result.body.paths['/api/calls/active-count/stream'].get.responses['200'].content[
      'text/event-stream'
    ],
  );
  assert.equal(result.body.paths['/api/calls/active-count'].post, undefined);
  const input = identity();
  await register(input);
  assert.doesNotMatch(
    JSON.stringify(logs),
    new RegExp(input.phoneNumber + '|private-test|dva_session='),
  );
});

test('application shutdown closes an open stream and releases its listener without waiting for a heartbeat', async () => {
  const app = await NestFactory.create(AppModule, { logger: false });
  configureApplication(app, { log: () => {} });
  await app.listen(0, '127.0.0.1');
  urls.push(await app.getUrl());
  let connection, closing;
  try {
    connection = await stream(urls.length - 1);
    await connection.next();
    const service = app.get(ActiveCallCountService);
    closing = app.close();
    await assert.rejects(connection.next('heartbeat', 1500), /SSE closed before expected event/);
    await closing;
    assert.equal(service.updates.observed, false);
    assert.equal(service.listener, undefined);
  } finally {
    await connection?.close();
    await (closing ?? app.close());
    urls.pop();
  }
});
