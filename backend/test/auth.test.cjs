require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, verifyPassword } = require('../dist/auth/password');
const { readSessionToken } = require('../dist/auth/auth.guard');
const { cookieOptions } = require('../dist/auth/auth.controller');
const { tokenHash } = require('../dist/auth/auth.service');
const { AuthService } = require('../dist/auth/auth.service');
const { AuthLimitsService } = require('../dist/auth/auth-limits.service');
const { authClientIp, AuthLimitsGuard } = require('../dist/auth/auth-limits.guard');
const { RateLimitException } = require('../dist/common/errors/api.exception');
const { validateSync } = require('class-validator');
const { plainToInstance } = require('class-transformer');
const { LoginDto, SignupDto, ChangePasswordDto } = require('../dist/auth/dto/auth-request.dto');

function limitsFixture() {
  const limits = new AuthLimitsService();
  let now = 1_000_000;
  limits.now = () => now;
  return {
    limits,
    advance: (milliseconds) => {
      now += milliseconds;
    },
  };
}
const isLimited = (seconds) => (error) => {
  assert.ok(error instanceof RateLimitException);
  assert.equal(error.getStatus(), 429);
  if (seconds !== undefined) assert.equal(error.retryAfterSeconds, seconds);
  return true;
};

test('signup counts attempts in both rolling windows without extending a blocked window', () => {
  const { limits, advance } = limitsFixture();
  for (let batch = 0; batch < 4; batch++) {
    for (let attempt = 0; attempt < 5; attempt++) limits.checkSignup('192.0.2.1');
    assert.throws(() => limits.checkSignup('192.0.2.1'), isLimited(batch === 3 ? 84_600 : 600));
    if (batch === 0) {
      advance(100_000);
      assert.throws(() => limits.checkSignup('192.0.2.1'), isLimited(500));
      limits.checkSignup('192.0.2.2');
      advance(500_000);
    } else advance(600_000);
  }
  assert.throws(() => limits.checkSignup('192.0.2.1'), isLimited(84_000));
  advance(84_000_000);
  limits.checkSignup('192.0.2.1');
});

test('five failures block an ID for five minutes; blocked and in-flight failures cannot extend it', () => {
  const { limits, advance } = limitsFixture();
  for (let attempt = 0; attempt < 5; attempt++) {
    limits.checkLogin('operator');
    limits.recordLoginFailure('operator');
  }
  assert.throws(() => limits.checkLogin('operator'), isLimited(300));
  advance(60_000);
  limits.recordLoginFailure('operator');
  assert.throws(() => limits.checkLogin('operator'), isLimited(240));
  limits.checkLogin('Operator');
  advance(240_000);
  limits.checkLogin('operator');
  for (let attempt = 0; attempt < 4; attempt++) limits.recordLoginFailure('operator');
  limits.checkLogin('operator');
  limits.clearLogin('operator');
  limits.recordLoginFailure('operator');
  limits.checkLogin('operator');
});

test('account failures outside fifteen minutes expire and live counter storage is bounded', () => {
  const { limits, advance } = limitsFixture();
  for (let attempt = 0; attempt < 4; attempt++) limits.recordLoginFailure('operator');
  advance(900_000);
  limits.recordLoginFailure('operator');
  limits.checkLogin('operator');
  for (let index = 0; index < 9999; index++) limits.checkLogin('id' + index);
  assert.equal(limits.counters.size, 10_000);
  assert.throws(() => limits.checkLogin('overflow'), isLimited(60));
  for (let attempt = 0; attempt < 4; attempt++) limits.recordLoginFailure('operator');
  assert.throws(() => limits.checkLogin('operator'), isLimited(300));
  advance(900_000);
  limits.checkLogin('overflow');
  assert.equal(limits.counters.size, 1);
});

test('all HTTP password operations share two slots before obtaining a DB connection, and release on failure', async () => {
  const { limits } = limitsFixture();
  let calls = 0,
    release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const database = {
    transaction: async () => {
      calls++;
      await held;
      throw new Error('transaction failed');
    },
  };
  const auth = new AuthService(database, {}, {}, {}, limits);
  const first = auth.login({ loginId: 'first', password: 'password' }, 'request');
  const second = auth.login({ loginId: 'second', password: 'password' }, 'request');
  for (const work of [
    () => auth.login({ loginId: 'third', password: 'password' }, 'request'),
    () => auth.signup({ loginId: 'new', password: 'password', name: 'Name' }, 'request'),
    () =>
      auth.changePassword(
        'token',
        { currentPassword: 'password', newPassword: 'newpass', newPasswordConfirm: 'newpass' },
        'request',
      ),
    () => auth.resetPassword('token', 1, 'request'),
  ])
    await assert.rejects(work, isLimited(1));
  assert.equal(calls, 2);
  release();
  await Promise.all([
    assert.rejects(first, /transaction failed/),
    assert.rejects(second, /transaction failed/),
  ]);
  await assert.rejects(
    auth.login({ loginId: 'third', password: 'password' }, 'request'),
    /transaction failed/,
  );
  assert.equal(calls, 3);
});

test('authentication IP selection ignores untrusted headers and uses only the configured proxy tail', () => {
  const request = (forwarded) => ({
    socket: { remoteAddress: '::ffff:127.0.0.1' },
    get: () => forwarded,
  });
  assert.equal(authClientIp(request('192.0.2.99'), 0), '127.0.0.1');
  assert.equal(authClientIp(request('192.0.2.99, 198.51.100.7, 172.18.0.1'), 2), '198.51.100.7');
  assert.equal(authClientIp(request('198.51.100.7'), 1), '198.51.100.7');
  for (const value of [undefined, '198.51.100.7', 'invalid, 172.18.0.1', '198.51.100.7,'])
    assert.equal(authClientIp(request(value), 2), '127.0.0.1');
});

test('the signup guard separates authoritative client IPs, ignores forged prefixes and scopes the proxy marker', () => {
  const { AuthController } = require('../dist/auth/auth.controller');
  const { limits } = limitsFixture();
  const guard = new AuthLimitsGuard(limits, { get: () => 2 }, new Reflector());
  const context = (handler, forwarded, limited) => ({
    getHandler: () => handler,
    switchToHttp: () => ({
      getRequest: () => ({
        socket: { remoteAddress: '172.18.0.3' },
        get: (name) => (name === 'X-Forwarded-For' ? forwarded : limited),
      }),
    }),
  });
  for (let index = 0; index < 5; index++)
    assert.equal(
      guard.canActivate(
        context(AuthController.prototype.signup, `192.0.2.${index}, 198.51.100.1, 172.18.0.1`),
      ),
      true,
    );
  assert.throws(
    () =>
      guard.canActivate(
        context(AuthController.prototype.signup, '203.0.113.1, 198.51.100.1, 172.18.0.1'),
      ),
    isLimited(600),
  );
  assert.equal(
    guard.canActivate(context(AuthController.prototype.signup, '198.51.100.2, 172.18.0.1')),
    true,
  );
  assert.throws(
    () => guard.canActivate(context(AuthController.prototype.login, undefined, '1')),
    isLimited(2),
  );
  assert.equal(guard.canActivate(context(AuthController.prototype.me, undefined, '1')), true);
});

test('rate-limit drops avoid DB failure audit while authentication denials still use it', async () => {
  const { AuditFailureInterceptor } = require('../dist/audit/audit-failure.interceptor');
  const { throwError, lastValueFrom } = require('rxjs');
  let writes = 0;
  const interceptor = new AuditFailureInterceptor(
    { get: () => ({ action: 'ADMIN_LOGIN', targetType: 'ADMIN_USER', target: 'none' }) },
    {
      recordFailure: async () => {
        writes++;
      },
    },
  );
  const context = {
    getHandler: () => () => {},
    switchToHttp: () => ({ getRequest: () => ({ headers: {}, params: {}, requestId: 'test' }) }),
  };
  const run = (error) =>
    lastValueFrom(interceptor.intercept(context, { handle: () => throwError(() => error) }));
  await assert.rejects(run(new RateLimitException(1)), isLimited(1));
  assert.equal(writes, 0);
  await assert.rejects(
    run(new ApiException(401, 'UNAUTHORIZED', '인증 실패')),
    (error) => error.getStatus() === 401,
  );
  assert.equal(writes, 1);
});

test('signup/new password length bounds preserve legacy login, whitespace and Unicode', () => {
  const validate = (type, input) => validateSync(plainToInstance(type, input));
  const signup = { loginId: 'operator', password: 'password', name: '이'.repeat(50) };
  assert.deepEqual(validate(SignupDto, signup), []);
  assert.equal(validate(SignupDto, { ...signup, name: '이'.repeat(51) })[0].property, 'name');
  for (const password of ['x'.repeat(257), '12345', 123456, null])
    assert.ok(
      validate(SignupDto, { ...signup, password }).some((error) => error.property === 'password'),
    );
  assert.deepEqual(validate(SignupDto, { ...signup, password: '🙂'.repeat(256) }), []);
  assert.deepEqual(
    validate(LoginDto, { loginId: 'operator', password: ' 비밀 ' + 'x'.repeat(300) }),
    [],
  );
  const change = {
    currentPassword: 'x'.repeat(300),
    newPassword: ' 새 비밀 ' + 'x'.repeat(249),
    newPasswordConfirm: ' 새 비밀 ' + 'x'.repeat(249),
  };
  assert.deepEqual(validate(ChangePasswordDto, change), []);
  assert.ok(
    validate(ChangePasswordDto, { ...change, newPassword: 'x'.repeat(257) }).some(
      (error) => error.property === 'newPassword',
    ),
  );
  assert.ok(
    validate(ChangePasswordDto, { ...change, newPasswordConfirm: 'x'.repeat(257) }).some(
      (error) => error.property === 'newPasswordConfirm',
    ),
  );
});
test('password hashing is salted, preserves spaces and long Unicode input, and fails closed', async () => {
  const password = ' 비밀번호 ' + 'x'.repeat(140);
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.notEqual(first, second);
  assert.ok(!first.includes(password));
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword(password.trim(), first), false);
  assert.equal(await verifyPassword(password, 'malformed'), false);
  assert.equal(await verifyPassword(password), false);
});
test('cookie parsing rejects duplicate, malformed and encoded values', () => {
  const token = 'a'.repeat(64);
  const read = (cookie) => readSessionToken({ headers: { cookie } });
  assert.equal(read(`other=x; dva_session=${token}`), token);
  assert.equal(read(`dva_session=${token}; dva_session=${token}`), undefined);
  assert.equal(read('dva_session=%61'), undefined);
  assert.equal(read('dva_session=bad'), undefined);
  assert.equal(read(undefined), undefined);
  assert.notEqual(tokenHash(token), token);
});
test('cookie flags retain exact clearing scope and enable Secure in production', () => {
  assert.deepEqual(cookieOptions(true), {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/api',
  });
  assert.equal(cookieOptions(false).secure, false);
});

test('audit failure attribution uses the accepted server-side actor, never a caller-supplied header', () => {
  const { auditEvent } = require('../dist/audit/audit-operation');
  const operation = { action: 'CHANGE', targetType: 'CUSTOMER', target: 'id' };
  const request = { params: { id: '1' }, headers: { 'x-actor-type': 'AI' }, requestId: 'request' };
  assert.equal(auditEvent(operation, request).actorType, 'SYSTEM');
  const ai = auditEvent(operation, { ...request, auditActorType: 'AI' });
  assert.equal(ai.actorType, 'AI');
  assert.equal(ai.actorId, null);
  const admin = auditEvent(operation, {
    ...request,
    admin: { adminUserSeq: 7, name: '관리자' },
  });
  assert.equal(admin.actorType, 'ADMIN');
  assert.equal(admin.actorId, 7);
  assert.equal(admin.actorName, '관리자');
  assert.equal(
    auditEvent(operation, {
      ...request,
      auditActorType: 'AI',
      admin: { adminUserSeq: 7, name: '관리자' },
    }).actorId,
    null,
  );
});

const { Reflector } = require('@nestjs/core');
const { AuthGuard } = require('../dist/auth/auth.guard');
const { CustomersController } = require('../dist/customers/customers.controller');
const { ApiException } = require('../dist/common/errors/api.exception');
const businessToken = 'business-test-only-token-at-least-32-characters';
const adminToken = 'a'.repeat(64);
const origin = 'http://localhost:5173';

function customerAccess(handler, headers = {}, settings = {}, Controller = CustomersController) {
  const failures = [];
  const request = {
    headers,
    rawHeaders: Object.entries(headers).flat(),
    get: (name) => headers[name.toLowerCase()],
    path: '/api/customers/1',
    method: ['find', 'list', 'search'].includes(handler)
      ? 'GET'
      : handler === 'update'
        ? 'PATCH'
        : 'POST',
    body: {},
    params: { id: '1' },
    requestId: 'business-auth-test',
  };
  const guard = new AuthGuard(
    {
      authenticate: async (token) => {
        if (token !== adminToken) throw new ApiException(401, 'UNAUTHORIZED', '인증이 필요합니다.');
        return { adminUserSeq: 7, role: 'OPERATOR' };
      },
    },
    { recordFailure: async (event) => failures.push(event) },
    new Reflector(),
    {
      get: (name) =>
        ({ AI_BUSINESS_TOKEN: businessToken, CORS_ORIGINS: [origin], ...settings })[name],
    },
  );
  const context = {
    getHandler: () => Controller.prototype[handler],
    getClass: () => Controller,
    switchToHttp: () => ({ getRequest: () => request }),
  };
  return { request, failures, run: () => guard.canActivate(context) };
}

test('AI business authentication rejects missing, invalid and duplicate credentials on every customer entry', async () => {
  for (const handler of ['context', 'create', 'find', 'update']) {
    for (const authorization of [undefined, 'Bearer wrong', 'Basic ' + businessToken, 'Bearer ']) {
      const access = customerAccess(handler, authorization === undefined ? {} : { authorization });
      await assert.rejects(access.run(), (error) => error.getStatus() === 401, handler);
      assert.equal(access.request.auditActorType, undefined);
      assert.ok(access.failures.every((event) => event.actorType !== 'AI'));
    }
    const duplicate = customerAccess(handler, { authorization: 'Bearer ' + businessToken });
    duplicate.request.rawHeaders.push('Authorization', 'Bearer ' + businessToken);
    await assert.rejects(duplicate.run(), (error) => error.getStatus() === 401);
    assert.equal(duplicate.request.auditActorType, undefined);
  }
});

test('AI business authentication marks only valid service calls and disables them when unconfigured', async () => {
  for (const handler of ['context', 'create', 'find', 'update']) {
    const access = customerAccess(handler, { authorization: 'Bearer ' + businessToken });
    assert.equal(await access.run(), true);
    assert.equal(access.request.auditActorType, 'AI');
    assert.equal(access.request.admin, undefined);
    const disabled = customerAccess(handler, {}, { AI_BUSINESS_TOKEN: undefined });
    await assert.rejects(disabled.run(), (error) => error.getStatus() === 503);
    assert.equal(disabled.request.auditActorType, undefined);
  }
});

test('AI business authentication preserves administrator sessions, Origin and list boundaries without fallback', async () => {
  for (const handler of ['context', 'create', 'find', 'update', 'list']) {
    const access = customerAccess(
      handler,
      { cookie: 'dva_session=' + adminToken, origin },
      { AI_BUSINESS_TOKEN: undefined },
    );
    assert.equal(await access.run(), true);
    assert.equal(access.request.admin.adminUserSeq, 7);
    assert.equal(access.request.auditActorType, undefined);
  }
  const missingOrigin = customerAccess('update', { cookie: 'dva_session=' + adminToken });
  await assert.rejects(missingOrigin.run(), (error) => error.getStatus() === 403);
  for (const cookie of ['dva_session=bad', 'dva_session=' + 'f'.repeat(64)]) {
    const access = customerAccess('find', { cookie, authorization: 'Bearer ' + businessToken });
    await assert.rejects(access.run(), (error) => error.getStatus() === 401);
    assert.equal(access.request.auditActorType, undefined);
  }
  const list = customerAccess('list', { authorization: 'Bearer ' + businessToken });
  await assert.rejects(list.run(), (error) => error.getStatus() === 401);
});

test('directory service authentication requires one valid Bearer independently of administrator cookies', async () => {
  const { OrganizationsController } = require('../dist/organizations/organizations.controller');
  const access = (headers, settings) =>
    customerAccess('search', headers, settings, OrganizationsController);
  for (const headers of [
    {},
    { cookie: 'dva_session=' + adminToken },
    { authorization: 'Bearer wrong' },
  ])
    await assert.rejects(access(headers).run(), (error) => error.getStatus() === 401);
  for (const cookie of [undefined, 'dva_session=' + adminToken, 'dva_session=stale']) {
    const authenticated = access({ authorization: 'Bearer ' + businessToken, cookie });
    assert.equal(await authenticated.run(), true);
    assert.equal(authenticated.request.auditActorType, 'AI');
    assert.equal(authenticated.request.admin, undefined);
  }
  const duplicate = access({ authorization: 'Bearer ' + businessToken });
  duplicate.request.rawHeaders.push('Authorization', 'Bearer ' + businessToken);
  await assert.rejects(duplicate.run(), (error) => error.getStatus() === 401);
  await assert.rejects(
    access({ cookie: 'dva_session=' + adminToken }, { AI_BUSINESS_TOKEN: undefined }).run(),
    (error) => error.getStatus() === 503,
  );
});

test('administrator member search never accepts a service token as a session', async () => {
  const { MembersController } = require('../dist/members/members.controller');
  for (const headers of [
    {},
    { authorization: 'Bearer ' + businessToken },
    { cookie: 'dva_session=bad', authorization: 'Bearer ' + businessToken },
  ])
    await assert.rejects(
      customerAccess('search', headers, {}, MembersController).run(),
      (error) => error.getStatus() === 401,
    );
  const access = customerAccess(
    'search',
    { cookie: 'dva_session=' + adminToken },
    { AI_BUSINESS_TOKEN: undefined },
    MembersController,
  );
  assert.equal(await access.run(), true);
  assert.equal(access.request.admin.adminUserSeq, 7);
});
