require('reflect-metadata');
process.env.CORS_ORIGINS = 'http://localhost:5173';
process.env.AUTH_PROXY_HOPS = '0';
process.env.AI_BUSINESS_TOKEN ??= 's10-business-test-only-token-with-32-characters';
const { before, beforeEach, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../dist/app.module');
const { configureApplication } = require('../dist/configure-application');
const { DatabaseService } = require('../dist/database/database.service');
const { AdminsService } = require('../dist/admins/admins.service');
const { AuthLimitsService } = require('../dist/auth/auth-limits.service');
const { hashPassword } = require('../dist/auth/password');
const { migrate } = require('./helpers/migrations.cjs');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.DB_NAME, 'dva_webhook_test');
assert.ok(['db', '127.0.0.1'].includes(process.env.DB_HOST));
const origin = 'http://localhost:5173';
const prefix = 'limit' + randomBytes(3).toString('hex');
const password = 'valid password';
const DAY = 86_400_000;
let app,
  db,
  base,
  hash,
  now = Date.now();
const logs = [];

async function call(method, path, body, headers = {}) {
  const response = await fetch(base + path, {
    method,
    headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? JSON.parse(text) : undefined,
  };
}
const login = (loginId, pass = password, headers) =>
  call('POST', '/api/auth/login', { loginId, password: pass }, headers);
async function account(suffix, passwordHash = hash) {
  const loginId = prefix + suffix;
  await db.pool.query(
    "INSERT INTO admin_users(login_id,name,password_hash,role,status) VALUES($1,'S04 test',$2,'OPERATOR','ACTIVE')",
    [loginId, passwordHash],
  );
  return loginId;
}
function limited(result, seconds) {
  assert.equal(result.status, 429, JSON.stringify(result.body));
  assert.equal(result.body.error.code, 'RATE_LIMITED');
  assert.deepEqual(result.body.error.details, []);
  assert.equal(result.headers.get('retry-after'), String(seconds));
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(result.headers.get('access-control-allow-origin'), origin);
  assert.equal(result.headers.get('x-request-id'), result.body.meta.requestId);
  assert.equal(result.headers.get('set-cookie'), null);
}
before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApplication(app, { log: (event) => logs.push(event) });
  app.get(AuthLimitsService).now = () => now;
  await app.init();
  db = app.get(DatabaseService);
  await migrate(db.pool);
  hash = await hashPassword(password);
  await app.listen(0, '0.0.0.0');
  base = await app.getUrl();
});
beforeEach(() => {
  now += DAY;
});
after(async () => {
  if (app) await app.close();
});

test('security events correlate failed and successful logins, ignore forged IP headers and retain API contracts', async () => {
  const loginId = await account('S10');
  const start = logs.length;
  const first = await login(loginId, 'wrong password');
  const second = await login(loginId, 'wrong password', { 'X-Forwarded-For': '198.51.100.1' });
  assert.equal(first.status, 401);
  assert.equal(second.body.error.code, 'UNAUTHORIZED');
  const other = await login(loginId + 'x', 'wrong password');
  assert.equal(other.status, 401);
  const success = await login(loginId);
  assert.equal(success.status, 200);
  assert.match(success.headers.get('set-cookie'), /dva_session=/);
  const service = await call('GET', '/api/companies/search?q=securitytest');
  assert.equal(service.status, 401);
  const events = logs.slice(start).filter((row) => row.event.startsWith('authentication_'));
  assert.equal(events.length, 5);
  assert.equal(events[0].accountKey, events[1].accountKey);
  assert.equal(events[0].sourceKey, events[1].sourceKey);
  assert.notEqual(events[0].accountKey, events[2].accountKey);
  assert.equal(events[0].accountKey, events[3].accountKey);
  assert.equal(events[3].event, 'authentication_success');
  assert.equal(events[4].authType, 'ai_business');
  assert.equal(events[4].reason, 'invalid_service_token');
  assert.equal(events[0].requestId, first.body.meta.requestId);
  for (const secret of [loginId, password, 'wrong password', '198.51.100.1'])
    assert.ok(!JSON.stringify(events).includes(secret));
  const beforeLimits = logs.length;
  for (let index = 0; index < 5; index++)
    assert.equal((await login(loginId, 'wrong password')).status, 401);
  assert.equal((await login(loginId, 'wrong password')).status, 429);
  const limitedEvents = logs
    .slice(beforeLimits)
    .filter((row) => row.event === 'authentication_failure');
  assert.equal(limitedEvents.filter((row) => row.reason === 'invalid_credentials').length, 5);
  assert.equal(limitedEvents.filter((row) => row.reason === 'rate_limited').length, 1);
});

test('signup limits malformed attempts before validation/DB and ignores forged direct-peer IP headers', async () => {
  const input = { loginId: prefix + 'signup', password, name: ' ' };
  for (let index = 0; index < 5; index++) {
    const result = await call(
      'POST',
      '/api/auth/signup',
      { ...input, name: index === 0 ? 'x'.repeat(90_000) : ' ' },
      { 'X-Forwarded-For': '192.0.2.' + index },
    );
    assert.equal(result.status, 400);
  }
  limited(
    await call(
      'POST',
      '/api/auth/signup',
      { ...input, name: 'Name' },
      { 'X-Forwarded-For': '198.51.100.1', 'X-Real-IP': '198.51.100.2' },
    ),
    600,
  );
  assert.equal(
    (await db.pool.query('SELECT count(*) FROM admin_users WHERE login_id=$1', [input.loginId]))
      .rows[0].count,
    '0',
  );
  now += 60_000;
  limited(await call('POST', '/api/auth/signup', input), 540);
  now += 540_000;
  const name = ' ' + '이'.repeat(48) + ' ';
  const longPassword = ' ' + '비'.repeat(254) + ' ';
  const accepted = await call('POST', '/api/auth/signup', {
    ...input,
    name,
    password: longPassword,
  });
  assert.equal(accepted.status, 204);
  const stored = (
    await db.pool.query('SELECT name,password_hash,status FROM admin_users WHERE login_id=$1', [
      input.loginId,
    ])
  ).rows[0];
  assert.equal(stored.name, name);
  assert.equal(stored.status, 'PENDING');
  assert.notEqual(stored.password_hash, longPassword);
  assert.equal((await login(input.loginId, longPassword)).status, 403);
});

test('signup enforces twenty attempts in a rolling day after each ten-minute window has reopened', async () => {
  const input = { loginId: prefix + 'daily', password, name: ' ' };
  for (let batch = 0; batch < 4; batch++) {
    for (let index = 0; index < 5; index++)
      assert.equal((await call('POST', '/api/auth/signup', input)).status, 400);
    now += 600_000;
  }
  limited(await call('POST', '/api/auth/signup', input), 84_000);
  now += 84_000_000;
  assert.equal((await call('POST', '/api/auth/signup', input)).status, 400);
});

test('known and unknown IDs get the same cooldown across forged IPs and normal login resets failures', async () => {
  const known = await account('known');
  const unknown = prefix + 'unknown';
  for (const loginId of [known, unknown]) {
    for (let index = 0; index < 5; index++)
      assert.equal(
        (await login(loginId, 'incorrect', { 'X-Forwarded-For': '192.0.2.' + index })).status,
        401,
      );
    limited(await login(loginId), 300);
  }
  now += 60_000;
  limited(await login(known), 240);
  now += 240_000;
  assert.equal((await login(known)).status, 200);
  assert.equal((await login(unknown)).status, 401);
  for (let index = 0; index < 4; index++)
    assert.equal((await login(known, 'incorrect')).status, 401);
  assert.equal((await login(known)).status, 200);
  assert.equal((await login(known, 'incorrect')).status, 401);
});

test('existing passwords over 256 characters still login and can change to a bounded password', async () => {
  const legacy = ' 비밀 ' + 'x'.repeat(300);
  const loginId = await account('legacy', await hashPassword(legacy));
  const signedIn = await login(loginId, legacy);
  assert.equal(signedIn.status, 200);
  const headers = { Cookie: signedIn.headers.get('set-cookie').split(';')[0] };
  const tooLong = {
    currentPassword: legacy,
    newPassword: 'x'.repeat(257),
    newPasswordConfirm: 'x'.repeat(257),
  };
  assert.equal((await call('PATCH', '/api/auth/password', tooLong, headers)).status, 400);
  const next = ' ' + '비'.repeat(254) + ' ';
  assert.equal(
    (
      await call(
        'PATCH',
        '/api/auth/password',
        { currentPassword: legacy, newPassword: next, newPasswordConfirm: next },
        headers,
      )
    ).status,
    204,
  );
  assert.equal((await call('GET', '/api/auth/me', undefined, headers)).status, 401);
  assert.equal((await login(loginId, next)).status, 200);
});

test('two held login operations reject a third before its transaction while normal reads continue', async (t) => {
  const firstId = await account('slot1');
  const secondId = await account('slot2');
  const session = await login(firstId);
  const headers = { Cookie: session.headers.get('set-cookie').split(';')[0] };
  const admins = app.get(AdminsService);
  const find = admins.findForLogin.bind(admins);
  let entered = 0,
    release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  t.mock.method(admins, 'findForLogin', async (...args) => {
    entered++;
    await held;
    return find(...args);
  });
  const transaction = db.transaction.bind(db);
  const spy = t.mock.method(db, 'transaction', (...args) => transaction(...args));
  const first = login(firstId);
  const second = login(secondId);
  try {
    const deadline = Date.now() + 2000;
    while (entered < 2 && Date.now() < deadline) await delay(10);
    assert.equal(entered, 2);
    limited(await login(prefix + 'third'), 1);
    assert.equal(spy.mock.callCount(), 2);
    assert.equal((await call('GET', '/api/auth/me', undefined, headers)).status, 200);
    assert.equal(
      (
        await call('GET', '/api/ai/faqs', undefined, {
          Authorization: 'Bearer ' + process.env.AI_BUSINESS_TOKEN,
        })
      ).status,
      200,
    );
  } finally {
    release();
    const results = await Promise.all([first, second]);
    for (const result of results) assert.equal(result.status, 200);
  }
  assert.ok(logs.some((event) => event.statusCode === 429));
});
