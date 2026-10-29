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
test('login rotates presented session and Origin validation rejects missing/foreign origins', async () => {
  const user = await account('csrf');
  const first = await login(user);
  const second = await login(user, password, first.session);
  assert.notEqual(first.session, second.session);
  assert.equal((await call('GET', '/api/auth/me', undefined, first.session)).status, 401);
  for (const headers of [{ Origin: '' }, { Origin: 'https://evil.invalid' }]) {
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
      "SELECT * FROM audit_logs WHERE target_seq=$1 AND action='ADMIN_ACCESS_CHANGED' AND result='SUCCESS'",
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
test('concurrent self-demotions cannot change either system administrator', async () => {
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
  assert.deepEqual(
    responses.map((r) => r.status),
    [403, 403],
  );
  assert.equal(
    (
      await db.pool.query(
        "SELECT count(*) FROM admin_users WHERE admin_user_seq=ANY($1::int[]) AND role='SYSTEM_ADMIN' AND status='ACTIVE'",
        [[first.id, second.id]],
      )
    ).rows[0].count,
    '2',
  );
});
test('dedicated role change requires an active system administrator', async () => {
  const target = await account('accessTarget');
  for (const [method, path, body] of [
    ['PATCH', `/api/admins/${target.id}/role`, { role: 'SUPERVISOR' }],
  ]) {
    assert.equal((await call(method, path, body)).status, 401);
    assert.equal((await call(method, path, body, 'dva_session=invalid')).status, 401);
    for (const role of ['OPERATOR', 'SUPERVISOR']) {
      const actor = await account(`${method}${role === 'OPERATOR' ? 'Op' : 'Sup'}`, role);
      const session = (await login(actor)).session;
      assert.equal((await call(method, path, body, session)).status, 403);
    }
  }
  assert.equal((await login(target)).status, 200);
  assert.equal(
    (await db.pool.query('SELECT role FROM admin_users WHERE admin_user_seq=$1', [target.id]))
      .rows[0].role,
    'OPERATOR',
  );
});

test('dedicated role changes take effect on existing sessions without changing account status', async () => {
  const system = await account('roleManager', 'SYSTEM_ADMIN');
  const session = (await login(system)).session;
  const target = await account('roleTarget');
  const targetSession = (await login(target)).session;
  const path = `/api/admins/${target.id}/role`;
  assert.equal((await call('GET', '/api/role-check/edit', undefined, targetSession)).status, 403);
  const promoted = await call('PATCH', path, { role: 'SUPERVISOR' }, session);
  assert.equal(promoted.status, 204);
  assert.equal(promoted.text, '');
  assert.equal((await call('GET', '/api/role-check/edit', undefined, targetSession)).status, 200);
  assert.equal(
    (await call('GET', '/api/auth/me', undefined, targetSession)).body.data.status,
    'ACTIVE',
  );
  assert.equal((await call('PATCH', path, { role: 'OPERATOR' }, session)).status, 204);
  assert.equal((await call('GET', '/api/role-check/edit', undefined, targetSession)).status, 403);
  const pending = await account('pendingRole', 'OPERATOR', 'PENDING');
  assert.equal(
    (await call('PATCH', `/api/admins/${pending.id}/role`, { role: 'SUPERVISOR' }, session)).status,
    204,
  );
  assert.equal((await login(pending)).status, 401);
  assert.deepEqual(
    (
      await db.pool.query('SELECT role,status FROM admin_users WHERE admin_user_seq=$1', [
        pending.id,
      ])
    ).rows[0],
    { role: 'SUPERVISOR', status: 'PENDING' },
  );
});

test('both role routes protect system administrators and forbid promotion to system administrator', async () => {
  const system = await account('roleProtection', 'SYSTEM_ADMIN');
  const session = (await login(system)).session;
  const operator = await account('noSystem');
  for (const status of ['ACTIVE', 'PENDING']) {
    const target = await account(`system${status}`, 'SYSTEM_ADMIN', status);
    for (const suffix of ['', '/role']) {
      assert.equal(
        (await call('PATCH', `/api/admins/${target.id}${suffix}`, { role: 'OPERATOR' }, session))
          .status,
        403,
      );
      assert.equal(
        (
          await call(
            'PATCH',
            `/api/admins/${operator.id}${suffix}`,
            { role: 'SYSTEM_ADMIN' },
            session,
          )
        ).status,
        400,
      );
    }
    assert.deepEqual(
      (
        await db.pool.query('SELECT role,status FROM admin_users WHERE admin_user_seq=$1', [
          target.id,
        ])
      ).rows[0],
      { role: 'SYSTEM_ADMIN', status },
    );
  }
});

test('dedicated role change validates its body, target and Origin', async () => {
  const system = await account('roleValidation', 'SYSTEM_ADMIN');
  const session = (await login(system)).session;
  const target = await account('roleInput');
  const path = `/api/admins/${target.id}/role`;
  for (const body of [
    {},
    { role: null },
    { role: '' },
    { role: 'operator' },
    { role: 1 },
    { role: 'SUPERVISOR', status: 'ACTIVE' },
    { role: 'OPERATOR', name: 'changed' },
  ])
    assert.equal((await call('PATCH', path, body, session)).status, 400);
  for (const id of ['0', '-1', '1e2', '2147483648'])
    assert.equal(
      (await call('PATCH', `/api/admins/${id}/role`, { role: 'SUPERVISOR' }, session)).status,
      400,
    );
  assert.equal(
    (await call('PATCH', '/api/admins/2147483647/role', { role: 'SUPERVISOR' }, session)).status,
    404,
  );
  for (const Origin of ['', 'https://untrusted.invalid'])
    assert.equal(
      (await call('PATCH', path, { role: 'SUPERVISOR' }, session, { Origin })).status,
      403,
    );
});

test('dedicated role change and its success audit commit or roll back together', async () => {
  const system = await account('roleAtomicAdmin', 'SYSTEM_ADMIN');
  const session = (await login(system)).session;
  const target = await account('roleAtomicUser');
  const path = `/api/admins/${target.id}/role`;
  const audit = app.get(AuditService);
  const original = audit.record;
  audit.record = async () => {
    throw new Error('audit unavailable');
  };
  try {
    assert.equal((await call('PATCH', path, { role: 'SUPERVISOR' }, session)).status, 500);
  } finally {
    audit.record = original;
  }
  assert.equal(
    (await db.pool.query('SELECT role FROM admin_users WHERE admin_user_seq=$1', [target.id]))
      .rows[0].role,
    'OPERATOR',
  );
  assert.equal((await call('PATCH', path, { role: 'SUPERVISOR' }, session)).status, 204);
  const records = (
    await db.pool.query(
      "SELECT actor_seq,target_seq FROM audit_logs WHERE target_seq=$1 AND action='ADMIN_ACCESS_CHANGED' AND result='SUCCESS'",
      [target.id],
    )
  ).rows;
  assert.deepEqual(records, [{ actor_seq: system.id, target_seq: target.id }]);
});

test('OpenAPI documents authentication and admin contracts without leaking passwords or tokens', async () => {
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
    ['/api/admins/{id}/role', 'patch'],
  ])
    assert.ok(document.paths[path][method]);
  assert.equal(document.components.securitySchemes.adminSession.in, 'cookie');
  const role = document.paths['/api/admins/{id}/role'].patch;
  assert.deepEqual(role.tags, ['Admins']);
  assert.ok(role.responses['204']);
  assert.deepEqual(document.components.schemas.UpdateAdminRoleDto.required, ['role']);
  assert.deepEqual(document.components.schemas.UpdateAdminRoleDto.properties.role.enum, [
    'OPERATOR',
    'SUPERVISOR',
  ]);
  assert.deepEqual(document.components.schemas.UpdateAdminDto.properties.role.enum, [
    'OPERATOR',
    'SUPERVISOR',
  ]);
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
test('OPS-02 requires a session and permits only supervisors and system administrators', async () => {
  assert.equal((await call('GET', '/api/audit-logs')).status, 401);
  assert.equal(
    (await call('GET', '/api/audit-logs', undefined, 'dva_session=invalid')).status,
    401,
  );

  for (const [suffix, role, expected] of [
    ['auditOperator', 'OPERATOR', 403],
    ['auditSupervisor', 'SUPERVISOR', 200],
    ['auditSystem', 'SYSTEM_ADMIN', 200],
  ]) {
    const user = await account(suffix, role);
    const signedIn = await login(user);
    assert.equal(signedIn.status, 200);

    const response = await call('GET', '/api/audit-logs', undefined, signedIn.session);

    assert.equal(response.status, expected);
  }
});

test('OPS-02 filters, paginates, orders ties and excludes private metadata', async () => {
  const user = await account('auditReader', 'SUPERVISOR');
  const signedIn = await login(user);
  assert.equal(signedIn.status, 200);

  const action = prefix + '_AUDIT_LIST';
  const inserted = [];

  for (const [occurredAt, result] of [
    ['2026-01-01T00:00:00Z', 'SUCCESS'],
    ['2026-01-02T00:00:00Z', 'DENIED'],
    ['2026-01-02T00:00:00Z', 'FAILED'],
    ['2026-01-03T00:00:00Z', 'SUCCESS'],
  ]) {
    const row = await db.pool.query(
      `INSERT INTO audit_logs(
        actor_type, actor_seq, action, target_type, target_seq,
        request_id, result, metadata, occurred_at
      )
      VALUES(
        'ADMIN', $1, $2, 'ADMIN_USER', $1,
        $3, $4, $5::jsonb, $6::timestamptz
      )
      RETURNING audit_log_seq`,
      [
        user.id,
        action,
        require('node:crypto').randomUUID(),
        result,
        JSON.stringify({ password: 'must-not-be-exposed' }),
        occurredAt,
      ],
    );
    inserted.push(row.rows[0].audit_log_seq);
  }

  const filters = {
    actorSeq: String(user.id),
    action,
    targetType: 'ADMIN_USER',
    targetSeq: String(user.id),
    from: '2026-01-01T00:00:00Z',
    to: '2026-01-03T00:00:00Z',
    limit: '2',
  };

  const read = (extra = {}) =>
    call(
      'GET',
      '/api/audit-logs?' + new URLSearchParams({ ...filters, ...extra }),
      undefined,
      signedIn.session,
    );

  const first = await read();
  assert.equal(first.status, 200);
  assert.deepEqual(
    first.body.data.map((row) => row.auditLogSeq),
    [inserted[2], inserted[1]],
  );
  assert.equal(first.body.hasNext, true);
  assert.deepEqual(Object.keys(first.body).sort(), ['data', 'hasNext']);
  assert.ok(first.body.data.every((row) => Object.keys(row.metadata).length === 0));
  assert.ok(!first.text.includes('must-not-be-exposed'));

  const second = await read({ offset: '2' });
  assert.equal(second.status, 200);
  assert.deepEqual(
    second.body.data.map((row) => row.auditLogSeq),
    [inserted[0]],
  );
  assert.equal(second.body.hasNext, false);

  for (const [result, id] of [
    ['SUCCESS', inserted[0]],
    ['DENIED', inserted[1]],
    ['FAILED', inserted[2]],
  ]) {
    const response = await read({ result });
    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.data.map((row) => row.auditLogSeq),
      [id],
    );
  }

  for (const extra of [
    { actorSeq: String(user.id + 100000) },
    { targetSeq: String(user.id + 100000) },
    { targetType: 'NO_SUCH_TARGET' },
    { action: action + "' OR 1=1 --" },
    { offset: '100' },
  ]) {
    const response = await read(extra);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { data: [], hasNext: false });
  }

  const systemAction = action + '_SYSTEM';
  await db.pool.query(
    `INSERT INTO audit_logs(
      actor_type, actor_seq, action, target_type, target_seq,
      request_id, result, metadata
    )
    VALUES('SYSTEM', NULL, $1, 'ADMIN_USER', NULL, $2, 'SUCCESS', '{}')`,
    [systemAction, require('node:crypto').randomUUID()],
  );

  const system = await call(
    'GET',
    '/api/audit-logs?' + new URLSearchParams({ action: systemAction }),
    undefined,
    signedIn.session,
  );

  assert.equal(system.status, 200);
  assert.equal(system.body.data.length, 1);
  assert.equal(system.body.data[0].actorType, 'SYSTEM');
  assert.equal(system.body.data[0].actorSeq, null);
  assert.equal(system.body.data[0].targetSeq, null);
});

test('OPS-02 rejects invalid filters and documents the session-protected endpoint', async () => {
  const user = await account('auditValidation', 'SYSTEM_ADMIN');
  const signedIn = await login(user);
  assert.equal(signedIn.status, 200);

  for (const query of [
    { actorSeq: '0' },
    { actorSeq: '1e2' },
    { actorSeq: '2147483648' },
    { targetSeq: '-1' },
    { action: ' ' },
    { targetType: '' },
    { result: 'UNKNOWN' },
    { limit: '0' },
    { limit: '101' },
    { offset: '-1' },
    { from: 'not-a-date' },
    { from: '2026-02-30T00:00:00Z' },
    { from: '2026-01-01T00:00:00' },
    { from: '2026-01-02T00:00:00Z', to: '2026-01-01T00:00:00Z' },
    { from: '2026-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' },
  ]) {
    const response = await call(
      'GET',
      '/api/audit-logs?' + new URLSearchParams(query),
      undefined,
      signedIn.session,
    );

    assert.equal(response.status, 400, JSON.stringify(query));
    assert.equal(response.body.error.code, 'INVALID_REQUEST');
  }

  const document = await (await fetch(base + '/api/docs-json')).json();
  const operation = document.paths['/api/audit-logs'].get;

  assert.ok(operation);
  assert.ok(operation.security.some((entry) => 'adminSession' in entry));
  assert.ok(operation.responses['200']);

  const names = operation.parameters.map((parameter) => parameter.name);
  for (const name of [
    'actorSeq',
    'action',
    'targetType',
    'targetSeq',
    'result',
    'from',
    'to',
    'limit',
    'offset',
  ])
    assert.ok(names.includes(name), name);
});

test('audit detail enforces roles, validates IDs and returns a redacted immutable record', async () => {
  const { randomUUID } = require('node:crypto');
  const eventRequestId = randomUUID();
  const inserted = await db.pool.query(
    `INSERT INTO audit_logs(actor_type,actor_seq,action,target_type,target_seq,request_id,result,metadata)
     VALUES('SYSTEM',NULL,'DETAIL_TEST','ADMIN_USER',NULL,$1,'SUCCESS',$2::jsonb)
     RETURNING audit_log_seq`,
    [
      eventRequestId,
      JSON.stringify({ password: 'private-detail-secret', nested: { token: 'secret' } }),
    ],
  );
  const id = inserted.rows[0].audit_log_seq;
  const path = '/api/audit-logs/' + id;
  assert.equal((await call('GET', path)).status, 401);
  assert.equal((await call('GET', path, undefined, 'dva_session=invalid')).status, 401);
  let session;
  for (const [suffix, role, status] of [
    ['detailOp', 'OPERATOR', 403],
    ['detailSuper', 'SUPERVISOR', 200],
    ['detailAdmin', 'SYSTEM_ADMIN', 200],
  ]) {
    const user = await account(suffix, role);
    const signedIn = await login(user);
    assert.equal(signedIn.status, 200);
    session = signedIn.session;
    const response = await call('GET', path, undefined, session);
    assert.equal(response.status, status);
    if (status === 200) {
      assert.equal(response.body.data.auditLogSeq, id);
      assert.equal(response.body.data.requestId, eventRequestId);
      assert.equal(response.body.data.actorSeq, null);
      assert.equal(response.body.data.targetSeq, null);
      assert.deepEqual(response.body.data.metadata, {});
      assert.equal(response.body.meta.requestId, response.headers.get('x-request-id'));
      assert.notEqual(response.body.meta.requestId, eventRequestId);
      assert.ok(!response.text.includes('private-detail-secret'));
      const list = await call('GET', '/api/audit-logs?action=DETAIL_TEST', undefined, session);
      assert.equal(list.status, 200);
      assert.deepEqual(
        list.body.data.find((row) => row.auditLogSeq === id),
        response.body.data,
      );
    }
  }
  for (const invalid of ['0', '-1', '1.5', '1e2', 'abc', '2147483648', '1%20OR%201=1']) {
    const response = await call('GET', '/api/audit-logs/' + invalid, undefined, session);
    assert.equal(response.status, 400, invalid);
    assert.equal(response.body.error.code, 'INVALID_REQUEST');
  }
  const missing = await call('GET', '/api/audit-logs/2147483647', undefined, session);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'NOT_FOUND');
  const stored = await db.pool.query('SELECT metadata FROM audit_logs WHERE audit_log_seq=$1', [
    id,
  ]);
  assert.equal(stored.rows[0].metadata.password, 'private-detail-secret');
  const document = await (await fetch(base + '/api/docs-json')).json();
  const operation = document.paths['/api/audit-logs/{id}'].get;
  assert.ok(operation.security.some((entry) => 'adminSession' in entry));
  assert.ok(
    operation.parameters.some(
      (parameter) => parameter.name === 'id' && parameter.in === 'path' && parameter.required,
    ),
  );
  assert.ok(operation.responses['404']);
  assert.equal(
    operation.responses['200'].content['application/json'].schema.$ref,
    '#/components/schemas/AuditDetailResponseDto',
  );
});

test('audited mutations preserve actor, target and exactly one failure after guard/DTO/transaction rejection', async () => {
  const operator = await account('auditDenied');
  const session = (await login(operator)).session;
  const system = await account('auditWriter', 'SYSTEM_ADMIN');
  const systemSession = (await login(system)).session;
  const pending = await account('auditPending', 'OPERATOR', 'PENDING');
  const cases = [
    [
      'PATCH',
      `/api/admins/${pending.id}`,
      { status: 'ACTIVE' },
      session,
      403,
      'DENIED',
      operator.id,
    ],
    ['PATCH', `/api/admins/${pending.id}`, { role: null }, systemSession, 400, 'FAILED', system.id],
    [
      'POST',
      '/api/auth/login',
      { loginId: operator.loginId, password: 'wrong-secret' },
      undefined,
      401,
      'DENIED',
      null,
    ],
    ['PATCH', `/api/admins/${pending.id}`, { status: 'ACTIVE' }, undefined, 401, 'DENIED', null],
  ];
  for (const [method, path, body, cookie, status, result, actor] of cases) {
    const response = await call(method, path, body, cookie);
    assert.equal(response.status, status);
    const rows = (
      await db.pool.query('SELECT * FROM audit_logs WHERE request_id=$1', [
        response.body.meta.requestId,
      ])
    ).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].result, result);
    assert.equal(rows[0].actor_seq, actor);
    assert.deepEqual(rows[0].metadata, {});
    assert.ok(!JSON.stringify(rows).includes('wrong-secret'));
  }
  const audit = app.get(AuditService);
  const original = audit.record;
  audit.record = async () => {
    throw new Error('private audit failure');
  };
  let response;
  try {
    response = await call(
      'PATCH',
      `/api/admins/${pending.id}`,
      { status: 'ACTIVE' },
      systemSession,
    );
    assert.equal(response.status, 500);
  } finally {
    audit.record = original;
  }
  const rows = (
    await db.pool.query('SELECT * FROM audit_logs WHERE request_id=$1', [
      response.body.meta.requestId,
    ])
  ).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].result, 'FAILED');
  assert.equal(rows[0].target_seq, pending.id);
  assert.equal(
    (await db.pool.query('SELECT status FROM admin_users WHERE admin_user_seq=$1', [pending.id]))
      .rows[0].status,
    'PENDING',
  );
});

test('logout records one success with session deletion and failed audit storage does not hide original error', async () => {
  const user = await account('auditLogout');
  const session = (await login(user)).session;
  const response = await call('POST', '/api/auth/logout', undefined, session);
  assert.equal(response.status, 204);
  const rows = (
    await db.pool.query('SELECT * FROM audit_logs WHERE request_id=$1', [
      response.headers.get('x-request-id'),
    ])
  ).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'ADMIN_LOGOUT');
  assert.equal(rows[0].result, 'SUCCESS');
  assert.equal(rows[0].actor_seq, user.id);
  assert.equal((await call('GET', '/api/auth/me', undefined, session)).status, 401);
  const replay = await call('POST', '/api/auth/logout', undefined, session);
  assert.equal(replay.status, 204);
  assert.equal(
    (
      await db.pool.query('SELECT count(*) FROM audit_logs WHERE request_id=$1', [
        replay.headers.get('x-request-id'),
      ])
    ).rows[0].count,
    '0',
  );
  const { AuditRepository } = require('../dist/audit/audit.repository');
  const repository = app.get(AuditRepository);
  const original = repository.insert;
  repository.insert = async () => {
    throw new Error('private database failure');
  };
  try {
    const failure = await call('POST', '/api/auth/login', {
      loginId: user.loginId,
      password: 'wrong-secret',
    });
    assert.equal(failure.status, 401);
    assert.ok(!failure.text.includes('private database failure'));
  } finally {
    repository.insert = original;
  }
});
