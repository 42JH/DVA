const { truncateFixture } = require('./fixture-reset.cjs');
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { Pool } = require('pg');
const { hashPassword, verifyPassword } = require('../dist/auth/password');

test('identical production HTTP requests produce identical auth/admin/audit data', async (t) => {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.PGDATABASE, 'dva_webhook_test');
  const started = Date.now();
  const sides = ['monolith', 'operations'].map((name) => ({
    name, base: `http://${name}-app:3005`,
    db: new Pool({ host: `${name}-db`, connectionTimeoutMillis: 2000 }), cookies: {},
  }));
  t.after(async () => { await Promise.all(sides.map((side) => side.db.end())); });
  for (const side of sides) {
    for (let attempt = 0; ; attempt++) {
      try {
        if ((await fetch(side.base + '/api/docs-json')).ok) break;
      } catch { /* A just-started production process may still be connecting to its DB. */ }
      assert.ok(attempt < 60, `${side.name} did not become ready`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  const password = 'original password';
  const passwords = new Map([['root', password], ['operator', password], ['supervisor', password]]);
  const hash = await hashPassword(password);
  const created = new Date().toISOString();
  for (const side of sides) {
    // These are labeled, private, disposable DBs, never production connections.
    await truncateFixture(side.db, 'TRUNCATE admin_users,audit_logs RESTART IDENTITY CASCADE');
    for (const [login, role] of [['root', 'SYSTEM_ADMIN'], ['operator', 'OPERATOR'], ['supervisor', 'SUPERVISOR']]) {
      await side.db.query(`INSERT INTO admin_users(login_id,name,password_hash,role,status,created_at)
        VALUES($1,$2,$3,$4,'ACTIVE',$5)`, [login, `이름 ${login}`, hash, role, created]);
    }
  }
  const normalize = (value, key = '') => {
    if (value === null || value === undefined) return value;
    if (value instanceof Date || /(?:At|_at)$/.test(key)) {
      const time = new Date(value).getTime();
      const future = /expires/i.test(key) ? 9 * 3600_000 : 0;
      assert.ok(Number.isFinite(time) && time >= started - 2000 && time <= Date.now() + future + 2000, key);
      return '<timestamp>';
    }
    if (Array.isArray(value)) return value.map((item) => normalize(item));
    if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v, k)]));
    return value;
  };
  const verifiedPasswords = new Map();
  async function snapshot(side) {
    const admins = (await side.db.query(`SELECT admin_user_seq,login_id,name,role,status,
      password_hash,created_at,last_login_at,deleted_at FROM admin_users ORDER BY admin_user_seq`)).rows;
    for (const row of admins) {
      const expectedPassword = passwords.get(row.login_id);
      assert.equal(typeof expectedPassword, 'string', row.login_id);
      if (verifiedPasswords.get(row.password_hash) !== expectedPassword) {
        assert.equal(await verifyPassword(expectedPassword, row.password_hash), true, row.login_id);
        verifiedPasswords.set(row.password_hash, expectedPassword);
      }
      delete row.password_hash;
    }
    const sessions = (await side.db.query(`SELECT admin_user_seq,session_token_hash,created_at,expires_at
      FROM admin_sessions ORDER BY admin_user_seq,created_at,session_token_hash`)).rows;
    for (const row of sessions) {
      assert.match(row.session_token_hash, /^[0-9a-f]{64}$/);
      assert.ok(!Object.values(side.cookies).some((cookie) => cookie.endsWith(row.session_token_hash)));
      assert.equal(row.expires_at - row.created_at, 9 * 3600_000);
      delete row.session_token_hash;
    }
    const audits = (await side.db.query(`SELECT audit_log_seq,actor_type,actor_seq,actor_name,action,
      target_type,target_seq,target_admin_name,request_id,result,metadata,occurred_at
      FROM audit_logs ORDER BY audit_log_seq`)).rows;
    return normalize({ admins, sessions, audits });
  }
  async function request(method, path, body, actor, expected, options = {}) {
    const requestId = randomUUID();
    const results = [];
    for (const side of sides) {
      const response = await fetch(side.base + path, {
        method, headers: {
          Origin: options.origin ?? 'http://localhost:5173', 'X-Request-Id': requestId,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(actor && side.cookies[actor] ? { Cookie: side.cookies[actor] } : {}),
        }, body: body === undefined ? undefined : JSON.stringify(body),
      });
      assert.equal(response.status, expected, `${side.name} ${method} ${path}`);
      assert.equal(response.headers.get('x-request-id'), requestId);
      if (path.startsWith('/api/')) assert.equal(response.headers.get('cache-control'), 'no-store');
      const cookie = response.headers.get('set-cookie');
      let flags = cookie;
      if (cookie) {
        assert.match(cookie, /; Path=\/api;/);
        assert.match(cookie, /; HttpOnly;/);
        assert.match(cookie, /; Secure;/);
        assert.match(cookie, /; SameSite=Lax/);
        if (options.login) {
          const token = /^dva_session=([0-9a-f]{64});/.exec(cookie)?.[1];
          assert.ok(token);
          assert.equal((await side.db.query('SELECT count(*) FROM admin_sessions WHERE session_token_hash=$1',
            [createHash('sha256').update(token).digest('hex')])).rows[0].count, '1');
          side.cookies[options.login] = cookie.split(';')[0];
        } else assert.match(cookie, /^dva_session=;.*Expires=Thu, 01 Jan 1970/);
        flags = cookie.replace(/^dva_session=[^;]*/, 'dva_session=<opaque>')
          .replace(/Expires=[^;]+/, 'Expires=<date>');
      }
      const text = await response.text();
      results.push({ body: text ? normalize(JSON.parse(text)) : undefined, flags,
        origin: response.headers.get('access-control-allow-origin'),
        credentials: response.headers.get('access-control-allow-credentials') });
    }
    assert.deepEqual(results[1], results[0], `${method} ${path} HTTP parity`);
    assert.deepEqual(await snapshot(sides[1]), await snapshot(sides[0]), `${method} ${path} DB parity`);
    return results[0].body;
  }
  async function healthControl(input) {
    for (const side of sides) {
      const response = await fetch('http://persona-fixture:8000/' + side.name + '/__control', {
        method: 'POST', headers: { Authorization: 'Bearer ' + process.env.PGPASSWORD,
          'Content-Type': 'application/json' }, body: JSON.stringify(input),
      });
      assert.equal(response.status, 204);
    }
  }
  await request('GET', '/health', undefined, undefined, 200);
  await request('GET', '/health/ready', undefined, undefined, 200);
  await healthControl({ healthStatus: 503 });
  await request('GET', '/health/ready', undefined, undefined, 503);
  await healthControl({ healthStatus: 200, healthHold: true });
  const healthStarted = Date.now();
  await request('GET', '/health/ready', undefined, undefined, 503);
  assert.ok(Date.now() - healthStarted >= 3900, 'both production AI probes enforce the 2s timeout');
  await healthControl({ healthHold: false });
  await request('GET', '/health/ready', undefined, undefined, 200);
  for (const side of sides) {
    const document = await (await fetch(side.base + '/api/docs-json')).json();
    assert.equal(document.paths['/health'], undefined);
    assert.equal(document.paths['/health/ready'], undefined);
  }
  const login = (id, pass = password, actor = id) => request('POST', '/api/auth/login',
    { loginId: id, password: pass }, actor, 200, { login: actor });
  await request('GET', '/api/auth/me', undefined, undefined, 401);
  await request('POST', '/api/auth/signup', { loginId: 'bad-id', name: '신청', password }, undefined, 400);
  await request('POST', '/api/auth/signup', { loginId: 'pending', name: '신청', password, role: 'SYSTEM_ADMIN' }, undefined, 400);
  passwords.set('pending', password);
  await request('POST', '/api/auth/signup', { loginId: 'pending', name: '신청', password }, undefined, 204);
  await request('POST', '/api/auth/signup', { loginId: 'pending', name: '중복', password }, undefined, 409);
  await request('POST', '/api/auth/login', { loginId: 'pending', password }, undefined, 403);
  await request('POST', '/api/auth/login', { loginId: 'root', password: 'incorrect' }, undefined, 401);
  await login('root');
  await login('supervisor');
  await login('operator');
  await request('GET', '/api/auth/me', undefined, 'root', 200);
  await request('GET', '/api/admins?status=PENDING&limit=1&offset=0', undefined, 'root', 200);
  for(const q of ['', '  ', 'root','운영','%', '_'])await request('GET','/api/admins?'+new URLSearchParams({q}),undefined,'root',200);
  for(const q of ['x'.repeat(101),'\u0000'])await request('GET','/api/admins?'+new URLSearchParams({q}),undefined,'root',400);
  await request('GET', '/api/admins', undefined, 'operator', 403);
  await request('PATCH', '/api/admins/4', {}, 'root', 400);
  await request('PATCH', '/api/admins/4', { status: 'ACTIVE', role: 'SUPERVISOR' }, 'root', 204);
  await login('pending');
  await request('PATCH', '/api/admins/2', { role: 'SUPERVISOR' }, 'root', 204);
  await request('GET', '/api/audit-logs?limit=2&offset=0', undefined, 'operator', 200);
  await request('PATCH', '/api/admins/1', { status: 'INACTIVE' }, 'root', 403);
  await request('PATCH', '/api/admins/2', { status: 'INACTIVE' }, 'root', 204);
  await request('GET', '/api/auth/me', undefined, 'operator', 401);
  await request('POST', '/api/auth/login', { loginId: 'operator', password }, undefined, 403);
  await request('PATCH', '/api/admins/2', { status: 'ACTIVE' }, 'root', 204);
  await login('operator');
  passwords.set('operator', 'dva1234');
  await request('PATCH', '/api/admins/2/password', {}, 'root', 204);
  await request('GET', '/api/auth/me', undefined, 'operator', 401);
  await login('operator', 'dva1234');
  await request('PATCH', '/api/auth/password', { currentPassword: 'bad', newPassword: 'changed password',
    newPasswordConfirm: 'changed password' }, 'operator', 422);
  passwords.set('operator', 'changed password');
  await request('PATCH', '/api/auth/password', { currentPassword: 'dva1234', newPassword: 'changed password',
    newPasswordConfirm: 'changed password' }, 'operator', 204);
  await request('GET', '/api/auth/me', undefined, 'operator', 401);
  await login('operator', 'changed password');
  await request('POST', '/api/auth/logout', undefined, 'operator', 204);
  await request('POST', '/api/auth/logout', undefined, 'operator', 204);
  await request('PATCH', '/api/admins/4', { role: 'OPERATOR' }, 'root', 403, { origin: 'https://untrusted.invalid' });
  await request('DELETE', '/api/admins/4', undefined, 'root', 204);
  await request('GET', '/api/auth/me', undefined, 'pending', 401);
  await request('GET', '/api/admins?offset=99999', undefined, 'root', 200);
  await request('POST', '/api/auth/signup', { loginId: 'pending', name: '재신청', password }, undefined, 204);
  await request('GET', '/api/audit-logs?result=FAILED&offset=99999', undefined, 'root', 200);
  await request('GET', '/api/audit-logs?actorType=ADMIN&limit=100', undefined, 'supervisor', 200);
  await request('GET', '/api/audit-logs/1', undefined, 'root', 200);
  await request('GET', '/api/audit-logs/0', undefined, 'root', 400);
  await request('GET', '/api/audit-logs?result=INVALID', undefined, 'root', 400);
  await request('OPTIONS', '/api/auth/login', undefined, undefined, 204);
  t.diagnostic(`${verifiedPasswords.size} distinct persisted password hashes verified; unchanged hashes reused`);
});
