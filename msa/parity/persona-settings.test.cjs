const { truncateFixture } = require('./fixture-reset.cjs');
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { Pool } = require('pg');
const { hashPassword } = require('../dist/auth/password');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('persona APIs preserve production HTTP, complete settings, drafts, publication and audit data', async (t) => {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.PGDATABASE, 'dva_webhook_test');
  const started = Date.now();
  const sides = ['monolith', 'operations'].map((name) => ({
    name, base: `http://${name}-app:3005`, db: new Pool({ host: `${name}-db`, connectionTimeoutMillis: 2000 }),
    cookies: {}, revisions: new Map(), applications: new Map(),
  }));
  t.after(async () => { await Promise.all(sides.map((side) => side.db.end())); });
  const ai = async (side, control) => {
    const response = await fetch(`http://persona-fixture:8000/${side.name}/__${control ? 'control' : 'state'}`, {
      method: control ? 'POST' : 'GET', headers: {
        Authorization: 'Bearer ' + process.env.AI_PERSONA_TOKEN, ...(control ? { 'Content-Type': 'application/json' } : {}),
      }, body: control ? JSON.stringify(control) : undefined,
    });
    assert.equal(response.status, control ? 204 : 200);
    return control ? undefined : response.json();
  };
  for (const side of sides) {
    for (let attempt = 0; ; attempt++) {
      try { if ((await fetch(side.base + '/api/docs-json')).ok) break; } catch { /* Startup. */ }
      assert.ok(attempt < 60, side.name + ' unavailable');
      await delay(500);
    }
    // Drafts are logical references, so CASCADE from personas cannot clear prior suites.
    await truncateFixture(side.db, 'TRUNCATE ai_personas,ai_persona_drafts,admin_users,audit_logs RESTART IDENTITY CASCADE');
    assert.equal((await side.db.query('SELECT count(*) FROM ai_persona_drafts')).rows[0].count, '0');
  }
  const hash = await hashPassword('persona-parity-password');
  const created = new Date().toISOString();
  for (const side of sides) for (const [index, role] of ['SYSTEM_ADMIN', 'SUPERVISOR', 'OPERATOR'].entries()) {
    await side.db.query(`INSERT INTO admin_users(login_id,name,password_hash,role,status,created_at)
      VALUES($1,$2,$3,$4,'ACTIVE',$5)`, ['personaadmin' + index, '관리자 ' + index, hash, role, created]);
  }
  const legacy = async () => (await sides[1].db.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY ai_persona_seq) FROM legacy_ai_personas p) AS identities,
    (SELECT jsonb_agg(to_jsonb(v) ORDER BY ai_prompt_version_seq) FROM legacy_ai_prompt_versions v) AS prompts`)).rows;
  const legacyBefore = await legacy();
  const opaque = (side, value, key) => {
    assert.match(value, uuid, key);
    const map = /draft/i.test(key) ? side.revisions : side.applications;
    if (!map.has(value)) map.set(value, `${/draft/i.test(key) ? 'revision' : 'application'}-${map.size + 1}`);
    return map.get(value);
  };
  const normalize = (side, value, key = '') => {
    // Notification observation races with foreground responses; completion is checked below.
    if (['lastNotifiedAt', 'last_notified_at'].includes(key)) {
      if (value !== null) assert.ok(new Date(value).getTime() >= started - 2000 && new Date(value).getTime() <= Date.now() + 2000);
      return '<asynchronous notification observation>';
    }
    if (value === null || value === undefined) return value;
    if (['draftRevision', 'draft_revision', 'applicationId', 'application_id'].includes(key)) return opaque(side, value, key);
    if (value instanceof Date || /(?:At|_at)$/.test(key)) {
      const timestamp = new Date(value).getTime();
      assert.ok(Number.isFinite(timestamp) && timestamp >= started - 2000 && timestamp <= Date.now() + (/expires/i.test(key) ? 9 * 3600_000 : 2000), key);
      return '<timestamp>';
    }
    if (Array.isArray(value)) return value.map((entry) => normalize(side, entry));
    if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([field, entry]) => [field, normalize(side, entry, field)]));
    return value;
  };
  const settle = async (side) => {
    for (let attempt = 0; ; attempt++) {
      const row = (await side.db.query("SELECT ai_persona_version_seq,application_id,last_notified_at,apply_error_code FROM ai_persona_versions WHERE status='PENDING'")).rows[0];
      if (!row) return;
      const peer = await ai(side);
      const notified = peer.notifications.some((item) => item.applicationId === row.application_id && item.aiPersonaVersionSeq === row.ai_persona_version_seq);
      const errorExpected = peer.refreshStatus === 202 ? row.apply_error_code !== 'AI_UNAVAILABLE' : row.apply_error_code !== null;
      if (row.last_notified_at && notified && errorExpected) return;
      assert.ok(attempt < 160, side.name + ' worker did not settle');
      await delay(50);
    }
  };
  const readTables = async (side) => {
    const data = {};
    for (const [table, order] of [['ai_personas', 'ai_persona_seq'], ['ai_persona_versions', 'ai_persona_version_seq'],
      ['ai_persona_drafts', 'ai_persona_seq'], ['audit_logs', 'audit_log_seq']]) {
      data[table] = (await side.db.query(`SELECT * FROM ${table} ORDER BY ${order}`)).rows;
    }
    return data;
  };
  const snapshot = async (side) => normalize(side, await readTables(side));
  let requests = 0;
  async function request(method, path, input, expected, actor = 0, headers = {}) {
    const requestId = randomUUID();
    const results = [];
    for (const side of sides) {
      const body = typeof input === 'function' ? input(side) : input;
      const response = await fetch(side.base + path, { method, redirect: 'manual', headers: Object.fromEntries(Object.entries({
        Origin: 'http://localhost:5173', 'X-Request-Id': requestId, 'Content-Type': 'application/json',
        Cookie: actor === null ? undefined : side.cookies[actor],
        ...headers,
      }).filter(([, value]) => value !== undefined)), body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await response.text();
      assert.equal(response.status, expected, `${side.name}: ${method} ${path}: ${text}`);
      assert.equal(response.headers.get('x-request-id'), requestId);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const cookie = response.headers.get('set-cookie');
      if (cookie) {
        const token = /^dva_session=([0-9a-f]{64});/.exec(cookie)?.[1];
        assert.ok(token);
        assert.match(cookie, /Path=\/api;.*HttpOnly;.*Secure;.*SameSite=Lax/);
        const session = (await side.db.query('SELECT created_at,expires_at FROM admin_sessions WHERE session_token_hash=$1', [createHash('sha256').update(token).digest('hex')])).rows[0];
        assert.equal(session.expires_at - session.created_at, 9 * 3600_000);
        side.cookies[actor] = cookie.split(';')[0];
      }
      results.push({ raw: text ? JSON.parse(text) : undefined, headers: {
        origin: response.headers.get('access-control-allow-origin'), credentials: response.headers.get('access-control-allow-credentials'),
        location: response.headers.get('location'),
      } });
    }
    assert.deepEqual({ ...results[1], raw: normalize(sides[1], results[1].raw) }, { ...results[0], raw: normalize(sides[0], results[0].raw) }, method + ' ' + path + ' HTTP');
    await Promise.all(sides.map(settle));
    assert.deepEqual(await snapshot(sides[1]), await snapshot(sides[0]), method + ' ' + path + ' DB');
    assert.deepEqual(await legacy(), legacyBefore, 'new API must not change legacy settings');
    requests++;
    return results.map((result) => result.raw?.data);
  }
  for (let actor = 0; actor < 3; actor++) await request('POST', '/api/auth/login', { loginId: 'personaadmin' + actor, password: 'persona-parity-password' }, 200, actor);
  const documents = await Promise.all(sides.map(async (side) => (await fetch(side.base + '/api/docs-json')).json()));
  const declarations = {
    '/api/personas': ['get', 'post'], '/api/personas/{id}': ['get', 'patch'],
    '/api/personas/{id}/versions': ['get', 'post'], '/api/personas/{id}/activate': ['post'],
    '/api/ai/options': ['get'], '/api/ai/config': ['get'], '/api/ai/config/apply-result': ['post'],
  };
  const refs = new Set();
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    if (value.$ref) {
      const name = value.$ref.split('/').pop();
      if (!refs.has(name)) { refs.add(name); visit(documents[0].components.schemas[name]); }
    }
    Object.values(value).forEach(visit);
  };
  for (const [path, methods] of Object.entries(declarations)) for (const method of methods) {
    assert.deepEqual(documents[1].paths[path][method], documents[0].paths[path][method], method + path);
    visit(documents[0].paths[path][method]);
  }
  for (const name of refs) assert.deepEqual(documents[1].components.schemas[name], documents[0].components.schemas[name], name);
  for (const name of ['bearer', 'adminSession']) assert.deepEqual(documents[1].components.securitySchemes[name], documents[0].components.securitySchemes[name]);
  const auth = { Authorization: 'Bearer ' + process.env.AI_PERSONA_TOKEN };
  const promptFields={role:' 원문\n줄 바꿈  ',personality:'차분함',tone:'친절함',speedInstruction:'천천히',backchannel:'네',interruption:'고객 우선'};
  const expectedPrompt=`# 페르소나\n\n## 역할\n${promptFields.role}\n\n## 성격\n${promptFields.personality}\n\n## 발화 스타일\n### 톤\n${promptFields.tone}\n\n### 속도\n${promptFields.speedInstruction}\n\n## 맞장구\n${promptFields.backchannel}\n\n## 끼어들기\n${promptFields.interruption}`;
  const settings = { code: 'same-parcel', name: ' 상담원 ', ...promptFields, voiceId: 'test-voice', speakingRate: 1.2, turnWaitLevel: 'LONG' };
  for (const actor of [0, 1, 2]) await request('GET', '/api/personas', undefined, 200, actor);
  await request('GET', '/api/personas', undefined, 401, null);
  await request('GET', '/api/personas', undefined, 401, null, { Cookie: 'dva_session=invalid' });
  await request('GET', '/api/ai/config', undefined, 404, null, auth);
  await request('GET', '/api/ai/config?status=PENDING', undefined, 404, 0);
  for (const actor of [1, 2]) await request('GET', '/api/ai/config', undefined, 403, actor);
  await request('GET', '/api/ai/config', undefined, 401, null, { Authorization: 'Bearer wrong' });
  await request('GET', '/api/ai/config', undefined, 401, null, { ...auth, Cookie: 'dva_session=invalid' });
  for (const actor of [0, 1]) await request('GET', '/api/ai/options', undefined, 200, actor);
  await request('GET', '/api/ai/options', undefined, 403, 2);
  await request('POST', '/api/personas', settings, 403, 2);
  await request('POST', '/api/personas', settings, 403, 0, { Origin: undefined });
  for (const extra of [{ promptText: '' }, { voiceId: 'not-supported' }, { speakingRate: 2 }, { turnWaitLevel: 'BAD' }, { extra: 'unknown' }]) {
    await request('POST', '/api/personas', { ...settings, ...extra }, 'voiceId' in extra || 'speakingRate' in extra ? 422 : 400);
  }
  for(const field of Object.keys(promptFields))for(const value of ['',null,9])await request('POST','/api/personas',{...settings,[field]:value},400);
  await request('POST','/api/personas',{...settings,role:'😀'.repeat(20000)},422);
  for (const optionsMode of ['unavailable', 'invalid', 'malformed', 'large', 'redirect', 'slow']) {
    await Promise.all(sides.map((side) => ai(side, { optionsMode })));
    await request('POST', '/api/personas', settings, 503);
  }
  await Promise.all(sides.map((side) => ai(side, { optionsMode: 'ok' })));
  const versions = await request('POST', '/api/personas', settings, 201);
  const id = versions[0].aiPersonaSeq;
  const versionId = versions[0].aiPersonaVersionSeq;
  assert.equal(versions[0].promptText, expectedPrompt);
  for(const [field,value]of Object.entries(promptFields))assert.equal(versions[0][field],value);
  assert.equal(versions[0].createdByAdminUserName, '관리자 0');
  await request('POST', '/api/personas', settings, 409);
  for (const actor of [0, 1, 2]) {
    await request('GET', `/api/personas/${id}`, undefined, 200, actor);
    await request('GET', `/api/personas/${id}/versions?limit=1&offset=0`, undefined, 200, actor);
  }
  for (const path of ['/api/personas?limit=0', '/api/personas/1x', '/api/personas/2147483648', '/api/ai/config?status=INACTIVE']) await request('GET', path, undefined, 400, 0, auth);
  await request('GET', '/api/personas/2147483647', undefined, 404);
  await request('GET', '/api/personas?offset=1000', undefined, 200);
  await request('PATCH', `/api/personas/${id}`, { expectedVersion: 1, expectedDraftRevision: null }, 400);
  await request('PATCH', `/api/personas/${id}`, { expectedVersion: 1, name: 'missing revision' }, 400);
  const draft = await request('PATCH', `/api/personas/${id}`, { expectedVersion: 1, expectedDraftRevision: null, name: '초안', voiceId: null }, 200, 1);
  const draftInput = (side) => ({ expectedVersion: 1, expectedDraftRevision: draft[sides.indexOf(side)].draftRevision, name: '초안' });
  await request('PATCH', `/api/personas/${id}`, draftInput, 200, 1);
  await request('PATCH', `/api/personas/${id}`, { expectedVersion: 1, expectedDraftRevision: null, name: 'stale' }, 409);
  await request('POST', `/api/personas/${id}/versions`, { expectedVersion: 1, expectedDraftRevision: randomUUID() }, 409);
  const committed = await request('POST', `/api/personas/${id}/versions`, (side) => ({ expectedVersion: 1, expectedDraftRevision: draft[sides.indexOf(side)].draftRevision }), 200);
  assert.equal(committed[0].version, 2);
  assert.equal(committed[0].voiceId, null);
  assert.equal(committed[0].promptText, expectedPrompt);
  await request('POST', `/api/personas/${id}/versions`, (side) => ({ expectedVersion: 1, expectedDraftRevision: draft[sides.indexOf(side)].draftRevision }), 409);
  await request('POST', `/api/personas/${id}/activate`, { expectedVersion: 1, aiPersonaVersionSeq: versionId }, 409);
  const activate = { expectedVersion: 2, aiPersonaVersionSeq: committed[0].aiPersonaVersionSeq };
  const pending = await request('POST', `/api/personas/${id}/activate`, activate, 202);
  await request('POST', `/api/personas/${id}/activate`, activate, 202);
  const callback = (rows, result, extra = {}) => (side) => ({ aiPersonaVersionSeq: rows[sides.indexOf(side)].aiPersonaVersionSeq, applicationId: rows[sides.indexOf(side)].applicationId, result, ...extra });
  await request('GET', '/api/ai/config?status=PENDING', undefined, 200, null, auth);
  await request('POST', '/api/ai/config/apply-result', callback(pending, 'APPLIED'), 401, 0);
  await request('POST', '/api/ai/config/apply-result', callback(pending, 'FAILED'), 400, null, auth);
  await request('POST', '/api/ai/config/apply-result', callback(pending, 'FAILED', { errorCode: 'UNSUPPORTED_OPTIONS' }), 200, null, auth);
  const retried = await request('POST', `/api/personas/${id}/activate`, activate, 202);
  for (let i = 0; i < sides.length; i++) assert.notEqual(retried[i].applicationId, pending[i].applicationId);
  await request('POST', '/api/ai/config/apply-result', callback(pending, 'APPLIED'), 409, null, auth);
  await request('POST', '/api/ai/config/apply-result', callback(retried, 'APPLIED', { activeCallCount: -1 }), 400, null, auth);
  await request('POST', '/api/ai/config/apply-result', callback(retried, 'APPLIED', { activeCallCount: 9 }), 200, null, auth);
  await request('POST', '/api/ai/config/apply-result', callback(retried, 'APPLIED'), 200, null, auth);
  await request('GET', '/api/ai/config', undefined, 200, null, auth);
  await request('GET', '/api/ai/config', undefined, 200, 0);
  await request('POST', `/api/personas/${id}/activate`, activate, 200);
  const unchangedDraft = await request('PATCH', `/api/personas/${id}`, { expectedVersion: 2, expectedDraftRevision: null, name: '초안' }, 200);
  const unchanged = await request('POST', `/api/personas/${id}/versions`, (side) => ({ expectedVersion: 2, expectedDraftRevision: unchangedDraft[sides.indexOf(side)].draftRevision }), 200);
  assert.equal(unchanged[0].version, 2);
  for (const side of sides) await side.db.query(`CREATE FUNCTION parity_fail_persona_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.result='SUCCESS' AND NEW.action='PERSONA_CREATED' THEN RAISE EXCEPTION 'controlled audit failure'; END IF;
    RETURN NEW; END $$; CREATE TRIGGER parity_fail_persona_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION parity_fail_persona_audit();`);
  try { await request('POST', '/api/personas', { ...settings, code: 'failed-creation' }, 500); }
  finally { for (const side of sides) await side.db.query('DROP TRIGGER parity_fail_persona_audit ON audit_logs; DROP FUNCTION parity_fail_persona_audit();'); }
  const next = await request('POST', '/api/personas', { code: 'other-type', name: '다른 유형', ...promptFields, role:'새 원문' }, 201, 1);
  assert.equal(next[0].voiceId, null);
  assert.equal(next[0].speakingRate, null);
  assert.equal(next[0].turnWaitLevel, 'NORMAL');
  const nextPending = await request('POST', `/api/personas/${next[0].aiPersonaSeq}/activate`, { expectedVersion: 1, aiPersonaVersionSeq: next[0].aiPersonaVersionSeq }, 202);
  await request('POST', '/api/ai/config/apply-result', callback(nextPending, 'APPLIED'), 200, null, auth);
  for (const side of sides) assert.equal((await side.db.query('SELECT previous_active_version_seq FROM ai_persona_versions WHERE ai_persona_version_seq=$1', [next[0].aiPersonaVersionSeq])).rows[0].previous_active_version_seq, committed[0].aiPersonaVersionSeq);
  await request('GET', '/api/personas/?limit=1&offset=1', undefined, 200, 2);
  await request('GET', '/api/personas?limit=1&offset=2', undefined, 200, 2);
  await request('GET', `/api/personas/${id}/versions?limit=1&offset=1`, undefined, 200, 2);
  // Leave a failed notification to verify recovery after actual process SIGKILL.
  await Promise.all(sides.map((side) => ai(side, { refreshStatus: 503 })));
  await request('POST', `/api/personas/${id}/activate`, activate, 202);
  for (const side of sides) {
    const row = (await side.db.query("SELECT status,application_id,apply_error_code FROM ai_persona_versions WHERE status='PENDING'")).rows[0];
    assert.equal(row.apply_error_code, 'AI_UNAVAILABLE');
    assert.match(row.application_id, uuid);
  }
  const beforeRestart = {};
  for (const side of sides) beforeRestart[side.name] = { tables: await readTables(side), peer: await ai(side) };
  require('node:fs').writeFileSync('/app/service/test/persona-before-restart.json', JSON.stringify(beforeRestart));
  console.log(JSON.stringify({ requestsPerSide: requests, declarations: 10, schemas: refs.size, environment: 'production', worker: 'real 5s timer and HTTP peer' }));
});
