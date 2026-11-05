require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, verifyPassword } = require('../dist/auth/password');
const { readSessionToken } = require('../dist/auth/auth.guard');
const { cookieOptions } = require('../dist/auth/auth.controller');
const { tokenHash } = require('../dist/auth/auth.service');
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

function customerAccess(handler, headers = {}, settings = {}) {
  const failures = [];
  const request = {
    headers,
    rawHeaders: Object.entries(headers).flat(),
    get: (name) => headers[name.toLowerCase()],
    path: '/api/customers/1',
    method: ['find', 'list'].includes(handler) ? 'GET' : handler === 'update' ? 'PATCH' : 'POST',
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
    getHandler: () => CustomersController.prototype[handler],
    getClass: () => CustomersController,
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
