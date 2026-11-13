import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TokenVerifier } from 'livekit-server-sdk';
import pg from 'pg';

const base = 'http://127.0.0.1:3000/api';
const first = process.env.KICK_TEST_ACCOUNT_1_TOKEN;
const second = process.env.KICK_TEST_ACCOUNT_2_TOKEN;
const auth = (token) => ({ authorization: `Bearer ${token}` });
const active = (token) => fetch(`${base}/calls/active`, { headers: auth(token) });
const join = (token, id) =>
  fetch(`${base}/calls/${id}/join`, { method: 'POST', headers: auth(token) });
const transition = (token, id, action) =>
  fetch(`${base}/calls/${id}`, {
    method: 'PATCH',
    headers: { ...auth(token), 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  });
const post = (token, body) =>
  fetch(`${base}/calls`, {
    method: 'POST',
    headers: { ...auth(token), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

assert.equal((await fetch(`${base}/friends`)).status, 401);
assert.equal((await fetch(`${base}/calls/events`)).status, 401);
assert.equal((await post('a'.repeat(64), {})).status, 401);
for (const [token, friend] of [
  [first, 'kick-test-2'],
  [second, 'kick-test-1'],
]) {
  const response = await fetch(`${base}/friends`, { headers: auth(token) });
  assert.equal(response.status, 200);
  const friends = await response.json();
  assert.deepEqual(
    friends.map(({ id }) => id),
    [friend],
  );
  assert.ok(friends[0].displayName);
}

assert.equal((await post(first, { calleeId: 'kick-test-2', requestId: 'invalid' })).status, 400);
assert.equal(
  (await post(first, { callerId: 'kick-test-2', calleeId: 'kick-test-2', requestId: randomUUID() }))
    .status,
  400,
);
assert.equal((await post(first, { calleeId: 'kick-test-1', requestId: randomUUID() })).status, 404);

const requestId = randomUUID();
const outgoing = { calleeId: 'kick-test-2', requestId };
const events = await fetch(`${base}/calls/events`, {
  headers: auth(second),
  signal: AbortSignal.timeout(15_000),
});
assert.equal(events.status, 200);
assert.match(events.headers.get('content-type'), /^text\/event-stream/);
const eventReader = events.body.pipeThrough(new TextDecoderStream()).getReader();
let eventBuffer = '';
async function nextCallEvent() {
  for (;;) {
    const data = /^data: (.+)\n\n/m.exec(eventBuffer);
    if (data) {
      eventBuffer = eventBuffer.slice(data.index + data[0].length);
      return JSON.parse(data[1]);
    }
    const { value, done } = await eventReader.read();
    assert.equal(done, false, 'Call event stream ended');
    eventBuffer += value;
  }
}
assert.deepEqual(await nextCallEvent(), { accountId: 'kick-test-2', call: null });
const responses = await Promise.all([post(first, outgoing), post(first, outgoing)]);
assert.deepEqual(
  responses.map(({ status }) => status),
  [201, 201],
);
const [saved, replay] = await Promise.all(responses.map((response) => response.json()));
assert.deepEqual(saved, replay);
assert.equal(saved.callerId, 'kick-test-1');
assert.equal(saved.calleeId, 'kick-test-2');
assert.equal(saved.status, 'REQUESTED');
assert.deepEqual(await nextCallEvent(), { accountId: saved.calleeId, call: saved });
assert.equal((await post(first, { calleeId: 'kick-test-1', requestId })).status, 409);

assert.deepEqual(await (await active(second)).json(), { accountId: saved.calleeId, call: saved });
assert.equal((await join(first, saved.id)).status, 409);
assert.equal((await transition(first, saved.id, 'accept')).status, 404);
assert.equal((await post(second, { calleeId: 'kick-test-1', requestId })).status, 409);
assert.equal((await transition(second, saved.id, 'accept')).status, 200);
assert.equal((await transition(second, saved.id, 'accept')).status, 200);
assert.deepEqual(await nextCallEvent(), {
  accountId: saved.calleeId,
  call: { ...saved, status: 'ACCEPTED' },
});

const verifier = new TokenVerifier(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
for (const [token, identity] of [
  [first, saved.callerId],
  [second, saved.calleeId],
]) {
  const response = await join(token, saved.id);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const { url, token: jwt } = await response.json();
  assert.equal(url, process.env.LIVEKIT_URL);
  const claims = await verifier.verify(jwt);
  assert.equal(claims.sub, identity);
  assert.deepEqual(claims.video, {
    roomJoin: true,
    room: `kick-${saved.id}`,
    canSubscribe: true,
    canPublish: true,
    canPublishSources: ['microphone'],
    canPublishData: true,
  });
}

assert.equal((await transition(first, saved.id, 'end')).status, 200);
assert.deepEqual(await nextCallEvent(), { accountId: saved.calleeId, call: null });
await eventReader.cancel();
assert.equal((await join(second, saved.id)).status, 409);
assert.deepEqual(await (await active(second)).json(), { accountId: saved.calleeId, call: null });

const reciprocal = await post(second, { calleeId: 'kick-test-1', requestId });
assert.equal(reciprocal.status, 201);
const incoming = await reciprocal.json();
assert.equal(incoming.callerId, 'kick-test-2');
assert.equal((await transition(first, incoming.id, 'reject')).status, 200);

const cancelled = await (await post(first, { ...outgoing, requestId: randomUUID() })).json();
assert.equal((await transition(second, cancelled.id, 'cancel')).status, 404);
assert.equal((await transition(first, cancelled.id, 'cancel')).status, 200);
assert.equal((await transition(second, cancelled.id, 'accept')).status, 409);

const db = new pg.Client({ connectionTimeoutMillis: 2000 });
await db.connect();
try {
  const { rows } = await db.query(
    'SELECT id, caller_id, callee_id, status FROM calls WHERE request_id = $1 ORDER BY caller_id',
    [requestId],
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    id: saved.id,
    caller_id: 'kick-test-1',
    callee_id: 'kick-test-2',
    status: 'ENDED',
  });
  assert.equal(rows[1].status, 'REJECTED');
  const pending = await (await post(first, { ...outgoing, requestId: randomUUID() })).json();
  await db.query("UPDATE calls SET requested_at = now() - interval '61 seconds' WHERE id = $1", [
    pending.id,
  ]);
  assert.equal((await transition(second, pending.id, 'accept')).status, 409);
  assert.deepEqual(await (await active(first)).json(), { accountId: saved.callerId, call: null });
} finally {
  await db.end();
}
console.log('Kick friends and calls integration passed');
