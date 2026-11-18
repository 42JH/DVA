const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');

test('an unavailable draft owner rolls call DELETE back while finalized calls skip that dependency', async t => {
  assert.equal(process.env.PGDATABASE, 'dva_webhook_test');
  const db = new Pool({ host: 'consultation-db', user: 'consultation_app' });
  const audit = new Pool({ host: 'operations-db', user: 'operations_app' });
  t.after(() => Promise.all([db.end(), audit.end()]));
  await db.query(`INSERT INTO call_sessions(call_session_seq,provider_call_id,incoming_at,started_at,ended_at)
    OVERRIDING SYSTEM VALUE VALUES(600101,'055-outage','2050-01-01Z','2050-01-01Z','2050-01-02Z'),
    (600102,'055-finalized-outage','2050-01-01Z','2050-01-01Z','2050-01-02Z');
    UPDATE call_sessions SET order_completion_received_at='2050-01-02Z',order_completion_payload='{}',
      order_finalized_at='2050-01-02Z',order_finalization_result='{}' WHERE call_session_seq=600102;`);
  const before = (await db.query('SELECT * FROM call_sessions WHERE call_session_seq=600101')).rows;
  const requestId = randomUUID();
  const response = await fetch('http://consultation-app:3004/api/calls', { method: 'DELETE', headers: {
    Origin: 'http://localhost:5173', Cookie: 'dva_session=' + 'a'.repeat(64), 'X-Request-Id': requestId,
    'Content-Type': 'application/json' }, body: JSON.stringify({ callSessionSeqs: [600101] }), signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 503); assert.equal((await response.json()).error.code, 'DEPENDENCY_UNAVAILABLE');
  assert.deepEqual((await db.query('SELECT * FROM call_sessions WHERE call_session_seq=600101')).rows, before);
  assert.deepEqual((await audit.query('SELECT action,target_type,target_seq,result FROM audit_logs WHERE request_id=$1', [requestId])).rows,
    [{ action: 'CALL_DELETED', target_type: 'CALL_SESSION', target_seq: 600101, result: 'FAILED' }]);
  const finalized = await fetch('http://consultation-app:3004/api/calls', { method: 'DELETE', headers: {
    Origin: 'http://localhost:5173', Cookie: 'dva_session=' + 'a'.repeat(64),
    'Content-Type': 'application/json' }, body: JSON.stringify({ callSessionSeqs: [600102] }), signal: AbortSignal.timeout(15000) });
  assert.equal(finalized.status, 204);
  assert.ok((await db.query('SELECT deleted_at FROM call_sessions WHERE call_session_seq=600102')).rows[0].deleted_at);
});
