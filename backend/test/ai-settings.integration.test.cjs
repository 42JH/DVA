require('reflect-metadata');
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
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
  aiStatus = 200;
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
  if (!(await pool.query("SELECT to_regclass('public.ai_personas') AS name")).rows[0].name) {
    for (const file of readdirSync(join(__dirname, '../migrations'))
      .filter((f) => /^\d{3}-.+\.sql$/.test(f))
      .sort())
      await pool.query(readFileSync(join(__dirname, '../migrations', file), 'utf8'));
  } else if (
    !(await pool.query("SELECT to_regclass('public.ai_persona_versions') AS name")).rows[0].name
  ) {
    await pool.query('BEGIN');
    try {
      await pool.query(
        readFileSync(join(__dirname, '../migrations/013-ai-persona-versions.sql'), 'utf8'),
      );
      await pool.query('COMMIT');
    } catch (failure) {
      await pool.query('ROLLBACK');
      throw failure;
    }
  }
  ai = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    if (request.url === '/internal/persona/options') {
      response.writeHead(aiStatus, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(aiResponse));
    } else if (request.url === '/internal/persona/refresh') {
      let body = '';
      for await (const part of request) body += part;
      notifications.push(JSON.parse(body));
      response.writeHead(202);
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
  const history = await data(
    await call('GET', `/api/personas/${v1.aiPersonaSeq}/versions?limit=2`),
  );
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
  assert.deepEqual(Object.keys(body).sort(), ['data', 'hasNext']);
  assert.equal(body.data.length, 1);
  assert.equal(body.hasNext, true);
});

test('Swagger documents persona inputs, whole versions and concise English tags without spec IDs', async () => {
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
    assert.doesNotMatch(operation.summary, /AI-\d/);
    assert.ok(operation.tags.every((tag) => /^[A-Za-z ]+$/.test(tag)));
    assert.ok(operation.responses['200'] || operation.responses['201']);
  }
  assert.ok(spec.components.schemas.PersonaVersionDto.properties.applyErrorCode.description);
  const log = JSON.stringify(logs);
  assert.ok(!log.includes(token));
  assert.ok(!log.includes('원문'));
});
