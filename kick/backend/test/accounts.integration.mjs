import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './dist/app.module.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.KICK_SIGNUP_CODE = 'invite-for-integration';
process.env.FCM_SERVICE_ACCOUNT_BASE64 = Buffer.from(
  JSON.stringify({
    type: 'service_account',
    project_id: 'kick-ci',
    client_email: 'kick-ci@example.test',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  }),
).toString('base64');

const originalFetch = globalThis.fetch;
const sent = [];
let authenticated = 0;
globalThis.fetch = async (input, init) => {
  if (input === 'https://oauth2.googleapis.com/token') {
    assert.match(init.body.get('assertion'), /^[\w-]+\.[\w-]+\.[\w-]+$/);
    authenticated++;
    return Response.json({ access_token: 'test-oauth', expires_in: 3600 });
  }
  if (input === 'https://fcm.googleapis.com/v1/projects/kick-ci/messages:send') {
    assert.equal(init.headers.authorization, 'Bearer test-oauth');
    const { message } = JSON.parse(init.body);
    sent.push(message);
    return Response.json({ name: 'test-push' });
  }
  return originalFetch(input, init);
};

const app = await NestFactory.create(AppModule, { logger: false });
try {
  await app.listen(0, '127.0.0.1');
  const base = (await app.getUrl()) + '/api';
  const request = (method, path, token, body) =>
    fetch(base + path, {
      method,
      headers: {
        ...(token && { authorization: `Bearer ${token}` }),
        ...(body && { 'content-type': 'application/json' }),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(4_000),
    });
  assert.equal(
    (await request('POST', '/accounts', null, { displayName: 'Phone A', inviteCode: 'wrong' }))
      .status,
    403,
  );
  const people = [];
  for (const displayName of ['Phone A', 'Phone B']) {
    const response = await request('POST', '/accounts', null, {
      displayName,
      inviteCode: process.env.KICK_SIGNUP_CODE,
    });
    assert.equal(response.status, 201);
    assert.match(response.headers.get('cache-control'), /no-store/);
    const person = await response.json();
    assert.match(person.token, /^[a-f0-9]{64}$/);
    assert.deepEqual(await (await request('GET', '/accounts/me', person.token)).json(), {
      id: person.id,
      displayName,
    });
    assert.deepEqual(await (await request('GET', '/voice', person.token)).json(), {
      status: 'NOT_REGISTERED',
    });
    people.push(person);
  }
  const [caller, callee] = people;
  assert.notEqual(caller.token, callee.token);
  assert.equal((await request('PUT', '/friends/' + caller.id, caller.token)).status, 400);
  assert.equal((await request('PUT', '/friends/' + randomUUID(), caller.token)).status, 404);
  const outgoing = { calleeId: callee.id, requestId: randomUUID() };
  assert.equal((await request('POST', '/calls', caller.token, outgoing)).status, 404);
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal((await request('PUT', '/friends/' + callee.id, caller.token)).status, 200);
  }
  assert.deepEqual(await (await request('GET', '/friends', caller.token)).json(), [
    { id: callee.id, displayName: callee.displayName },
  ]);
  for (const [person, token] of [
    [caller, 'caller-fcm'],
    [callee, 'callee-fcm'],
  ]) {
    assert.equal((await request('PUT', '/devices/push', person.token, { token })).status, 204);
  }
  assert.equal(
    (await request('DELETE', '/devices/push', caller.token, { token: 'callee-fcm' })).status,
    204,
  );
  const responses = await Promise.all(
    [1, 2].map(() => request('POST', '/calls', caller.token, outgoing)),
  );
  assert.deepEqual(
    responses.map((response) => response.status),
    [201, 201],
  );
  const [call, duplicate] = await Promise.all(responses.map((response) => response.json()));
  assert.deepEqual(call, duplicate);
  const accepted = await request('PATCH', '/calls/' + call.id, callee.token, { action: 'accept' });
  assert.equal(accepted.status, 200);
  for (const person of people) {
    assert.equal((await request('POST', '/calls/' + call.id + '/join', person.token)).status, 200);
  }
  for (let attempt = 0; attempt < 30 && sent.length === 0; attempt++) await setTimeout(25);
  assert.equal(authenticated, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].token, 'callee-fcm');
  assert.equal(sent[0].data.type, 'incoming_call');
  assert.equal(sent[0].data.callId, call.id);
  assert.equal(sent[0].data.callerName, caller.displayName);
  assert.equal(sent[0].data.calleeId, callee.id);
  assert.equal(sent[0].android.priority, 'HIGH');
  assert.equal(
    (await request('PATCH', '/calls/' + call.id, caller.token, { action: 'end' })).status,
    200,
  );
  assert.equal(
    (await request('DELETE', '/devices/push', callee.token, { token: 'callee-fcm' })).status,
    204,
  );
  console.log('Kick account registration, friendship, call and FCM routing passed (FCM mocked)');
} finally {
  await app.close();
  globalThis.fetch = originalFetch;
}
