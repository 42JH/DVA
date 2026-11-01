require('reflect-metadata');
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { migrate } = require('./helpers/migrations.cjs');
const { createServer } = require('node:http');
const { Pool } = require('pg');
const { NestFactory } = require('@nestjs/core');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.DB_NAME, 'dva_webhook_test');
assert.ok(['db', '127.0.0.1'].includes(process.env.DB_HOST));
process.env.CORS_ORIGINS = 'http://localhost:5173';
process.env.SWAGGER_ENABLED = 'true';
const token = randomBytes(32).toString('hex');
process.env.AI_PERSONA_TOKEN = token;
const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});
const options = {
  voices: [{ id: 'test-voice', label: '테스트 음성' }],
  speakingRate: { min: 0.8, max: 1.2 },
  turnWaitLevels: ['SHORT', 'NORMAL', 'LONG'],
};
const cookies = [],
  actorIds = [],
  apps = [],
  notifications = [],
  logs = [];
let app,
  base,
  ai,
  aiResponse = options,
  aiStatus = 200,
  refreshStatus = 202;
const call = (method, path, body, actor = 0, headers = {}) =>
  fetch(base + path, {
    method,
    headers: Object.fromEntries(
      Object.entries({
        Origin: process.env.CORS_ORIGINS,
        Cookie: cookies[actor],
        'Content-Type': 'application/json',
        ...headers,
      }).filter(([, v]) => v !== undefined),
    ),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
async function data(response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return (await response.json()).data;
}
async function error(response, status, code) {
  assert.equal(response.status, status, await response.clone().text());
  const result = await response.json();
  assert.equal(result.error.code, code);
  assert.ok(result.meta.requestId);
}
const input = (changes = {}) => ({
  code: 'test-' + randomUUID(),
  name: '테스트 상담원',
  promptText: ' 원문\n보존 ',
  voiceId: 'test-voice',
  speakingRate: 1.2,
  turnWaitLevel: 'LONG',
  ...changes,
});
const create = async (changes = {}) =>
  data(await call('POST', '/api/personas', input(changes)), 201);
const patch = (id, body) => call('PATCH', `/api/personas/${id}`, body);
before(async () => {
  await migrate(pool);
  ai = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    if (request.url === '/internal/persona/options') {
      response.writeHead(aiStatus, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(aiResponse));
    } else if (request.url === '/internal/persona/refresh') {
      let body = '';
      for await (const part of request) body += part;
      notifications.push(JSON.parse(body));
      response.writeHead(refreshStatus);
      response.end();
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve) => ai.listen(0, '127.0.0.1', resolve));
  process.env.AI_AGENT_URL = `http://127.0.0.1:${ai.address().port}`;
  const { AppModule } = require('../dist/app.module');
  const { configureApplication } = require('../dist/configure-application');
  app = await NestFactory.create(AppModule, { logger: false });
  apps.push(app);
  configureApplication(app, { log: (entry) => logs.push(entry) });
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  for (const role of ['SYSTEM_ADMIN', 'OPERATOR', 'SUPERVISOR']) {
    const id = (
      await pool.query(
        "INSERT INTO admin_users(login_id,name,password_hash,role,status) VALUES($1,'설정 테스트 관리자','not-for-login',$2,'ACTIVE') RETURNING admin_user_seq",
        ['p' + randomUUID().replaceAll('-', '').slice(0, 18), role],
      )
    ).rows[0].admin_user_seq;
    actorIds.push(id);
    const session = randomBytes(32).toString('hex');
    await pool.query(
      'INSERT INTO admin_sessions(session_token_hash,admin_user_seq) VALUES($1,$2)',
      [createHash('sha256').update(session).digest('hex'), id],
    );
    cookies.push('dva_session=' + session);
  }
});
after(async () => {
  for (const application of apps) await application.close();
  if (ai) await new Promise((resolve) => ai.close(resolve));
  await pool.end();
});

test('persona APIs require a valid SYSTEM_ADMIN session, never an AI token alone', async () => {
  for (const actor of [1, 2]) {
    await error(await call('GET', '/api/personas', undefined, actor), 403, 'FORBIDDEN');
    await error(await call('POST', '/api/personas', input(), actor), 403, 'FORBIDDEN');
    await error(await call('GET', '/api/ai/options', undefined, actor), 403, 'FORBIDDEN');
  }
  await error(
    await call('GET', '/api/personas', undefined, 99, { Authorization: `Bearer ${token}` }),
    401,
    'UNAUTHORIZED',
  );
  await error(
    await call('POST', '/api/personas', input(), 0, { Origin: undefined }),
    403,
    'FORBIDDEN',
  );
});

test('persona creation preserves prompt and full settings in an inactive immutable version', async () => {
  const body = input();
  const v = await data(await call('POST', '/api/personas', body), 201);
  for (const field of Object.keys(body)) assert.deepEqual(v[field], body[field]);
  assert.equal(v.version, 1);
  assert.equal(v.status, 'INACTIVE');
  assert.equal(v.createdByAdminUserSeq, actorIds[0]);
  assert.equal(v.applicationId, null);
  const detail = await data(await call('GET', `/api/personas/${v.aiPersonaSeq}`));
  assert.equal(detail.latestVersion.aiPersonaVersionSeq, v.aiPersonaVersionSeq);
  assert.equal(detail.activeVersionSeq, null);
  assert.equal(detail.pendingVersionSeq, null);
  await error(await call('POST', '/api/personas', body), 409, 'DUPLICATE_RESOURCE');
  for (const [column, value] of [
    ['name', '변경'],
    ['prompt_text', '변경'],
    ['voice_id', 'other'],
    ['turn_wait_level', 'SHORT'],
    ['speaking_rate', 1],
  ])
    await assert.rejects(
      pool.query(`UPDATE ai_persona_versions SET ${column}=$1 WHERE ai_persona_version_seq=$2`, [
        value,
        v.aiPersonaVersionSeq,
      ]),
      (e) => e.code === '23514',
    );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM audit_logs WHERE action='PERSONA_CREATED' AND target_seq=$1 AND result='SUCCESS'",
        [v.aiPersonaVersionSeq],
      )
    ).rows[0].n,
    1,
  );
});

test('PATCH appends whole snapshots, preserves omitted values, and rejects stale or empty edits', async () => {
  const v1 = await create();
  const v2 = await data(
    await patch(v1.aiPersonaSeq, { expectedVersion: 1, promptText: '새로운 원문' }),
  );
  assert.equal(v2.version, 2);
  assert.equal(v2.status, 'INACTIVE');
  for (const key of ['name', 'voiceId', 'speakingRate', 'turnWaitLevel'])
    assert.equal(v2[key], v1[key]);
  await error(
    await patch(v1.aiPersonaSeq, { expectedVersion: 1, name: '오래된 수정' }),
    409,
    'VERSION_CONFLICT',
  );
  await error(await patch(v1.aiPersonaSeq, { expectedVersion: 2 }), 400, 'INVALID_REQUEST');
  await error(
    await patch(v1.aiPersonaSeq, { expectedVersion: 2, name: null }),
    400,
    'INVALID_REQUEST',
  );
  const same = await data(await patch(v1.aiPersonaSeq, { expectedVersion: 2, name: v2.name }));
  assert.equal(same.version, 2);
  const v3 = await data(
    await patch(v1.aiPersonaSeq, { expectedVersion: 2, voiceId: null, speakingRate: null }),
  );
  assert.equal(v3.voiceId, null);
  assert.equal(v3.speakingRate, null);
  const historyResponse = await call('GET', `/api/personas/${v1.aiPersonaSeq}/versions?limit=2`);
  assert.equal(historyResponse.status, 200);
  const historyPage = await historyResponse.json();
  assert.equal(historyPage.total_count, 3);
  assert.equal(historyPage.hasNext, true);
  const history = historyPage.data;
  const pastEnd = await call('GET', `/api/personas/${v1.aiPersonaSeq}/versions?offset=100`);
  assert.deepEqual(await pastEnd.json(), { data: [], hasNext: false, total_count: 3 });
  assert.deepEqual(
    history.map((v) => v.version),
    [3, 2],
  );
  assert.equal(
    (
      await pool.query(
        'SELECT prompt_text FROM ai_persona_versions WHERE ai_persona_version_seq=$1',
        [v1.aiPersonaVersionSeq],
      )
    ).rows[0].prompt_text,
    v1.promptText,
  );
});

test('concurrent editors get one new version and a conflict without losing either saved snapshot', async () => {
  const v = await create();
  const results = await Promise.all(
    ['A', 'B'].map((name) => patch(v.aiPersonaSeq, { expectedVersion: 1, name })),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::int AS n FROM ai_persona_versions WHERE ai_persona_seq=$1',
        [v.aiPersonaSeq],
      )
    ).rows[0].n,
    2,
  );
});

test('actual capabilities validate settings and unavailable AI cannot silently accept invented options', async () => {
  assert.deepEqual(await data(await call('GET', '/api/ai/options')), options);
  for (const change of [{ voiceId: 'unknown' }, { speakingRate: 2 }, { turnWaitLevel: 'OTHER' }])
    await error(
      await call('POST', '/api/personas', input(change)),
      change.turnWaitLevel ? 400 : 422,
      change.turnWaitLevel ? 'INVALID_REQUEST' : 'BUSINESS_RULE_VIOLATION',
    );
  aiResponse = { ...options, speakingRate: { min: null, max: null }, turnWaitLevels: ['NORMAL'] };
  await error(await call('POST', '/api/personas', input()), 422, 'BUSINESS_RULE_VIOLATION');
  aiResponse = { invalid: true };
  await error(await call('GET', '/api/ai/options'), 503, 'DEPENDENCY_UNAVAILABLE');
  aiResponse = options;
  aiStatus = 503;
  await error(await call('POST', '/api/personas', input()), 503, 'DEPENDENCY_UNAVAILABLE');
  aiStatus = 200;
});

test('audit failure rolls back persona and version creation together', async () => {
  const { AuditService } = require('../dist/audit/audit.service');
  const audit = app.get(AuditService),
    original = audit.recordSuccess;
  const body = input();
  audit.recordSuccess = async () => {
    throw new Error('test-only audit failure');
  };
  try {
    await error(await call('POST', '/api/personas', body), 500, 'INTERNAL_ERROR');
  } finally {
    audit.recordSuccess = original;
  }
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM ai_personas WHERE code=$1', [body.code]))
      .rows[0].n,
    0,
  );
});

test('pagination, unknown fields and missing persona IDs are validated', async () => {
  for (const query of ['limit=0', 'offset=1e2', 'limit=1&limit=2', 'sort=bad'])
    await error(await call('GET', '/api/personas?' + query), 400, 'INVALID_REQUEST');
  await error(await call('GET', '/api/personas/2147483647'), 404, 'NOT_FOUND');
  await error(await call('GET', '/api/personas/0'), 400, 'INVALID_REQUEST');
  const response = await call('GET', '/api/personas?limit=1');
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ['data', 'hasNext', 'total_count']);
  assert.equal(body.data.length, 1);
  assert.equal(body.hasNext, true);
  const total = (await pool.query('SELECT count(*)::int AS n FROM ai_personas')).rows[0].n;
  assert.equal(body.total_count, total);
  const pastEnd = await call('GET', `/api/personas?offset=${total}`);
  assert.deepEqual(await pastEnd.json(), { data: [], hasNext: false, total_count: total });
});

test('Swagger documents persona inputs, whole versions and responses', async () => {
  const spec = await (await fetch(base + '/api/docs-json')).json();
  for (const [path, method] of [
    ['/api/personas', 'get'],
    ['/api/personas', 'post'],
    ['/api/personas/{id}', 'get'],
    ['/api/personas/{id}', 'patch'],
    ['/api/personas/{id}/versions', 'get'],
    ['/api/ai/options', 'get'],
  ]) {
    const operation = spec.paths[path][method];
    assert.ok(operation.summary);
    assert.ok(operation.description);
    assert.ok(operation.responses['200'] || operation.responses['201']);
  }
  assert.ok(spec.components.schemas.PersonaVersionDto.properties.applyErrorCode.description);
  const log = JSON.stringify(logs);
  assert.ok(!log.includes(token));
  assert.ok(!log.includes('원문'));
});

const serviceCall = (method, path, body, headers = {}) =>
  call(method, path, body, 99, {
    Cookie: undefined,
    Origin: undefined,
    Authorization: `Bearer ${token}`,
    ...headers,
  });
const activate = (version, expectedVersion = version.version) =>
  call('POST', `/api/personas/${version.aiPersonaSeq}/activate`, {
    aiPersonaVersionSeq: version.aiPersonaVersionSeq,
    expectedVersion,
  });
const report = (version, changes = {}) =>
  serviceCall('POST', '/api/ai/config/apply-result', {
    aiPersonaVersionSeq: version.aiPersonaVersionSeq,
    applicationId: version.applicationId,
    result: 'APPLIED',
    activeCallCount: 0,
    ...changes,
  });
const runtime = (status = 'ACTIVE') => serviceCall('GET', '/api/ai/config?status=' + status);
const applicationService = () =>
  app.get(require('../dist/ai-settings/persona-application.service').PersonaApplicationService);

test('runtime settings and application callbacks enforce dedicated service authentication', async () => {
  for (const headers of [
    { Authorization: undefined },
    { Authorization: 'Bearer incorrect' },
    { Authorization: 'Basic invalid' },
  ])
    await error(
      await serviceCall('GET', '/api/ai/config', undefined, headers),
      401,
      'UNAUTHORIZED',
    );
  await error(await runtime(), 404, 'NOT_FOUND');
  await error(await runtime('INACTIVE'), 400, 'INVALID_REQUEST');
  await error(await call('GET', '/api/ai/config', undefined, 1), 403, 'FORBIDDEN');
  await error(await call('POST', '/api/ai/config/apply-result', {}), 401, 'UNAUTHORIZED');
  await error(await serviceCall('POST', '/api/personas', input()), 403, 'FORBIDDEN');
  for (const [headers, expectedType, expectedStatus] of [
    [{ Authorization: 'Bearer incorrect' }, 'SYSTEM', 401],
    [{}, 'AI', 400],
  ]) {
    const response = await serviceCall('POST', '/api/ai/config/apply-result', {}, headers);
    assert.equal(response.status, expectedStatus);
    const logs = (
      await pool.query('SELECT actor_type,result FROM audit_logs WHERE request_id=$1', [
        response.headers.get('x-request-id'),
      ])
    ).rows;
    assert.deepEqual(logs, [
      { actor_type: expectedType, result: expectedStatus === 401 ? 'DENIED' : 'FAILED' },
    ]);
  }
});

test('activation stays pending after notification and only an idle applied acknowledgment changes ACTIVE', async () => {
  const version = await create();
  const pending = await data(await activate(version), 202);
  assert.equal(pending.status, 'PENDING');
  assert.ok(pending.applicationId);
  assert.equal(pending.appliedAt, null);
  assert.equal(
    (await data(await runtime('PENDING'))).aiPersonaVersionSeq,
    pending.aiPersonaVersionSeq,
  );
  await applicationService().tick();
  assert.ok(
    notifications.some(
      (n) =>
        n.applicationId === pending.applicationId &&
        n.aiPersonaVersionSeq === pending.aiPersonaVersionSeq,
    ),
  );
  await error(await runtime(), 404, 'NOT_FOUND');
  await error(await report(pending, { activeCallCount: 1 }), 409, 'INVALID_STATE');
  const same = await data(await activate(version), 202);
  assert.equal(same.applicationId, pending.applicationId);
  const active = await data(await report(pending));
  assert.equal(active.status, 'ACTIVE');
  assert.ok(active.appliedAt);
  assert.equal((await data(await runtime())).aiPersonaVersionSeq, active.aiPersonaVersionSeq);
  assert.equal(
    (await data(await call('GET', '/api/ai/config'))).aiPersonaVersionSeq,
    active.aiPersonaVersionSeq,
  );
  assert.equal((await data(await report(pending))).appliedAt, active.appliedAt);
  assert.equal((await data(await activate(version))).status, 'ACTIVE');
  const appliedActor = (
    await pool.query(
      "SELECT actor_type,actor_name,actor_seq FROM audit_logs WHERE action='PERSONA_APPLIED' AND target_seq=$1",
      [active.aiPersonaVersionSeq],
    )
  ).rows;
  assert.deepEqual(appliedActor, [{ actor_type: 'AI', actor_name: 'AI', actor_seq: null }]);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM audit_logs WHERE action='PERSONA_APPLIED' AND target_seq=$1",
        [active.aiPersonaVersionSeq],
      )
    ).rows[0].n,
    1,
  );
});

test('editing ACTIVE queues a full version and replacing PENDING rejects late acknowledgments', async () => {
  const active = await data(await runtime());
  const pending1 = await data(
    await patch(active.aiPersonaSeq, { expectedVersion: active.version, name: '수정 1' }),
  );
  assert.equal(pending1.status, 'PENDING');
  assert.equal((await data(await runtime())).name, active.name);
  const pending2 = await data(
    await patch(active.aiPersonaSeq, { expectedVersion: pending1.version, promptText: '수정 2' }),
  );
  assert.notEqual(pending1.applicationId, pending2.applicationId);
  assert.equal(
    (
      await pool.query('SELECT status FROM ai_persona_versions WHERE ai_persona_version_seq=$1', [
        pending1.aiPersonaVersionSeq,
      ])
    ).rows[0].status,
    'INACTIVE',
  );
  await error(await report(pending1), 409, 'VERSION_CONFLICT');
  const other = await create();
  const replacement = await data(await activate(other), 202);
  await error(await report(pending2), 409, 'VERSION_CONFLICT');
  assert.equal((await data(await runtime())).aiPersonaVersionSeq, active.aiPersonaVersionSeq);
  const next = await data(await report(replacement));
  assert.equal(next.aiPersonaSeq, other.aiPersonaSeq);
  assert.equal(
    (
      await pool.query('SELECT status FROM ai_persona_versions WHERE ai_persona_version_seq=$1', [
        active.aiPersonaVersionSeq,
      ])
    ).rows[0].status,
    'INACTIVE',
  );
  const history = await data(await call('GET', `/api/personas/${active.aiPersonaSeq}/versions`));
  assert.deepEqual(
    history.map((v) => v.version),
    [3, 2, 1],
  );
});

test('failure keeps the old ACTIVE and retry rotates the application ID without accepting obsolete results', async () => {
  const active = await data(await runtime());
  const source = await create();
  const pending = await data(await activate(source), 202);
  const failed = await data(await report(pending, { result: 'FAILED', errorCode: 'APPLY_FAILED' }));
  assert.equal(failed.status, 'PENDING');
  assert.equal(failed.applyErrorCode, 'APPLY_FAILED');
  await data(await report(pending, { result: 'FAILED', errorCode: 'APPLY_FAILED' }));
  assert.equal((await data(await runtime())).aiPersonaVersionSeq, active.aiPersonaVersionSeq);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM audit_logs WHERE action='PERSONA_APPLY_FAILED' AND target_seq=$1 AND result='FAILED'",
        [source.aiPersonaVersionSeq],
      )
    ).rows[0].n,
    1,
  );
  const retried = await data(await activate(source), 202);
  assert.notEqual(retried.applicationId, pending.applicationId);
  assert.equal(retried.applyErrorCode, null);
  await error(await report(pending), 409, 'VERSION_CONFLICT');
  await data(await report(retried));
  await error(
    await report(retried, { result: 'FAILED', errorCode: 'APPLY_FAILED' }),
    409,
    'VERSION_CONFLICT',
  );
});

test('application validation rejects mismatched personas, stale edits and invalid result combinations', async () => {
  const a = await create(),
    b = await create();
  await error(
    await call('POST', `/api/personas/${a.aiPersonaSeq}/activate`, {
      aiPersonaVersionSeq: b.aiPersonaVersionSeq,
      expectedVersion: 1,
    }),
    404,
    'NOT_FOUND',
  );
  await error(await activate(a, 2), 409, 'VERSION_CONFLICT');
  const pending = await data(await activate(a), 202);
  for (const change of [
    { result: 'FAILED' },
    { errorCode: 'APPLY_FAILED' },
    { errorCode: null },
    { activeCallCount: '0' },
    { activeCallCount: -1 },
    { applicationId: 'bad' },
  ])
    await error(await report(pending, change), 400, 'INVALID_REQUEST');
  await error(await report(pending, { applicationId: randomUUID() }), 409, 'VERSION_CONFLICT');
  assert.equal((await data(await runtime('PENDING'))).applicationId, pending.applicationId);
});

test('two concurrent applications retain one pending and one active with atomic successful handover', async () => {
  const [a, b] = await Promise.all([create(), create()]);
  const pending = await Promise.all([a, b].map(async (v) => data(await activate(v), 202)));
  const results = await Promise.all(pending.map(report));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const counts = (
    await pool.query(
      "SELECT status,count(*)::int AS n FROM ai_persona_versions WHERE status IN ('ACTIVE','PENDING') GROUP BY status",
    )
  ).rows;
  assert.deepEqual(counts, [{ status: 'ACTIVE', n: 1 }]);
  const current = await data(await runtime());
  const stale = pending.find((v) => v.aiPersonaVersionSeq !== current.aiPersonaVersionSeq);
  await assert.rejects(
    pool.query(
      "UPDATE ai_persona_versions SET status='ACTIVE',applied_at=clock_timestamp() WHERE ai_persona_version_seq=$1",
      [stale.aiPersonaVersionSeq],
    ),
    (e) => e.code === '23505',
  );
});

test('old whole versions can be restored without overwriting their snapshots', async () => {
  const first = await create();
  const second = await data(
    await patch(first.aiPersonaSeq, { expectedVersion: 1, name: '다른 이름', speakingRate: 0.8 }),
  );
  await data(await report(await data(await activate(second), 202)));
  const restored = await data(await activate(first, 2), 202);
  const active = await data(await report(restored));
  assert.equal(active.version, 1);
  assert.equal(active.name, first.name);
  assert.equal(active.speakingRate, first.speakingRate);
  const detail = await data(await call('GET', `/api/personas/${first.aiPersonaSeq}`));
  assert.equal(detail.latestVersion.version, 2);
  assert.equal(detail.activeVersionSeq, first.aiPersonaVersionSeq);
});

test('failed audit on applied acknowledgment rolls the entire ACTIVE switch back', async () => {
  const { AuditService } = require('../dist/audit/audit.service');
  const audit = app.get(AuditService),
    original = audit.recordSuccess;
  const previous = await data(await runtime());
  const pending = await data(await activate(await create()), 202);
  audit.recordSuccess = async (event, client) => {
    if (event.action === 'PERSONA_APPLIED') throw new Error('test-only failure');
    return original.call(audit, event, client);
  };
  try {
    await error(await report(pending), 500, 'INTERNAL_ERROR');
  } finally {
    audit.recordSuccess = original;
  }
  assert.equal((await data(await runtime())).aiPersonaVersionSeq, previous.aiPersonaVersionSeq);
  assert.equal((await data(await runtime('PENDING'))).applicationId, pending.applicationId);
  await data(await report(pending));
});

test('notification failures remain pending and retries preserve the same request without marking it active', async () => {
  const beforeActive = await data(await runtime());
  const pending = await data(await activate(await create()), 202);
  refreshStatus = 503;
  await applicationService().tick();
  const failed = await data(await runtime('PENDING'));
  assert.equal(failed.applyErrorCode, 'AI_UNAVAILABLE');
  assert.equal(failed.applicationId, pending.applicationId);
  refreshStatus = 202;
  await pool.query(
    "UPDATE ai_persona_versions SET last_notified_at=clock_timestamp()-interval '31 seconds' WHERE ai_persona_version_seq=$1",
    [pending.aiPersonaVersionSeq],
  );
  await applicationService().tick();
  const notified = await data(await runtime('PENDING'));
  assert.equal(notified.applyErrorCode, null);
  assert.equal(notified.status, 'PENDING');
  assert.equal((await data(await runtime())).aiPersonaVersionSeq, beforeActive.aiPersonaVersionSeq);
  assert.equal(notifications.filter((n) => n.applicationId === pending.applicationId).length, 2);
});

test('a restarted backend resumes pending notifications and concurrent workers claim once', async () => {
  const pending = await data(await runtime('PENDING'));
  await app.close();
  apps.splice(apps.indexOf(app), 1);
  await pool.query(
    "UPDATE ai_persona_versions SET last_notified_at=clock_timestamp()-interval '31 seconds' WHERE ai_persona_version_seq=$1",
    [pending.aiPersonaVersionSeq],
  );
  const { AppModule } = require('../dist/app.module');
  const { configureApplication } = require('../dist/configure-application');
  app = await NestFactory.create(AppModule, { logger: false });
  apps.push(app);
  configureApplication(app, { log: (entry) => logs.push(entry) });
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  await applicationService().tick();
  assert.equal(notifications.filter((n) => n.applicationId === pending.applicationId).length, 3);
  const { AiSettingsRepository } = require('../dist/ai-settings/ai-settings.repository');
  const repository = app.get(AiSettingsRepository);
  await pool.query(
    "UPDATE ai_persona_versions SET last_notified_at=clock_timestamp()-interval '31 seconds' WHERE ai_persona_version_seq=$1",
    [pending.aiPersonaVersionSeq],
  );
  const claims = await Promise.all([
    repository.claimNotification(),
    repository.claimNotification(),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  await data(await report(pending));
});

test('application Swagger has separate admin request and service result security contracts', async () => {
  const spec = await (await fetch(base + '/api/docs-json')).json();
  assert.deepEqual(spec.paths['/api/ai/config'].get.security, [
    { bearer: [] },
    { adminSession: [] },
  ]);
  assert.deepEqual(spec.paths['/api/ai/config/apply-result'].post.security, [{ bearer: [] }]);
  assert.ok(spec.paths['/api/personas/{id}/activate'].post.responses['202']);
  assert.ok(spec.paths['/api/ai/config/apply-result'].post.responses['409']);
  assert.ok(!JSON.stringify(logs).includes(token));
});

test('choosing the current ACTIVE cancels a different pending request so the latest intention wins', async () => {
  const active = await data(await runtime());
  const pending = await data(await activate(await create()), 202);
  const detail = await data(await call('GET', `/api/personas/${active.aiPersonaSeq}`));
  const current = await data(await activate(active, detail.latestVersion.version));
  assert.equal(current.applicationId, active.applicationId);
  await error(await runtime('PENDING'), 404, 'NOT_FOUND');
  await error(await report(pending), 409, 'VERSION_CONFLICT');
  assert.equal((await data(await runtime())).aiPersonaVersionSeq, active.aiPersonaVersionSeq);
});

test('transport failure cannot erase a specific apply error and stale notification results cannot affect its replacement', async () => {
  const { AiSettingsRepository } = require('../dist/ai-settings/ai-settings.repository');
  const repository = app.get(AiSettingsRepository);
  const pending = await data(await activate(await create()), 202);
  await data(await report(pending, { result: 'FAILED', errorCode: 'INVALID_CONFIG' }));
  await repository.applicationError(
    pending.aiPersonaVersionSeq,
    pending.applicationId,
    'AI_UNAVAILABLE',
  );
  assert.equal((await data(await runtime('PENDING'))).applyErrorCode, 'INVALID_CONFIG');
  const next = await data(await activate(await create()), 202);
  await repository.applicationError(
    pending.aiPersonaVersionSeq,
    pending.applicationId,
    'AI_UNAVAILABLE',
  );
  assert.equal((await data(await runtime('PENDING'))).applicationId, next.applicationId);
  assert.equal((await data(await runtime('PENDING'))).applyErrorCode, null);
  await data(await report(next));
});

test('creator names are included in administrator persona responses without leaking into AI configuration', async () => {
  const version = await create();
  assert.equal(version.createdByAdminUserSeq, actorIds[0]);
  assert.equal(version.createdByAdminUserName, '설정 테스트 관리자');
  const updated = await data(
    await patch(version.aiPersonaSeq, { expectedVersion: 1, name: '작성자 확인 버전' }),
  );
  assert.equal(updated.createdByAdminUserName, '설정 테스트 관리자');
  const detail = await data(await call('GET', `/api/personas/${version.aiPersonaSeq}`));
  assert.equal(detail.latestVersion.createdByAdminUserName, '설정 테스트 관리자');
  const listed = await (await call('GET', '/api/personas?limit=100')).json();
  assert.equal(
    listed.data.find((row) => row.aiPersonaSeq === version.aiPersonaSeq).latestVersion
      .createdByAdminUserName,
    '설정 테스트 관리자',
  );
  const versions = await (
    await call('GET', `/api/personas/${version.aiPersonaSeq}/versions`)
  ).json();
  assert.equal(versions.total_count, 2);
  assert.ok(versions.data.every((row) => row.createdByAdminUserName === '설정 테스트 관리자'));
  const pending = await data(await activate(updated), 202);
  assert.equal(pending.createdByAdminUserName, '설정 테스트 관리자');
  assert.equal('createdByAdminUserName' in (await data(await runtime('PENDING'))), false);
  assert.equal('createdByAdminUserName' in (await data(await report(pending))), false);
  assert.equal('createdByAdminUserName' in (await data(await runtime())), false);
});

async function legacyVersion(actorId, recordAudit = true) {
  const { AiSettingsRepository } = require('../dist/ai-settings/ai-settings.repository');
  const { AuditService } = require('../dist/audit/audit.service');
  const { DatabaseService } = require('../dist/database/database.service');
  return app.get(DatabaseService).transaction(async (client) => {
    const repository = app.get(AiSettingsRepository);
    const id = await repository.create('legacy-' + randomUUID(), client);
    const version = await repository.append(id, 1, input(), actorId, client);
    if (recordAudit)
      await app.get(AuditService).recordSuccess(
        {
          actorId,
          targetId: version.aiPersonaVersionSeq,
          targetType: 'AI_PERSONA_VERSION',
          action: 'PERSONA_CREATED',
          requestId: randomUUID(),
        },
        client,
      );
    return version;
  });
}

test('logical creator references and audit-backed names survive physical administrator deletion and login ID reuse', async () => {
  const loginId = 'legacy-' + randomUUID();
  const creator = (
    await pool.query(
      "INSERT INTO admin_users(login_id,name,password_hash,role,status) VALUES($1,'삭제 전 작성자','not-for-login','OPERATOR','ACTIVE') RETURNING admin_user_seq",
      [loginId],
    )
  ).rows[0].admin_user_seq;
  // 과거 작성자를 표현하는 DB fixture. 현재 SYSTEM_ADMIN 생성·삭제 권한 정책은 변경하지 않는다.
  const version = await legacyVersion(creator);
  assert.equal(
    (await data(await call('GET', `/api/personas/${version.aiPersonaSeq}`))).latestVersion
      .createdByAdminUserName,
    '삭제 전 작성자',
  );
  assert.equal((await call('DELETE', `/api/admins/${creator}`)).status, 204);
  assert.equal(
    (await pool.query('SELECT count(*) FROM admin_users WHERE admin_user_seq=$1', [creator]))
      .rows[0].count,
    '0',
  );
  const rows = await (await call('GET', `/api/personas/${version.aiPersonaSeq}/versions`)).json();
  assert.equal(rows.data[0].createdByAdminUserSeq, creator);
  assert.equal(rows.data[0].createdByAdminUserName, '삭제 전 작성자');
  const replacement = (
    await pool.query(
      "INSERT INTO admin_users(login_id,name,password_hash,role,status) VALUES($1,'새 관리자','not-for-login','OPERATOR','ACTIVE') RETURNING admin_user_seq",
      [loginId],
    )
  ).rows[0].admin_user_seq;
  assert.notEqual(replacement, creator);
  assert.equal(
    (await data(await call('GET', `/api/personas/${version.aiPersonaSeq}`))).latestVersion
      .createdByAdminUserName,
    '삭제 전 작성자',
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='ai_persona_versions' AND column_name='created_by_admin_user_name'",
      )
    ).rows[0].count,
    '0',
  );
});

test('unknown legacy creator names remain null and another actor on the same version cannot be misattributed', async () => {
  const version = await legacyVersion(2147483647, false);
  const { AuditService } = require('../dist/audit/audit.service');
  const { DatabaseService } = require('../dist/database/database.service');
  await app.get(DatabaseService).transaction((client) =>
    app.get(AuditService).recordSuccess(
      {
        actorId: actorIds[0],
        targetId: version.aiPersonaVersionSeq,
        targetType: 'AI_PERSONA_VERSION',
        action: 'PERSONA_APPLY_REQUESTED',
        requestId: randomUUID(),
      },
      client,
    ),
  );
  const detail = await data(await call('GET', `/api/personas/${version.aiPersonaSeq}`));
  assert.equal(detail.latestVersion.createdByAdminUserSeq, 2147483647);
  assert.equal(detail.latestVersion.createdByAdminUserName, null);
  const noCreator = await legacyVersion(null, false);
  assert.equal(
    (await data(await call('GET', `/api/personas/${noCreator.aiPersonaSeq}`))).latestVersion
      .createdByAdminUserName,
    null,
  );
});
