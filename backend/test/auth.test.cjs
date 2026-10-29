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
