require('reflect-metadata');
process.env.CORS_ORIGINS = 'http://localhost:5173';
process.env.SWAGGER_ENABLED = 'true';
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { randomBytes } = require('node:crypto');
const { NestFactory } = require('@nestjs/core');
const { Controller, Get, Module } = require('@nestjs/common');
const { AppModule } = require('../dist/app.module');
const { configureApplication } = require('../dist/configure-application');
const { DatabaseService } = require('../dist/database/database.service');
const { AuthService, tokenHash } = require('../dist/auth/auth.service');
const { AuthRepository } = require('../dist/auth/auth.repository');
const { AdminsService } = require('../dist/admins/admins.service');
const { AuditService } = require('../dist/audit/audit.service');
const { Roles } = require('../dist/auth/auth.guard');
const { hashPassword } = require('../dist/auth/password');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.DB_NAME, 'dva_webhook_test');
assert.ok(['db', '127.0.0.1'].includes(process.env.DB_HOST));
class RoleFixture {
  read() {
    return { ok: true };
  }
  edit() {
    return { ok: true };
  }
}
Controller('role-check')(RoleFixture);
for (const method of ['read', 'edit'])
  Get(method)(
    RoleFixture.prototype,
    method,
    Object.getOwnPropertyDescriptor(RoleFixture.prototype, method),
  );
Roles('SUPERVISOR', 'SYSTEM_ADMIN')(
  RoleFixture.prototype,
  'edit',
  Object.getOwnPropertyDescriptor(RoleFixture.prototype, 'edit'),
);
class TestModule {}
Module({ imports: [AppModule], controllers: [RoleFixture] })(TestModule);
const prefix = 't' + randomBytes(2).toString('hex');
const password = 'valid pass123';
let app, db, base, hash;
const logs = [];
async function call(method, path, body, cookie, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      Origin: 'http://localhost:5173',
      'X-CSRF-Protection': '1',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text ? JSON.parse(text) : undefined,
    cookie: res.headers.get('set-cookie'),
    headers: res.headers,
    text,
  };
}
async function account(suffix, role = 'OPERATOR', status = 'ACTIVE') {
  const loginId = prefix + suffix;
  assert.match(loginId, /^[A-Za-z0-9]{1,20}$/);
  const row = (
    await db.pool.query(
      `INSERT INTO admin_users(login_id,name,password_hash,role,status) VALUES($1,$2,$3,$4,$5) RETURNING admin_user_seq`,
      [loginId, '테스트 ' + suffix, hash, role, status],
    )
  ).rows[0];
  return { id: row.admin_user_seq, loginId };
}
async function login(user, pass = password, cookie) {
  const result = await call(
    'POST',
    '/api/auth/login',
    { loginId: user.loginId, password: pass },
    cookie,
  );
  if (result.status === 200) result.session = result.cookie.split(';')[0];
  return result;
}
before(async () => {
  app = await NestFactory.create(TestModule, { logger: false });
  configureApplication(app, { log: (row) => logs.push(row) });
  await app.init();
  db = app.get(DatabaseService);
  // The Docker runner supplies an isolated empty database, never a production connection.
  for (const name of ['002-monolith-initial.sql', '003-admin-auth-sessions.sql'])
    await db.transaction((client) =>
      client.query(readFileSync(join(__dirname, '../migrations', name), 'utf8')),
    );
  hash = await hashPassword(password);
  await app.listen(0, '0.0.0.0');
  base = await app.getUrl();
});
after(async () => {
  if (app) await app.close();
});
test('bootstrap CLI creates one active system administrator and refuses a second without leaking input', async () => {
  const { spawnSync } = require('node:child_process');
  const run = () =>
    spawnSync(
      process.execPath,
      [join(__dirname, '../scripts/bootstrap-admin.cjs'), prefix + 'bootstrap', 'Bootstrap'],
      { env: process.env, input: 'bootstrap pass\n', encoding: 'utf8' },
    );
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.ok(!first.stdout.includes('bootstrap pass'));
  assert.equal((await login({ loginId: prefix + 'bootstrap' }, 'bootstrap pass')).status, 200);
  const second = run();
  assert.equal(second.status, 1);
  assert.ok(!second.stderr.includes('bootstrap pass'));
  assert.equal(
    (
      await db.pool.query('SELECT count(*) FROM admin_users WHERE login_id=$1', [
        prefix + 'bootstrap',
      ])
    ).rows[0].count,
    '1',
  );
});
test('AUTH-01 rejects wrong and case-mismatched credentials and issues a nine-hour session', async () => {
  const user = await account('loginOnly');
  assert.equal((await login(user, 'incorrect')).status, 401);
  assert.equal((await login({ loginId: user.loginId.toUpperCase() })).status, 401);
  const result = await login(user);
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.body.data), ['expiresAt']);
  const token = result.session.split('=')[1];
  assert.equal((await app.get(AuthService).authenticate(token)).adminUserSeq, user.id);
  const row = (
    await db.pool.query('SELECT * FROM admin_sessions WHERE session_token_hash=$1', [
      tokenHash(token),
    ])
  ).rows[0];
  assert.equal(row.expires_at - row.created_at, 9 * 60 * 60 * 1000);
});
test('AUTH-02 removes only the presented session and accepts missing or expired sessions', async () => {
  const user = await account('logoutOnly');
  const first = await login(user);
  const second = await login(user);
  assert.equal((await call('POST', '/api/auth/logout', undefined, first.session)).status, 204);
  await assert.rejects(
    app.get(AuthService).authenticate(first.session.split('=')[1]),
    (error) => error.getStatus() === 401,
  );
  assert.equal(
    (await app.get(AuthService).authenticate(second.session.split('=')[1])).adminUserSeq,
    user.id,
  );
  assert.equal((await call('POST', '/api/auth/logout')).status, 204);
  await db.pool.query(
    "UPDATE admin_sessions SET created_at=now()-interval '10 hours',expires_at=now()-interval '1 hour' WHERE admin_user_seq=$1",
    [user.id],
  );
  assert.equal((await call('POST', '/api/auth/logout', undefined, second.session)).status, 204);
});
test('signup preserves name, rejects bad IDs and elevation, duplicate signup is atomic, pending cannot login', async () => {
  const loginId = prefix + 'signup';
  for (const invalid of ['', 'with-dash', 'with space', '한글', 'a'.repeat(21)])
    assert.equal(
      (await call('POST', '/api/auth/signup', { loginId: invalid, password, name: 'Name' })).status,
      400,
    );
  for (const name of ['', ' \t', null])
    assert.equal((await call('POST', '/api/auth/signup', { loginId, password, name })).status, 400);
  assert.equal(
    (await call('POST', '/api/auth/signup', { loginId, password: '12345', name: 'Name' })).status,
    400,
  );
  assert.equal(
    (
      await call('POST', '/api/auth/signup', {
        loginId,
        password,
        name: 'Name',
        role: 'SYSTEM_ADMIN',
      })
    ).status,
    400,
  );
  const responses = await Promise.all(
    [1, 2].map(() => call('POST', '/api/auth/signup', { loginId, password, name: ' 가입자 ' })),
  );
  assert.deepEqual(responses.map((x) => x.status).sort(), [204, 409]);
  assert.equal(responses.find((x) => x.status === 409).body.error.code, 'SIGNUP_UNAVAILABLE');
  assert.equal(responses.find((x) => x.status === 204).cookie, null);
  const row = (await db.pool.query('SELECT * FROM admin_users WHERE login_id=$1', [loginId]))
    .rows[0];
  assert.equal(row.name, ' 가입자 ');
  assert.equal(row.role, 'OPERATOR');
  assert.equal(row.status, 'PENDING');
  assert.notEqual(row.password_hash, password);
  assert.equal((await login({ loginId })).status, 401);
  assert.equal((await login({ loginId: loginId.toUpperCase() })).status, 401);
});
test('login issues opaque cookie, me redacts secrets, expiry is fixed, logout revokes only current session', async () => {
  const user = await account('sessions');
  const first = await login(user);
  const second = await login(user);
  assert.equal(first.status, 200);
  assert.match(first.cookie, /HttpOnly/);
  assert.match(first.cookie, /SameSite=Lax/);
  assert.match(first.cookie, /Path=\/api/);
  assert.deepEqual(Object.keys(first.body.data), ['expiresAt']);
  const token = first.session.split('=')[1];
  const row = (
    await db.pool.query('SELECT * FROM admin_sessions WHERE session_token_hash=$1', [
      tokenHash(token),
    ])
  ).rows[0];
  assert.equal(row.expires_at - row.created_at, 9 * 60 * 60 * 1000);
  assert.notEqual(row.session_token_hash, token);
  const me = await call('GET', '/api/auth/me', undefined, first.session);
  assert.equal(me.status, 200);
  assert.deepEqual(
    Object.keys(me.body.data).sort(),
    ['adminUserSeq', 'loginId', 'name', 'role', 'status'].sort(),
  );
  assert.equal((await login(user, 'wrong password')).status, 401);
  assert.equal((await call('POST', '/api/auth/logout', undefined, first.session)).status, 204);
  assert.equal((await call('GET', '/api/auth/me', undefined, first.session)).status, 401);
  assert.equal((await call('GET', '/api/auth/me', undefined, second.session)).status, 200);
  assert.equal((await call('POST', '/api/auth/logout')).status, 204);
  await db.pool.query(
    "UPDATE admin_sessions SET created_at=now()-interval '10 hours',expires_at=now()-interval '1 hour' WHERE admin_user_seq=$1",
    [user.id],
  );
  assert.equal((await call('GET', '/api/auth/me', undefined, second.session)).status, 401);
});
test('login rotates presented session and CSRF rejects missing/foreign origins and simple requests', async () => {
  const user = await account('csrf');
  const first = await login(user);
  const second = await login(user, password, first.session);
  assert.notEqual(first.session, second.session);
  assert.equal((await call('GET', '/api/auth/me', undefined, first.session)).status, 401);
  for (const headers of [
    { Origin: '' },
    { Origin: 'https://evil.invalid' },
    { 'X-CSRF-Protection': '' },
  ]) {
    assert.equal(
      (await call('POST', '/api/auth/logout', undefined, second.session, headers)).status,
      403,
    );
    assert.equal(
      (
        await call(
          'POST',
          '/api/auth/login',
          { loginId: user.loginId, password },
          undefined,
          headers,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          'POST',
          '/api/auth/signup',
          { loginId: prefix + 'csrfnew', password, name: 'Name' },
          undefined,
          headers,
        )
      ).status,
      403,
    );
  }
  assert.equal((await call('GET', '/api/auth/me', undefined, second.session)).status, 200);
  const preflight = await call('OPTIONS', '/api/auth/login', undefined, undefined, {
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type,x-csrf-protection',
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');
});
test('new routes default to authenticated; roles and current DB status are enforced on every request', async () => {
  const user = await account('role');
  const session = (await login(user)).session;
  assert.equal((await call('GET', '/api/role-check/read')).status, 401);
  assert.equal((await call('GET', '/api/role-check/read', undefined, session)).status, 200);
  assert.equal((await call('GET', '/api/role-check/edit', undefined, session)).status, 403);
  assert.equal((await call('GET', '/api/admins', undefined, session)).status, 403);
  await db.pool.query("UPDATE admin_users SET role='SUPERVISOR' WHERE admin_user_seq=$1", [
    user.id,
  ]);
  assert.equal((await call('GET', '/api/role-check/edit', undefined, session)).status, 200);
  await db.pool.query("UPDATE admin_users SET status='PENDING' WHERE admin_user_seq=$1", [user.id]);
  assert.equal((await call('GET', '/api/auth/me', undefined, session)).status, 401);
});
test('system admin approves pending accounts, filters lists, rejects empty/null patches and deactivation', async () => {
  const system = await account('system', 'SYSTEM_ADMIN');
  const session = (await login(system)).session;
  const pending = await account('pending', 'OPERATOR', 'PENDING');
  assert.equal(
    (await call('PATCH', `/api/admins/${pending.id}`, { status: 'ACTIVE' }, session)).status,
    204,
  );
  assert.equal((await login(pending)).status, 200);
  assert.equal(
    (await call('PATCH', `/api/admins/${pending.id}`, { status: 'PENDING' }, session)).status,
    409,
  );
  for (const body of [{}, { role: null }, { status: null }, { name: 'X' }])
    assert.equal((await call('PATCH', `/api/admins/${pending.id}`, body, session)).status, 400);
  assert.equal((await call('PATCH', '/api/admins/1e2', { role: 'OPERATOR' }, session)).status, 400);
  assert.equal(
    (await call('PATCH', '/api/admins/2147483647', { role: 'OPERATOR' }, session)).status,
    404,
  );
  const list = await call(
    'GET',
    '/api/admins?role=OPERATOR&status=ACTIVE&limit=1',
    undefined,
    session,
  );
  assert.equal(list.status, 200);
  assert.deepEqual(Object.keys(list.body).sort(), ['data', 'hasNext']);
  assert.equal(list.body.data.length, 1);
  assert.equal(list.body.hasNext, true);
  assert.equal(list.body.data[0].passwordHash, undefined);
  const audit = (
    await db.pool.query(
      "SELECT * FROM audit_logs WHERE target_seq=$1 AND action='ADMIN_ACCESS_CHANGED'",
      [pending.id],
    )
  ).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor_seq, system.id);
});
test('own password change validates confirmation, preserves failed sessions, revokes all sessions on success', async () => {
  const user = await account('ownpass');
  const first = (await login(user)).session;
  const second = (await login(user)).session;
  for (const [input, reason] of [
    [
      { currentPassword: 'wrong', newPassword: 'new pass', newPasswordConfirm: 'new pass' },
      'INCORRECT_PASSWORD',
    ],
    [
      { currentPassword: password, newPassword: 'new pass', newPasswordConfirm: 'different' },
      'PASSWORD_MISMATCH',
    ],
    [
      { currentPassword: password, newPassword: '123', newPasswordConfirm: '123' },
      'PASSWORD_POLICY_VIOLATION',
    ],
  ]) {
    const res = await call('PATCH', '/api/auth/password', input, first);
    assert.equal(res.status, 422);
    assert.equal(res.body.error.details[0].reason, reason);
  }
  assert.equal((await call('GET', '/api/auth/me', undefined, second)).status, 200);
  const res = await call(
    'PATCH',
    '/api/auth/password',
    { currentPassword: password, newPassword: ' new pass ', newPasswordConfirm: ' new pass ' },
    first,
  );
  assert.equal(res.status, 204);
  assert.match(res.cookie, /Expires=Thu, 01 Jan 1970/);
  for (const cookie of [first, second])
    assert.equal((await call('GET', '/api/auth/me', undefined, cookie)).status, 401);
  assert.equal((await login(user)).status, 401);
  assert.equal((await login(user, ' new pass ')).status, 200);
});
test('system reset revokes only target sessions, preserves pending state, and self reset clears caller cookie', async () => {
  const system = await account('resetter', 'SYSTEM_ADMIN');
  const session = (await login(system)).session;
  const target = await account('resetTarget');
  const old = (await login(target)).session;
  assert.equal(
    (
      await call(
        'PATCH',
        `/api/admins/${target.id}/password`,
        { newPassword: 'reset pass' },
        session,
      )
    ).status,
    204,
  );
  assert.equal((await call('GET', '/api/auth/me', undefined, old)).status, 401);
  assert.equal((await call('GET', '/api/auth/me', undefined, session)).status, 200);
  assert.equal((await login(target, 'reset pass')).status, 200);
  const pending = await account('resetPending', 'OPERATOR', 'PENDING');
  assert.equal(
    (
      await call(
        'PATCH',
        `/api/admins/${pending.id}/password`,
        { newPassword: 'reset pass' },
        session,
      )
    ).status,
    204,
  );
  assert.equal((await login(pending, 'reset pass')).status, 401);
  const self = await call(
    'PATCH',
    `/api/admins/${system.id}/password`,
    { newPassword: 'reset self' },
    session,
  );
  assert.equal(self.status, 204);
  assert.match(self.cookie, /Expires=Thu, 01 Jan 1970/);
});
test('audit failure rolls back password and session deletion; logout storage failure is not success', async () => {
  const system = await account('atomic', 'SYSTEM_ADMIN');
  const session = (await login(system)).session;
  const audit = app.get(AuditService);
  const original = audit.record;
  audit.record = async () => {
    throw new Error('private diagnostic');
  };
  try {
    assert.equal(
      (
        await call(
          'PATCH',
          `/api/admins/${system.id}/password`,
          { newPassword: 'rollback pass' },
          session,
        )
      ).status,
      500,
    );
  } finally {
    audit.record = original;
  }
  assert.equal((await call('GET', '/api/auth/me', undefined, session)).status, 200);
  assert.equal((await login(system)).status, 200);
  const repository = app.get(AuthRepository);
  const remove = repository.remove;
  repository.remove = async () => {
    throw new Error('db unavailable');
  };
  try {
    const result = await call('POST', '/api/auth/logout', undefined, session);
    assert.equal(result.status, 503);
    assert.equal(result.cookie, null);
  } finally {
    repository.remove = remove;
  }
});
test('password reset waits for in-flight login and invalidates its session after commit', async () => {
  const system = await account('concurrentAdmin', 'SYSTEM_ADMIN');
  const adminSession = (await login(system)).session;
  const target = await account('concurrentUser');
  const admins = app.get(AdminsService);
  const original = admins.recordLogin.bind(admins);
  let entered, release;
  const reached = new Promise((resolve) => (entered = resolve));
  const hold = new Promise((resolve) => (release = resolve));
  admins.recordLogin = async (id, client) => {
    if (id === target.id) {
      entered();
      await hold;
    }
    return original(id, client);
  };
  const loggingIn = login(target);
  try {
    await Promise.race([
      reached,
      loggingIn.then((result) => {
        throw new Error(`Login did not reach transaction barrier: ${result.status}`);
      }),
    ]);
    const resetting = call(
      'PATCH',
      `/api/admins/${target.id}/password`,
      { newPassword: 'concurrent pass' },
      adminSession,
    );
    release();
    const loggedIn = await loggingIn;
    assert.equal(loggedIn.status, 200);
    assert.equal((await resetting).status, 204);
    assert.equal((await call('GET', '/api/auth/me', undefined, loggedIn.session)).status, 401);
    assert.equal((await login(target)).status, 401);
  } finally {
    release();
    admins.recordLogin = original;
  }
});
test('concurrent self-demotions preserve the last active system administrator', async () => {
  await db.pool.query("UPDATE admin_users SET role='OPERATOR' WHERE role='SYSTEM_ADMIN'");
  const first = await account('lastOne', 'SYSTEM_ADMIN');
  const second = await account('lastTwo', 'SYSTEM_ADMIN');
  const firstSession = (await login(first)).session;
  const secondSession = (await login(second)).session;
  const responses = await Promise.all(
    [
      [first, firstSession],
      [second, secondSession],
    ].map(([user, cookie]) =>
      call('PATCH', `/api/admins/${user.id}`, { role: 'OPERATOR' }, cookie),
    ),
  );
  assert.deepEqual(responses.map((r) => r.status).sort(), [204, 409]);
  assert.equal(
    (
      await db.pool.query(
        "SELECT count(*) FROM admin_users WHERE role='SYSTEM_ADMIN' AND status='ACTIVE'",
      )
    ).rows[0].count,
    '1',
  );
});
test('OpenAPI documents all eight contracts and logs contain no passwords or tokens', async () => {
  const document = await (await fetch(base + '/api/docs-json')).json();
  for (const [path, method] of [
    ['/api/auth/login', 'post'],
    ['/api/auth/logout', 'post'],
    ['/api/auth/me', 'get'],
    ['/api/auth/signup', 'post'],
    ['/api/auth/password', 'patch'],
    ['/api/admins', 'get'],
    ['/api/admins/{id}', 'patch'],
    ['/api/admins/{id}/password', 'patch'],
  ])
    assert.ok(document.paths[path][method]);
  assert.equal(document.components.securitySchemes.adminSession.in, 'cookie');
  const serialized = JSON.stringify(logs);
  assert.ok(!serialized.includes(password));
  assert.ok(!serialized.includes('dva_session='));
});

test('prepare disposable runtime account for production-image cookie checks', async () => {
  await db.pool.query(
    "INSERT INTO admin_users(login_id,name,password_hash,role,status) VALUES('runtimeAdmin83','Runtime test',$1,'OPERATOR','ACTIVE')",
    [await hashPassword('runtime-only-password')],
  );
});
