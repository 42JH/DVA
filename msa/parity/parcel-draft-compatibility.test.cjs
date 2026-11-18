const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const origin = 'http://localhost:5173', cookie = 'dva_session=' + 'a'.repeat(64);

test('055 existing lists, both cancellations and call DELETE match source HTTP, persisted rows and success/failure audits', async t => {
  assert.equal(process.env.PGDATABASE, 'dva_webhook_test');
  const pools = Object.fromEntries(['monolith', 'order', 'consultation', 'operations'].map(owner => [owner, new Pool({ host: owner + '-db', user: owner + '_app' })]));
  const locks = [];
  t.after(async () => { for (const c of locks) { await c.query('ROLLBACK'); c.release(); } await Promise.all(Object.values(pools).map(p => p.end())); });
  const sides = [{ order: pools.monolith, call: pools.monolith, audit: pools.monolith, orderUrl: 'http://monolith-app:3000', callUrl: 'http://monolith-app:3000' },
    { order: pools.order, call: pools.consultation, audit: pools.operations, orderUrl: 'http://order-app:3002', callUrl: 'http://consultation-app:3004' }];
  let compared = 0;
  const rows = (db, sql, args = []) => db.query(sql, args).then(r => r.rows);
  async function pair(method, path, status, { aiCall, body, call = false, deletedCall } = {}) {
    const requestId = randomUUID(), responses = [], before = [], start = Date.now();
    for (const side of sides) before.push({ orders: await rows(side.order, 'SELECT * FROM orders WHERE order_seq BETWEEN 500001 AND 500010 ORDER BY order_seq'),
      drafts: await rows(side.order, 'SELECT to_jsonb(t)-\'client_parcel_id\'-\'draft_seq\' AS row FROM order_parcel_drafts t WHERE legacy_order_seq BETWEEN 500001 AND 500010 OR call_session_seq BETWEEN 600001 AND 600020 ORDER BY to_jsonb(t)-\'client_parcel_id\'-\'draft_seq\''),
      calls: await rows(side.call, 'SELECT * FROM call_sessions WHERE call_session_seq BETWEEN 600001 AND 600020 ORDER BY call_session_seq') });
    for (const side of sides) {
      const response = await fetch((call ? side.callUrl : side.orderUrl) + path, { method, headers: {
        'X-Request-Id': requestId, ...(aiCall ? { call_session_seq: String(aiCall) } : { Origin: origin, Cookie: cookie }),
        ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
      const text = await response.text();
      assert.equal(response.status, status, method + ' ' + path + ' ' + text);
      assert.equal(response.headers.get('x-request-id'), requestId);
      responses.push({ body: text ? JSON.parse(text) : null, cache: response.headers.get('cache-control'), location: response.headers.get('location') });
    }
    assert.deepEqual(responses[1], responses[0]);
    const audits = [];
    for (const [i, side] of sides.entries()) {
      assert.deepEqual(await rows(side.order, 'SELECT * FROM orders WHERE order_seq BETWEEN 500001 AND 500010 ORDER BY order_seq'), before[i].orders);
      assert.deepEqual(await rows(side.order, 'SELECT to_jsonb(t)-\'client_parcel_id\'-\'draft_seq\' AS row FROM order_parcel_drafts t WHERE legacy_order_seq BETWEEN 500001 AND 500010 OR call_session_seq BETWEEN 600001 AND 600020 ORDER BY to_jsonb(t)-\'client_parcel_id\'-\'draft_seq\''), before[i].drafts);
      const calls = await rows(side.call, 'SELECT * FROM call_sessions WHERE call_session_seq BETWEEN 600001 AND 600020 ORDER BY call_session_seq');
      if (deletedCall) {
        const changed = calls.find(r => r.call_session_seq === deletedCall);
        assert.ok(changed.deleted_at.getTime() >= start - 1000 && changed.deleted_at.getTime() <= Date.now() + 1000);
        changed.deleted_at = null;
      }
      assert.deepEqual(calls, before[i].calls);
      audits.push(await rows(side.audit, "SELECT to_jsonb(t)-'occurred_at'-'audit_log_seq' AS row FROM audit_logs t WHERE request_id=$1 ORDER BY audit_log_seq", [requestId]));
    }
    assert.deepEqual(audits[1], audits[0]); compared++;
    return responses[0].body;
  }
  for (const side of sides) {
    await side.order.query(`INSERT INTO orders(order_seq,customer_seq,status,version,created_at,updated_at) OVERRIDING SYSTEM VALUE
      SELECT n,1,'COLLECTING',31,'2050-06-01Z','2050-06-01Z' FROM generate_series(500001,500005) n`);
    for (const [id, status, deleted, retained] of [[500001, 'INCOMPLETE', false, true], [500002, 'CANCELLED', true, false], [500003, 'RESUMED', false, true], [500005, 'CANCELLED', true, true]])
      await side.order.query(`INSERT INTO order_parcel_drafts(legacy_order_seq,client_parcel_id,creation_payload,parcel_data,status,deleted_at,retention_started_at)
        VALUES($1,$2,'{}','{}',$3,$4,$5)`, [id, randomUUID(), status, deleted ? '2050-01-01Z' : null, retained ? '2050-01-01Z' : '2000-01-01Z']);
    await side.order.query("UPDATE orders SET deleted_at='2050-01-01Z' WHERE order_seq=500002; UPDATE orders SET created_at='2000-01-01Z' WHERE order_seq=500003");
    const expiredOrder = await side.order.connect(); locks.push(expiredOrder); await expiredOrder.query('BEGIN');
    await expiredOrder.query('SELECT 1 FROM orders WHERE order_seq=500003 FOR KEY SHARE');
    // Logical legacy references are retained even if the original order is no longer present.
    await side.order.query(`INSERT INTO order_parcel_drafts(legacy_order_seq,client_parcel_id,creation_payload,parcel_data,status) VALUES(500010,$1,'{}','{}','INCOMPLETE')`, [randomUUID()]);
    await side.call.query(`INSERT INTO call_sessions(call_session_seq,provider_call_id,caller_phone_number,incoming_at,registered_at,started_at,ended_at,deleted_at,order_intake_enabled)
      OVERRIDING SYSTEM VALUE SELECT n,'055-api-'||n,'01000000001','2050-01-01Z','2050-01-01Z','2050-01-01Z','2050-01-02Z',
        CASE WHEN n=600002 THEN '2050-01-03Z'::timestamptz END,true FROM generate_series(600001,600020) n`);
    await side.call.query("UPDATE call_sessions SET incoming_at='2000-01-01Z' WHERE call_session_seq=600011; UPDATE call_sessions SET caller_phone_number='unregistered historic text' WHERE call_session_seq=600002");
    const expiredCall = await side.call.connect(); locks.push(expiredCall); await expiredCall.query('BEGIN');
    await expiredCall.query('SELECT 1 FROM call_sessions WHERE call_session_seq=600011 FOR KEY SHARE');
    for (const table of ['order_parcel_drafts']) {
      const c = await side.order.connect(); locks.push(c); await c.query('BEGIN'); await c.query(`SELECT 1 FROM ${table} WHERE legacy_order_seq=500002 FOR KEY SHARE`);
    }
  }
  const range = '?from=2050-06-01T00%3A00%3A00Z&to=2050-06-02T00%3A00%3A00Z';
  for (const path of ['/api/orders', '/api/admin/orders']) {
    const result = await pair('GET', path + range, 200);
    assert.deepEqual(result.data.map(r => r.orderSeq), [500004]);
  }
  for (const selected of [false, true]) {
    const options = selected ? { body: { orderParcelSeqs: [999999] } } : {};
    const suffix = selected ? '/parcels/cancel' : '/cancel';
    for (const call of [600001, 600002, 600011]) await pair('POST', '/api/orders/500004' + suffix, 409, { ...options, aiCall: call });
    for (const id of [500001, 500002, 500003, 500005, 500010]) await pair('POST', '/api/orders/' + id + suffix, 409, options);
  }
  for (const [i, status, deleted, expired, finalized] of [[3, 'READY', false, false, false], [4, 'EDITING', false, false, false],
    [5, 'INCOMPLETE', false, false, false], [6, 'CANCELLED', false, false, false], [7, 'RESUMED', false, false, false],
    [8, 'READY', true, false, false], [9, 'EDITING', false, true, false], [10, 'READY', false, false, true]]) {
    const id = 600000 + i;
    for (const side of sides) {
      await side.order.query(`INSERT INTO order_parcel_drafts(call_session_seq,client_parcel_id,creation_payload,parcel_data,status,deleted_at,retention_started_at)
        VALUES($1,$2,'{}','{}',$3,$4,$5)`, [id, randomUUID(), status, deleted ? '2050-01-01Z' : null, expired ? '2000-01-01Z' : '2050-01-01Z']);
      if (expired) { const c = await side.order.connect(); locks.push(c); await c.query('BEGIN'); await c.query('SELECT 1 FROM order_parcel_drafts WHERE call_session_seq=$1 FOR KEY SHARE', [id]); }
      if (finalized) await side.call.query(`UPDATE call_sessions SET order_completion_received_at='2050-01-02Z',order_completion_payload='{}',order_finalized_at='2050-01-02Z',order_finalization_result='{}' WHERE call_session_seq=$1`, [id]);
    }
    const statusCode = !deleted && !expired && !finalized && ['READY', 'EDITING'].includes(status) ? 409 : 204;
    await pair('DELETE', '/api/calls/' + id, statusCode, { call: true, ...(statusCode === 204 ? { deletedCall: id } : {}) });
  }
  console.log(JSON.stringify({ parcelDraftCompatibilityPairs: compared }));
});
