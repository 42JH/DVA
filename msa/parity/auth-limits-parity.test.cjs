require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { hashPassword } = require('../dist/auth/password');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('production auth limits preserve envelopes, Retry-After, pool slots and audit exclusion', async t => {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.PGDATABASE, 'dva_webhook_test');
  const sides = ['monolith', 'operations'].map(name => ({
    base: `http://${name}-app:3005`, db: new Pool({ host: `${name}-db` }),
  }));
  t.after(() => Promise.all(sides.map(side => side.db.end())));
  const password = 'limits-parity-password', loginId = 'limitparity';
  const hash = await hashPassword(password);
  for (const side of sides) await side.db.query(
    "INSERT INTO admin_users(login_id,name,password_hash,role,status) VALUES($1,'limits parity',$2,'OPERATOR','ACTIVE')", [loginId, hash]);
  async function call(side, body, headers = {}, requestId = randomUUID()) {
    const response = await fetch(side.base + '/api/auth/' + (headers.signup ? 'signup' : 'login'), {
      method: 'POST', signal: AbortSignal.timeout(10000), headers: {
        Origin: 'http://localhost:5173', 'Content-Type': 'application/json', 'X-Request-Id': requestId,
        'X-Forwarded-For': '192.0.2.200', ...Object.fromEntries(Object.entries(headers).filter(([key]) => key !== 'signup')),
      }, body: JSON.stringify(body),
    });
    const value = await response.json();
    assert.equal(response.headers.get('x-request-id'), requestId);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    return { status: response.status, value, response };
  }
  async function both(body, status, headers = {}, retryBounds) {
    const id = randomUUID(), results = [];
    for (const side of sides) {
      const result = await call(side, body, headers, id);
      assert.equal(result.status, status, JSON.stringify(result.value));
      if (retryBounds) {
        const seconds = Number(result.response.headers.get('retry-after'));
        assert.ok(Number.isInteger(seconds) && seconds >= retryBounds[0] && seconds <= retryBounds[1]);
        assert.equal(result.response.headers.get('set-cookie'), null);
        assert.equal(result.value.error.code, 'RATE_LIMITED');
        assert.deepEqual(result.value.error.details, []);
      } else assert.equal(result.response.headers.get('retry-after'), null);
      results.push(result.value);
    }
    assert.deepEqual(results[1], results[0]);
  }
  const auditCounts = async () => Promise.all(sides.map(async side => (await side.db.query('SELECT count(*)::int n FROM audit_logs')).rows[0].n));
  for (let i = 0; i < 5; i++) await both({ loginId: 'unknownlimit', password }, 401);
  let before = await auditCounts();
  await both({ loginId: 'unknownlimit', password }, 429, {}, [295, 300]);
  assert.deepEqual(await auditCounts(), before);
  // Guard runs before DTO validation, so malformed signup attempts consume the same IP allowance.
  for (let i = 0; i < 5; i++) await both({ loginId: 'invalid-id', name: 'invalid', password }, 400, { signup: true });
  before = await auditCounts();
  await both({ loginId: 'invalid-id', name: 'invalid', password }, 429, { signup: true }, [590, 600]);
  assert.deepEqual(await auditCounts(), before);
  await both({ loginId, password }, 429, { 'X-Dva-Auth-Limited': '1' }, [2, 2]);
  assert.deepEqual(await auditCounts(), before);
  for (const side of sides) {
    const authenticated = await call(side, { loginId, password });
    assert.equal(authenticated.status, 200);
    const cookie = authenticated.response.headers.get('set-cookie').split(';')[0];
    const blocker = await side.db.connect();
    const pending = [];
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM admin_users WHERE login_id=$1 FOR UPDATE', [loginId]);
      pending.push(call(side, { loginId, password }), call(side, { loginId, password }));
      for (let retry = 0; ; retry++) {
        const count = (await side.db.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%admin_users%' AND pid<>pg_backend_pid()")).rows[0].n;
        if (count === 2) break;
        assert.ok(retry < 100, 'both password work slots must enter the DB');
        await delay(10);
      }
      const audits = (await side.db.query('SELECT count(*)::int n FROM audit_logs')).rows[0].n;
      const rejected = await call(side, { loginId, password });
      assert.equal(rejected.status, 429); assert.equal(rejected.response.headers.get('retry-after'), '1');
      assert.equal((await side.db.query('SELECT count(*)::int n FROM audit_logs')).rows[0].n, audits);
      const session = await fetch(side.base + '/api/auth/me', { headers: { Cookie: cookie } });
      assert.equal(session.status, 200);
    } finally {
      await blocker.query('ROLLBACK'); blocker.release();
      for (const result of await Promise.all(pending)) assert.equal(result.status, 200);
    }
  }
});
