require('reflect-metadata');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { test, before, after } = require('node:test');
const { Module } = require('@nestjs/common');
const { ConfigService } = require('@nestjs/config');
const { APP_GUARD, NestFactory } = require('@nestjs/core');

const origin = 'http://localhost:5173';
const token = 'f'.repeat(64);
const operator = 'a'.repeat(64);
const systemAdmin = 'b'.repeat(64);
const runId = '1112_090752_bd17e9';
const stopPath = `/runs/${runId}/stop`;
const stopOptions = { method: 'POST', headers: { Origin: origin } };
const resultPath = `/runs/${runId}/A1`;
const api = '/api/persona-check';
const wav = Buffer.from('RIFF-test-wave');
const wavHeaders = {
  'Content-Type': 'audio/wav',
  'Accept-Ranges': 'bytes',
  ETag: '"test-wav"',
  'Last-Modified': 'Thu, 12 Nov 2026 11:29:06 GMT',
};
const scenarios = [{ id: 'A1', available: true }];
const scenario = { ...scenarios[0], expected: [{ value: { count: 1 } }] };
const run = { runId, tag: '1:7', status: 'running', finished: 1, total: 2 };
const verdict = { checks: [{ expected: { count: 1 }, actual: 'none', status: 'fail' }] };
const record = { liveSeconds: 11, customer: { lines: [[2, 'AI', '안녕하세요']] } };
const startInput = { scenarios: ['A1'], promptText: '역할\n원문 ', voiceId: null, tag: '1:7' };
let app;
let appUrl;
let upstream;
let upstreamUrl;
let fault;
let observeDisconnect;
const requests = [];

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(data));
}

async function handleUpstream(request, response) {
  const { headers, method, url } = request;
  requests.push({ headers, method, url });
  if (fault === 'disconnect') return request.socket.destroy();
  if (typeof fault === 'number')
    return json(response, fault, { detail: 'upstream private detail' });
  if (method === 'POST') {
    let body = '';
    request.setEncoding('utf8');
    for await (const chunk of request) body += chunk;
    requests.at(-1).body = url === stopPath ? body : JSON.parse(body);
    if (fault === 'accepted-but-silent') return;
    return json(response, 202, { runId });
  }
  const path = new URL(url, 'http://localhost').pathname;
  if (path === '/scenarios') return json(response, 200, scenarios);
  if (path === '/scenarios/A1') return json(response, 200, scenario);
  if (path === '/runs') return json(response, 200, [run]);
  if (path === `/runs/${runId}`) return json(response, 200, run);
  if (path === `${resultPath}/verdict`) return json(response, 200, verdict);
  if (path === `${resultPath}/record`) return json(response, 200, record);
  if (path === `/runs/${runId}/B1/audio`) {
    response.on('close', () => observeDisconnect());
    response.writeHead(200, { ...wavHeaders, 'Content-Length': wav.length });
    response.write(wav.subarray(0, 4));
    return;
  }
  if (path === `${resultPath}/audio`) {
    if (headers.range === 'bytes=99-') {
      response.writeHead(416, { 'Content-Range': `bytes */${wav.length}` });
      return response.end('unsatisfiable');
    }
    const partial = headers.range === 'bytes=0-3';
    response.writeHead(partial ? 206 : 200, {
      ...wavHeaders,
      'Content-Length': partial ? 4 : wav.length,
      ...(partial && { 'Content-Range': `bytes 0-3/${wav.length}` }),
    });
    return response.end(partial ? wav.subarray(0, 4) : wav);
  }
  return json(response, 404, { detail: 'missing' });
}

before(async () => {
  upstream = createServer(handleUpstream);
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DB_HOST: 'db',
    DB_USER: 'test_user',
    DB_PASSWORD: 'test-only',
    DB_NAME: 'dva_webhook_test',
    AI_AGENT_URL: 'http://ai:8000',
    PERSONA_CHECK_URL: upstreamUrl,
    PERSONA_CHECK_TOKEN: token,
    CORS_ORIGINS: origin,
    SWAGGER_ENABLED: 'false',
  });
  const { ApplicationConfigModule } = require('../dist/config/application-config.module');
  const { configureApplication } = require('../dist/configure-application');
  const { AuthGuard } = require('../dist/auth/auth.guard');
  const { AuthService } = require('../dist/auth/auth.service');
  const { AuditService } = require('../dist/audit/audit.service');
  const { ApiException } = require('../dist/common/errors/api.exception');
  const { PersonaCheckClient } = require('../dist/ai-settings/persona-check.client');
  const { PersonaCheckController } = require('../dist/ai-settings/persona-check.controller');
  const { DatabaseService } = require('../dist/database/database.service');
  class FixtureModule {}
  Module({
    imports: [ApplicationConfigModule],
    controllers: [PersonaCheckController],
    providers: [
      PersonaCheckClient,
      { provide: DatabaseService, useValue: { pool: { totalCount: 0, idleCount: 0, waitingCount: 0 } } },
      { provide: APP_GUARD, useClass: AuthGuard },
      { provide: AuditService, useValue: {} },
      {
        provide: AuthService,
        useValue: {
          authenticate(session) {
            if (session === operator) return { role: 'OPERATOR' };
            if (session === systemAdmin) return { role: 'SYSTEM_ADMIN' };
            if (session === 'c'.repeat(64)) return { role: 'UNRECOGNIZED' };
            throw new ApiException(401, 'UNAUTHORIZED', 'Invalid session');
          },
        },
      },
    ],
  })(FixtureModule);
  app = await NestFactory.create(FixtureModule, { logger: false });
  configureApplication(app, { log: () => {} });
  await app.listen(0, '127.0.0.1');
  appUrl = await app.getUrl();
});

after(async () => {
  await app?.close();
  if (upstream) {
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

function call(path, { session = operator, headers, ...options } = {}) {
  return fetch(`${appUrl}${api}${path}`, {
    ...options,
    headers: { ...(session && { Cookie: `dva_session=${session}` }), ...headers },
  });
}

function post(input, requestOrigin = origin) {
  return call('/runs', {
    method: 'POST',
    headers: { Origin: requestOrigin, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

async function expectData(response, expected, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  const body = await response.json();
  assert.deepEqual(body.data, expected);
  assert.ok(body.meta.requestId);
  assert.equal(response.headers.get('x-request-id'), body.meta.requestId);
}

async function expectError(response, status, code) {
  assert.equal(response.status, status, await response.clone().text());
  const body = await response.json();
  assert.equal(body.error.code, code);
  assert.ok(body.meta.requestId);
  assert.doesNotMatch(JSON.stringify(body), /upstream private detail/);
}

test('both admin roles can read the exact JSON data and only the trial token reaches upstream', async () => {
  await expectData(
    await call('/scenarios', { headers: { Authorization: 'Bearer browser' } }),
    scenarios,
  );
  assert.equal(requests.at(-1).headers.authorization, `Bearer ${token}`);
  assert.equal(requests.at(-1).headers.cookie, undefined);
  await expectData(await call('/scenarios/A1', { session: systemAdmin }), scenario);
  await expectData(await call('/runs'), [run]);
  assert.equal(requests.at(-1).url, '/runs');
  const tag = run.tag;
  await expectData(await call('/runs?' + new URLSearchParams({ tag })), [run]);
  assert.deepEqual([...new URL(requests.at(-1).url, upstreamUrl).searchParams], [['tag', tag]]);
  await expectData(await call(`/runs/${runId}`), run);
  await expectData(await call(`${resultPath}/verdict`), verdict);
  await expectData(await call(`${resultPath}/record`), record);
});

test('starting a trial preserves the request and returns 202 with a run ID', async () => {
  await expectData(await post(startInput), { runId }, 202);
  assert.equal(requests.at(-1).method, 'POST');
  assert.deepEqual(requests.at(-1).body, startInput);
  const promptText = '한'.repeat(20000);
  const escaped = '\\ud55c'.repeat(20000);
  await expectData(
    await call('/runs', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: `{"promptText":"${escaped}","tag":"1:7"}`,
    }),
    { runId },
    202,
  );
  assert.equal(requests.at(-1).body.promptText, promptText);
  assert.equal(Object.hasOwn(requests.at(-1).body, 'scenarios'), false);
});

test('both admin roles can relay a stop with no body and receive 202 on repeat', async () => {
  const count = requests.length;
  for (const session of [operator, systemAdmin]) {
    await expectData(await call(stopPath, { ...stopOptions, session }), { runId }, 202);
    const request = requests.at(-1);
    assert.equal(request.url, stopPath);
    assert.equal(request.method, 'POST');
    assert.equal(request.body, '');
    assert.equal(request.headers['content-type'], undefined);
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    assert.equal(request.headers.cookie, undefined);
  }
  assert.equal(requests.length, count + 2);
});

test('session, origin, path and launch validation prevent upstream requests', async () => {
  const count = requests.length;
  await expectError(await call('/scenarios', { session: '' }), 401, 'UNAUTHORIZED');
  await expectError(await call(`${resultPath}/audio`, { session: '' }), 401, 'UNAUTHORIZED');
  await expectError(await call('/scenarios', { session: 'c'.repeat(64) }), 403, 'FORBIDDEN');
  await expectError(await post(startInput, 'https://invalid.example'), 403, 'FORBIDDEN');
  await expectError(await call('/scenarios/A1%2Fextra'), 400, 'INVALID_REQUEST');
  await expectError(await call('/runs/invalid'), 400, 'INVALID_REQUEST');
  await expectError(await call('/runs/invalid/stop', stopOptions), 400, 'INVALID_REQUEST');
  await expectError(await call(stopPath, { ...stopOptions, session: '' }), 401, 'UNAUTHORIZED');
  await expectError(
    await call(stopPath, { ...stopOptions, session: 'c'.repeat(64) }),
    403,
    'FORBIDDEN',
  );
  await expectError(await call(stopPath, { method: 'POST' }), 403, 'FORBIDDEN');
  await expectError(await call('/runs?tag=1%3A7%26other%3Dvalue'), 400, 'INVALID_REQUEST');
  await expectError(await call(`${resultPath}/report`), 404, 'NOT_FOUND');
  for (const input of [
    { scenarios: ['A1'], tag: '1:7' },
    { ...startInput, promptText: '' },
    { ...startInput, promptText: ' \n ' },
    { ...startInput, tag: undefined },
    { ...startInput, tag: '1:v7' },
    { ...startInput, tag: '0:7' },
    { ...startInput, scenarios: [] },
    { ...startInput, scenarios: null },
    { ...startInput, scenarios: ['A1', 'A1'] },
    { ...startInput, concurrency: 0 },
  ])
    await expectError(await post(input), 400, 'INVALID_REQUEST');
  assert.equal(requests.length, count);
});

test('upstream errors use the public API envelope and are never retried', async () => {
  try {
    for (const [upstreamStatus, status, code] of [
      [404, 404, 'NOT_FOUND'],
      [400, 400, 'INVALID_REQUEST'],
      [422, 400, 'INVALID_REQUEST'],
      [401, 503, 'DEPENDENCY_UNAVAILABLE'],
      [503, 503, 'DEPENDENCY_UNAVAILABLE'],
      [500, 503, 'DEPENDENCY_UNAVAILABLE'],
      ['disconnect', 503, 'DEPENDENCY_UNAVAILABLE'],
    ]) {
      const count = requests.length;
      fault = upstreamStatus;
      await expectError(await post(startInput), status, code);
      assert.equal(requests.length, count + 1);
    }
    fault = 404;
    await expectError(await call(`${resultPath}/audio`), 404, 'NOT_FOUND');
  } finally {
    fault = undefined;
  }
});

test('stopping maps upstream 404 to NOT_FOUND and other failed responses to 503', async () => {
  try {
    const count = requests.length;
    fault = 404;
    await expectError(await call(stopPath, stopOptions), 404, 'NOT_FOUND');
    assert.equal(requests.length, count + 1);
    for (const upstreamFault of [200, 202, 400, 422, 500, 'disconnect']) {
      const count = requests.length;
      fault = upstreamFault;
      await expectError(await call(stopPath, stopOptions), 503, 'DEPENDENCY_UNAVAILABLE');
      assert.equal(requests.length, count + 1);
    }
  } finally {
    fault = undefined;
  }
});

test(
  'an accepted launch with no reply times out once and its running result can be polled',
  { timeout: 12000 },
  async () => {
    const count = requests.length;
    fault = 'accepted-but-silent';
    try {
      await expectError(await post(startInput), 503, 'DEPENDENCY_UNAVAILABLE');
      assert.equal(requests.length, count + 1);
      assert.deepEqual(requests.at(-1).body, startInput);
    } finally {
      fault = undefined;
    }
    await expectData(await call('/runs?tag=1%3A7'), [run]);
  },
);

test('absent settings disable only the relay and supplied settings are validated', async () => {
  const { validateEnvironment } = require('../dist/config/environment');
  const raw = { ...process.env, PERSONA_CHECK_URL: '', PERSONA_CHECK_TOKEN: '' };
  const config = validateEnvironment(raw);
  assert.equal(config.PERSONA_CHECK_URL, undefined);
  assert.equal(config.PERSONA_CHECK_TOKEN, undefined);
  assert.throws(
    () => validateEnvironment({ ...raw, PERSONA_CHECK_URL: 'file:///tmp' }),
    /PERSONA_CHECK_URL/,
  );
  assert.throws(
    () => validateEnvironment({ ...raw, PERSONA_CHECK_TOKEN: 'invalid' }),
    /PERSONA_CHECK_TOKEN/,
  );
  const appConfig = app.get(ConfigService);
  const count = requests.length;
  try {
    for (const key of ['PERSONA_CHECK_URL', 'PERSONA_CHECK_TOKEN']) {
      const previous = appConfig.get(key);
      try {
        appConfig.set(key, '');
        await expectError(await call('/scenarios'), 503, 'DEPENDENCY_UNAVAILABLE');
      } finally {
        appConfig.set(key, previous);
      }
    }
    assert.equal(requests.length, count);
  } finally {
    appConfig.set('PERSONA_CHECK_URL', upstreamUrl);
    appConfig.set('PERSONA_CHECK_TOKEN', token);
  }
});

test('whole WAV and byte ranges keep the exact bytes and playback headers', async () => {
  for (const partial of [false, true]) {
    const response = await call(`${resultPath}/audio`, {
      headers: partial ? { Range: 'bytes=0-3' } : {},
    });
    assert.equal(response.status, partial ? 206 : 200);
    assert.equal(requests.at(-1).headers.range, partial ? 'bytes=0-3' : undefined);
    for (const [name, value] of Object.entries(wavHeaders))
      assert.equal(response.headers.get(name), value);
    const bytes = partial ? wav.subarray(0, 4) : wav;
    assert.equal(response.headers.get('Content-Length'), String(bytes.length));
    assert.equal(response.headers.get('Content-Range'), partial ? `bytes 0-3/${wav.length}` : null);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  }
  const invalid = await call(`${resultPath}/audio`, { headers: { Range: 'bytes=99-' } });
  assert.equal(invalid.headers.get('Content-Range'), `bytes */${wav.length}`);
  await expectError(invalid, 416, 'INVALID_REQUEST');
});

test(
  'audio streams before the file finishes and cancels upstream on disconnect',
  { timeout: 5000 },
  async () => {
    const disconnected = new Promise((resolve) => (observeDisconnect = resolve));
    const abort = new AbortController();
    try {
      const response = await call(`/runs/${runId}/B1/audio`, { signal: abort.signal });
      const reader = response.body.getReader();
      assert.deepEqual(Buffer.from((await reader.read()).value), wav.subarray(0, 4));
    } finally {
      abort.abort();
    }
    await disconnected;
  },
);
