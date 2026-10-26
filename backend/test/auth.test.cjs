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
