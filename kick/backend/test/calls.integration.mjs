import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const base = 'http://127.0.0.1:3000/api';
const first = process.env.KICK_TEST_ACCOUNT_1_TOKEN;
const second = process.env.KICK_TEST_ACCOUNT_2_TOKEN;
const auth = (token) => ({ authorization: `Bearer ${token}` });
const post = (token, body) =>
  fetch(`${base}/calls`, {
    method: 'POST',
    headers: { ...auth(token), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

assert.equal((await fetch(`${base}/friends`)).status, 401);
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
assert.equal((await post(first, { calleeId: 'kick-test-1', requestId })).status, 409);

const reciprocal = await post(second, { calleeId: 'kick-test-1', requestId });
assert.equal(reciprocal.status, 201);
assert.equal((await reciprocal.json()).callerId, 'kick-test-2');

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
    status: 'REQUESTED',
  });
} finally {
  await db.end();
}
console.log('Kick friends and calls integration passed');
