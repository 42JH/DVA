require('reflect-metadata');
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  createTestSession,
  createTestPool,
  startTestApp,
  businessHeaders,
} = require('./helpers/application.cjs');

const { AuditService } = require('../dist/audit/audit.service');

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.DB_NAME, 'dva_webhook_test');
assert.ok(['db', '127.0.0.1'].includes(process.env.DB_HOST));
process.env.SWAGGER_ENABLED = 'false';
const origin = 'http://localhost:5173';
process.env.CORS_ORIGINS = origin;
const pool = createTestPool();
const apps = [];
let app, base, customerId, otherId, callId, newCallId;
const cookies = [],
  adminIds = [];
const phone = '01064000001';

before(async () => {
  app = await startTestApp(apps);
  base = (await app.getUrl()) + '/api';
  for (const role of ['OPERATOR', 'SYSTEM_ADMIN']) {
    const loginId = 'cancel' + role.replaceAll('_', '');
    const admin = await pool.query(
      "INSERT INTO admin_users(login_id,name,password_hash,role,status) VALUES($1,'취소 검증',$2,$3,'ACTIVE') RETURNING admin_user_seq",
      [loginId, 'not-for-login', role],
    );
    adminIds.push(admin.rows[0].admin_user_seq);
    cookies.push(await createTestSession(pool, admin.rows[0].admin_user_seq));
  }
  customerId = (
    await pool.query(
      "INSERT INTO customers(name,phone_number,status) VALUES('취소 고객',$1,'ACTIVE') RETURNING customer_seq",
      [phone],
    )
  ).rows[0].customer_seq;
  otherId = (
    await pool.query(
      "INSERT INTO customers(name,phone_number,status) VALUES('다른 고객','01064000002','ACTIVE') RETURNING customer_seq",
    )
  ).rows[0].customer_seq;
  callId = (
    await pool.query(
      'INSERT INTO call_sessions(provider_call_id,caller_phone_number,order_intake_enabled) VALUES($1,$2,false) RETURNING call_session_seq',
      [randomUUID(), phone],
    )
  ).rows[0].call_session_seq;
  newCallId = (
    await pool.query(
      'INSERT INTO call_sessions(provider_call_id,caller_phone_number) VALUES($1,$2) RETURNING call_session_seq',
      [randomUUID(), phone],
    )
  ).rows[0].call_session_seq;
});

after(async () => {
  for (const application of apps) await application.close();
  await pool.end();
});

async function fixture({
  status = 'COLLECTING',
  count = 2,
  customer = customerId,
  shipments = [],
} = {}) {
  const id = (
    await pool.query(
      "INSERT INTO orders(customer_seq,total_amount,payment_method_type) VALUES($1,0,'billing') RETURNING order_seq",
      [customer],
    )
  ).rows[0].order_seq;
  const parcels = [];
  for (let position = 1; position <= count; position++) {
    const parcel = (
      await pool.query(
        "INSERT INTO order_parcels(order_seq,parcel_position,other_item_description,notified_price) VALUES($1,$2,'보존할 물품',3500) RETURNING order_parcel_seq",
        [id, position],
      )
    ).rows[0].order_parcel_seq;
    parcels.push(parcel);
    if (shipments[position - 1])
      await pool.query(
        'INSERT INTO shipments(order_parcel_seq,tracking_number,status) VALUES($1,$2,$3)',
        [parcel, randomUUID(), shipments[position - 1]],
      );
  }
  await pool.query('UPDATE orders SET total_amount=$2 WHERE order_seq=$1', [id, count * 3500]);
  if (status !== 'COLLECTING')
    await pool.query(
      `UPDATE orders SET status=$2,pickup_requested_at=clock_timestamp()+interval '1 day',
      parcel_no=CASE WHEN $2='ACCEPTED' THEN 'TEST0064' ELSE NULL END,
      dver_received_at=CASE WHEN $2='ACCEPTED' THEN clock_timestamp() ELSE NULL END WHERE order_seq=$1`,
      [id, status],
    );
  if (status === 'notPaid') {
    await pool.query(
      "UPDATE orders SET payment_due_at=clock_timestamp()+interval '24 hours' WHERE order_seq=$1",
      [id],
    );
    if (count > 0)
      await pool.query(
        'INSERT INTO order_payment_requests(order_seq,amount,expires_at) SELECT order_seq,total_amount,payment_due_at FROM orders WHERE order_seq=$1',
        [id],
      );
  }
  return { id, parcels };
}

function cancel(id, { cookie = cookies[0], call, requestId = randomUUID(), parcels } = {}) {
  return fetch(`${base}/orders/${id}${parcels === undefined ? '' : '/parcels'}/cancel`, {
    method: 'POST',
    headers: {
      Origin: origin,
      'X-Request-Id': requestId,
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : businessHeaders()),
      ...(call === undefined ? {} : { call_session_seq: String(call) }),
    },
    body: parcels === undefined ? undefined : JSON.stringify({ orderParcelSeqs: parcels }),
  });
}

async function state(id) {
  return (
    await pool.query(
      `SELECT jsonb_build_object(
    'order',(SELECT to_jsonb(o) FROM orders o WHERE order_seq=$1),
    'parcels',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY order_parcel_seq),'[]') FROM order_parcels p WHERE order_seq=$1),
    'requests',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY created_at,payment_request_id),'[]') FROM order_payment_requests r WHERE order_seq=$1),
    'shipments',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY shipment_seq),'[]') FROM shipments s JOIN order_parcels p USING(order_parcel_seq) WHERE p.order_seq=$1),
    'history',(SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY shipment_status_history_seq),'[]') FROM shipment_status_history h JOIN shipments s USING(shipment_seq) JOIN order_parcels p USING(order_parcel_seq) WHERE p.order_seq=$1)
  ) AS snapshot`,
      [id],
    )
  ).rows[0].snapshot;
}

test('all three admin roles cancel drafts immediately; empty drafts also cancel', async () => {
  for (const [index, cookie] of cookies.entries()) {
    const { id } = await fixture({ count: index });
    const res = await cancel(id, { cookie });
    assert.equal(res.status, 204);
    assert.equal(await res.text(), '');
    const saved = await state(id);
    assert.equal(saved.order.status, 'CANCELLED');
    assert.ok(saved.parcels.every((p) => p.status === 'CANCELLED'));
    assert.ok(saved.order.version > 1);
    const detail = await fetch(`${base}/orders/${id}`, { headers: { Cookie: cookie } });
    assert.equal(detail.status, 200);
    assert.ok((await detail.json()).data.parcels.every((p) => p.status === 'CANCELLED'));
    const selected = await fixture();
    assert.equal((await cancel(selected.id, { cookie, parcels: selected.parcels })).status, 204);
    assert.equal((await state(selected.id)).order.status, 'CANCELLED');
  }
});

test('unpaid order preserves snapshots and invalidates its payment request with operator audits once', async () => {
  const { id } = await fixture({ status: 'notPaid' });
  const previous = await state(id),
    requestId = randomUUID();
  assert.equal((await cancel(id, { requestId })).status, 204);
  const saved = await state(id);
  assert.equal(saved.order.status, 'CANCELLED');
  assert.equal(saved.order.total_amount, 0);
  assert.equal(saved.order.payment_due_at, previous.order.payment_due_at);
  assert.deepEqual(
    saved.parcels.map(({ status, ...p }) => p),
    previous.parcels.map(({ status, ...p }) => p),
  );
  assert.deepEqual(saved.shipments, []);
  assert.deepEqual(saved.history, []);
  assert.ok(saved.requests.every((r) => r.invalidated_at !== null));
  const audits = (
    await pool.query(
      "SELECT * FROM audit_logs WHERE request_id=$1 AND result='SUCCESS' ORDER BY audit_log_seq",
      [requestId],
    )
  ).rows;
  assert.deepEqual(
    audits.map((a) => a.action),
    ['ORDER_CANCELLED', 'ORDER_AMOUNT_CHANGED'],
  );
  assert.ok(audits.every((a) => a.actor_type === 'ADMIN' && a.actor_seq === adminIds[0]));
  assert.deepEqual(audits[1].metadata.amountBefore, 7000);
  assert.deepEqual(audits[1].metadata.amountAfter, 0);
  const repeat = await cancel(id);
  assert.equal(repeat.status, 409);
  assert.equal((await repeat.json()).error.message, '이미 취소된 주문입니다.');
  assert.deepEqual(await state(id), saved);
});

test('whole cancellation is all-or-nothing for paid, missing and uncertain states', async () => {
  for (const status of ['paid', 'received', 'waiting', 'sent', 'canceling', 'canceled']) {
    const { id } = await fixture({ status: 'ACCEPTED', shipments: ['notPaid', status] });
    const previous = await state(id);
    assert.equal((await cancel(id)).status, 409, status);
    assert.deepEqual(await state(id), previous);
  }
  for (const input of [
    { status: 'ACCEPTED', shipments: ['notPaid'] },
    { status: 'ACCEPTED', count: 0 },
    { shipments: ['notPaid'] },
    ...['PAID', 'SUBMITTING', 'SUBMISSION_FAILED', 'CANCELLED'].map((status) => ({ status })),
  ]) {
    const { id } = await fixture(input);
    const previous = await state(id);
    assert.equal((await cancel(id)).status, 409);
    assert.deepEqual(await state(id), previous);
  }
});

test('AI uses the same caller/customer scope as order detail and cannot spoof another customer', async () => {
  const mine = await fixture();
  const other = await fixture({ customer: otherId });
  const previous = await state(other.id);
  assert.equal((await cancel(other.id, { cookie: null, call: callId })).status, 404);
  assert.deepEqual(await state(other.id), previous);
  assert.equal((await cancel(mine.id, { cookie: null })).status, 400);
  assert.equal((await cancel(mine.id, { cookie: null, call: 'bad' })).status, 400);
  assert.equal(
    (await cancel(mine.id, { cookie: 'dva_session=invalid', call: callId })).status,
    401,
  );
  assert.equal((await cancel(mine.id, { cookie: null, call: 2147483647 })).status, 404);
  assert.equal((await cancel(mine.id, { cookie: null, call: callId })).status, 204);
  await pool.query(
    "UPDATE call_sessions SET started_at=clock_timestamp()-interval '1 minute',ended_at=clock_timestamp() WHERE call_session_seq=$1",
    [callId],
  );
  const ended = await fixture();
  assert.equal((await cancel(ended.id, { cookie: null, call: callId })).status, 409);
  await pool.query('UPDATE call_sessions SET order_seq=$2 WHERE call_session_seq=$1', [
    callId,
    ended.id,
  ]);
  assert.equal((await cancel(ended.id, { cookie: null, call: callId })).status, 204);
  await pool.query(
    'UPDATE call_sessions SET started_at=NULL,ended_at=NULL,order_seq=NULL WHERE call_session_seq=$1',
    [callId],
  );
  await pool.query("UPDATE customers SET status='WITHDRAWN' WHERE customer_seq=$1", [customerId]);
  const withdrawn = await fixture();
  assert.equal((await cancel(withdrawn.id, { cookie: null, call: callId })).status, 403);
  await pool.query("UPDATE customers SET status='ACTIVE' WHERE customer_seq=$1", [customerId]);
});

test('a new AI call can partially and fully cancel an existing unpaid order', async () => {
  const { id, parcels } = await fixture({ status: 'notPaid' });
  const ai = { cookie: null, call: newCallId };
  const original = await state(id);
  const response = await cancel(id, { ...ai, parcels: [parcels[0]] });
  assert.equal(response.status, 204, await response.text());
  const partial = await state(id);
  assert.equal(partial.order.status, 'notPaid');
  assert.equal(partial.order.total_amount, 3500);
  assert.deepEqual(
    partial.parcels.map((parcel) => parcel.status),
    ['CANCELLED', 'ACTIVE'],
  );
  assert.ok(
    partial.requests.find((r) => r.payment_request_id === original.requests[0].payment_request_id)
      .invalidated_at,
  );
  assert.equal(partial.requests.find((r) => !r.invalidated_at).amount, 3500);
  assert.equal(partial.order.payment_due_at, original.order.payment_due_at);

  const full = await cancel(id, ai);
  assert.equal(full.status, 204, await full.text());
  const cancelled = await state(id);
  assert.equal(cancelled.order.status, 'CANCELLED');
  assert.equal(cancelled.order.total_amount, 0);
  assert.ok(cancelled.requests.every((request) => request.invalidated_at));
});

test('a new AI call cannot cancel another customer’s order or an ineligible order', async () => {
  const ai = { cookie: null, call: newCallId };
  const foreign = await fixture({ status: 'notPaid', customer: otherId });
  const unpaid = await fixture({ status: 'notPaid' });
  await pool.query(
    'UPDATE order_payment_requests SET approval_started_at=clock_timestamp() WHERE order_seq=$1',
    [unpaid.id],
  );
  for (const [order, status, code] of [
    [foreign, 404, 'NOT_FOUND'],
    [await fixture({ status: 'PAID' }), 409, 'INVALID_STATE'],
    [await fixture(), 409, 'INVALID_STATE'],
    [unpaid, 409, 'REQUEST_IN_PROGRESS'],
  ]) {
    const previous = await state(order.id);
    for (const parcels of [undefined, [order.parcels[0]]]) {
      const response = await cancel(order.id, { ...ai, parcels });
      assert.equal(response.status, status);
      assert.equal((await response.json()).error.code, code);
    }
    assert.deepEqual(await state(order.id), previous);
  }
});

test('duplicate concurrent whole requests change state/history once', async () => {
  const { id } = await fixture({ status: 'notPaid' });
  const responses = await Promise.all([cancel(id), cancel(id), cancel(id)]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [204, 409, 409]);
  assert.equal((await state(id)).history.length, 0);
  const audits = await pool.query(
    "SELECT count(*)::int AS n FROM audit_logs WHERE target_seq=$1 AND target_type='ORDER' AND action='ORDER_CANCELLED' AND result='SUCCESS'",
    [id],
  );
  assert.equal(audits.rows[0].n, 1);
});

test('audit failure rolls back order, parcel and shipment writes', async () => {
  const { id } = await fixture({ status: 'notPaid' });
  const previous = await state(id);
  const audit = app.get(AuditService),
    original = audit.recordSuccess;
  audit.recordSuccess = async function (event, client) {
    if (event.action === 'ORDER_CANCELLED') throw new Error('cancel audit failure probe');
    return original.call(this, event, client);
  };
  try {
    assert.equal((await cancel(id)).status, 500);
  } finally {
    audit.recordSuccess = original;
  }
  assert.deepEqual(await state(id), previous);
  assert.equal((await cancel(id)).status, 204);
});

test('batch cancellation waits for a concurrent payment transaction and rechecks paid state', async () => {
  const { id, parcels } = await fixture({ status: 'notPaid' });
  const client = await pool.connect();
  let pending;
  try {
    await client.query('BEGIN');
    await client.query(
      "UPDATE orders SET status='PAID',paid_at=clock_timestamp() WHERE order_seq=$1",
      [id],
    );
    pending = cancel(id, { parcels });
    let waiting = false;
    for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
      waiting = (
        await pool.query(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM orders%') AS waiting",
        )
      ).rows[0].waiting;
      if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(waiting, true, 'cancellation must wait on the locked order');
    await client.query('COMMIT');
    assert.equal((await pending).status, 409);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    if (pending) await pending;
  }
  const saved = await state(id);
  assert.equal(saved.order.status, 'PAID');
  assert.ok(saved.parcels.every((p) => p.status === 'ACTIVE'));
  assert.deepEqual(saved.history, []);
});

test('path validation and Swagger describe empty 204 with one call header', async () => {
  for (const id of ['0', '-1', 'abc', '2147483648']) assert.equal((await cancel(id)).status, 400);
  assert.equal((await cancel(2147483647)).status, 404);
});

test('individual cancellation preserves siblings and completes the parent only on the last parcel', async () => {
  const { id, parcels } = await fixture({ status: 'notPaid' });
  const initial = await state(id);
  assert.equal((await cancel(id, { parcels: [parcels[0]] })).status, 204);
  const partial = await state(id);
  assert.equal(partial.order.status, 'notPaid');
  assert.equal(partial.order.total_amount, 3500);
  assert.equal(partial.order.payment_due_at, initial.order.payment_due_at);
  assert.deepEqual(
    partial.parcels.map((p) => p.status),
    ['CANCELLED', 'ACTIVE'],
  );
  assert.deepEqual(partial.shipments, []);
  assert.equal(partial.requests.filter((r) => !r.invalidated_at).length, 1);
  assert.equal(partial.requests.find((r) => !r.invalidated_at).amount, 3500);
  const repeated = await cancel(id, { parcels: [parcels[0]] });
  assert.equal(repeated.status, 204);
  assert.equal(await repeated.text(), '');
  assert.deepEqual(await state(id), partial);
  assert.equal((await cancel(id, { parcels: [parcels[1]] })).status, 204);
  const complete = await state(id);
  assert.equal(complete.order.status, 'CANCELLED');
  assert.equal(complete.order.total_amount, 0);
  assert.ok(complete.requests.every((r) => r.invalidated_at));
  assert.equal((await cancel(id, { parcels: [parcels[0]] })).status, 204);
  assert.deepEqual(await state(id), complete);
  assert.equal((await cancel(id)).status, 409);
  const audit = await pool.query(
    "SELECT action,count(*)::int AS n FROM audit_logs WHERE result='SUCCESS' AND ((target_type='ORDER' AND target_seq=$1) OR (target_type='ORDER_PARCEL' AND target_seq=ANY($2::int[]))) GROUP BY action ORDER BY action",
    [id, parcels],
  );
  assert.deepEqual(audit.rows, [
    { action: 'ORDER_AMOUNT_CHANGED', n: 2 },
    { action: 'ORDER_CANCELLED', n: 1 },
    { action: 'ORDER_PARCEL_CANCELLED', n: 2 },
  ]);
});

test('whole cancellation skips cancelled parcels while paid orders block whole and partial writes', async () => {
  const { id, parcels } = await fixture({ status: 'notPaid' });
  assert.equal((await cancel(id, { parcels: [parcels[0]] })).status, 204);
  assert.equal((await cancel(id)).status, 204);
  assert.deepEqual(
    (await state(id)).parcels.map((p) => p.status),
    ['CANCELLED', 'CANCELLED'],
  );
  const paid = await fixture({ status: 'ACCEPTED', shipments: ['paid', 'paid'] });
  const previous = await state(paid.id);
  assert.equal((await cancel(paid.id)).status, 409);
  for (const parcel of paid.parcels)
    assert.equal((await cancel(paid.id, { parcels: [parcel] })).status, 409);
  assert.deepEqual(await state(paid.id), previous);
});

test('individual route validates parcel membership, IDs and AI ownership before any no-op or mutation', async () => {
  const mine = await fixture();
  const other = await fixture({ customer: otherId });
  for (const parcel of ['0', '-1', 'bad', '2147483648'])
    assert.equal((await cancel(mine.id, { parcels: [parcel] })).status, 400);
  assert.equal((await cancel(mine.id, { parcels: [other.parcels[0]] })).status, 404);
  assert.equal((await cancel(mine.id, { parcels: [2147483647] })).status, 404);
  assert.equal(
    (await cancel(other.id, { parcels: [other.parcels[0]], cookie: null, call: callId })).status,
    404,
  );
  assert.equal((await cancel(other.id)).status, 204);
  assert.equal(
    (await cancel(other.id, { parcels: [other.parcels[0]], cookie: null, call: callId })).status,
    404,
  );
  assert.equal(
    (await cancel(mine.id, { parcels: [mine.parcels[0]], cookie: null, call: callId })).status,
    204,
  );
  assert.equal((await state(mine.id)).order.status, 'COLLECTING');
  const accepted = await fixture({ status: 'notPaid' });
  assert.equal(
    (await cancel(accepted.id, { parcels: [accepted.parcels[0]], cookie: null, call: callId }))
      .status,
    204,
  );
  const events = (
    await pool.query(
      "SELECT actor_type FROM audit_logs WHERE target_type='ORDER_PARCEL' AND target_seq=$1 AND action='ORDER_PARCEL_CANCELLED'",
      [accepted.parcels[0]],
    )
  ).rows;
  assert.deepEqual(events, [{ actor_type: 'AI' }]);
});

test('individual retries and different-parcel cancellations serialize without duplicate audits', async () => {
  const { id, parcels } = await fixture({ status: 'notPaid' });
  const first = await Promise.all(
    Array.from({ length: 3 }, () => cancel(id, { parcels: [parcels[0]] })),
  );
  assert.ok(first.every((r) => r.status === 204));
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM audit_logs WHERE target_type='ORDER_PARCEL' AND target_seq=$1 AND action='ORDER_PARCEL_CANCELLED'",
        [parcels[0]],
      )
    ).rows[0].n,
    1,
  );
  assert.equal((await cancel(id)).status, 204);
  const second = await fixture({ status: 'notPaid' });
  const different = await Promise.all(
    second.parcels.map((parcel) => cancel(second.id, { parcels: [parcel] })),
  );
  assert.ok(different.every((r) => r.status === 204));
  const saved = await state(second.id);
  assert.equal(saved.order.status, 'CANCELLED');
  assert.ok(saved.requests.every((r) => r.invalidated_at));
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM audit_logs WHERE target_type='ORDER_PARCEL' AND target_seq=ANY($1::int[]) AND action='ORDER_PARCEL_CANCELLED'",
        [second.parcels],
      )
    ).rows[0].n,
    2,
  );
});

test('failure while completing the last parcel rolls back both cancellation audits and all states', async () => {
  const { id, parcels } = await fixture({ status: 'notPaid', count: 1 });
  const previous = await state(id);
  const requestId = randomUUID();
  const audit = app.get(AuditService),
    original = audit.recordSuccess;
  audit.recordSuccess = async function (event, client) {
    if (event.action === 'ORDER_CANCELLED') throw new Error('parent audit failure probe');
    return original.call(this, event, client);
  };
  try {
    assert.equal((await cancel(id, { parcels: [parcels[0]], requestId })).status, 500);
  } finally {
    audit.recordSuccess = original;
  }
  assert.deepEqual(await state(id), previous);
  assert.equal(
    (
      await pool.query("SELECT 1 FROM audit_logs WHERE request_id=$1 AND result='SUCCESS'", [
        requestId,
      ])
    ).rowCount,
    0,
  );
});

test('batch cancellation skips prior cancellations, preserves siblings and audits only new changes', async () => {
  const { id, parcels } = await fixture({
    status: 'notPaid',
    count: 4,
  });
  assert.equal((await cancel(id, { parcels: [parcels[0]] })).status, 204);
  const beforeBatch = await state(id);
  const requestId = randomUUID();
  const selection = [parcels[2], parcels[0], parcels[1]];
  const response = await cancel(id, { parcels: selection, requestId });
  assert.equal(response.status, 204);
  assert.equal(await response.text(), '');
  const partial = await state(id);
  assert.equal(partial.order.status, 'notPaid');
  assert.deepEqual(
    partial.parcels.map((p) => p.status),
    ['CANCELLED', 'CANCELLED', 'CANCELLED', 'ACTIVE'],
  );
  assert.deepEqual(partial.shipments, []);
  assert.deepEqual(partial.parcels[3], beforeBatch.parcels[3]);
  assert.equal(partial.order.total_amount, 3500);
  assert.equal(partial.requests.find((r) => !r.invalidated_at).amount, 3500);
  const audits = await pool.query(
    "SELECT target_seq FROM audit_logs WHERE request_id=$1 AND result='SUCCESS' AND action='ORDER_PARCEL_CANCELLED' ORDER BY target_seq",
    [requestId],
  );
  assert.deepEqual(
    audits.rows.map((row) => row.target_seq),
    [parcels[1], parcels[2]],
  );
  const repeatId = randomUUID();
  assert.equal(
    (await cancel(id, { parcels: selection.toReversed(), requestId: repeatId })).status,
    204,
  );
  assert.deepEqual(await state(id), partial);
  assert.equal(
    (
      await pool.query("SELECT 1 FROM audit_logs WHERE request_id=$1 AND result='SUCCESS'", [
        repeatId,
      ])
    ).rowCount,
    0,
  );
  assert.equal((await cancel(id, { parcels: parcels.toReversed() })).status, 204);
  const complete = await state(id);
  assert.equal(complete.order.status, 'CANCELLED');
  assert.equal(complete.order.parcel_no, beforeBatch.order.parcel_no);
  assert.equal(complete.history.length, 0);
  assert.equal((await cancel(id, { parcels })).status, 204);
  assert.deepEqual(await state(id), complete);
});

test('batch validates every selected parcel before mutating or returning a no-op', async () => {
  const mine = await fixture();
  const foreign = await fixture({ customer: otherId });
  const beforeMine = await state(mine.id),
    beforeForeign = await state(foreign.id);
  for (const selection of [
    [mine.parcels[0], foreign.parcels[0]],
    [mine.parcels[0], 2147483647],
  ]) {
    assert.equal(
      (await cancel(mine.id, { parcels: selection, cookie: null, call: callId })).status,
      404,
    );
    assert.deepEqual(await state(mine.id), beforeMine);
    assert.deepEqual(await state(foreign.id), beforeForeign);
  }
  assert.equal((await cancel(mine.id, { parcels: mine.parcels })).status, 204);
  const cancelled = await state(mine.id);
  assert.equal(
    (await cancel(mine.id, { parcels: [mine.parcels[0], foreign.parcels[0]] })).status,
    404,
  );
  assert.deepEqual(await state(mine.id), cancelled);
  for (const parcels of [[], null, [mine.parcels[0], mine.parcels[0]], [0], [1.5], ['1']])
    assert.equal((await cancel(mine.id, { parcels })).status, 400);
  const missingBody = await fetch(`${base}/orders/${mine.id}/parcels/cancel`, {
    method: 'POST',
    headers: { Cookie: cookies[0], Origin: origin },
  });
  assert.equal(missingBody.status, 400);
  assert.deepEqual(await state(mine.id), cancelled);
});

test('batch cancellation rejects all selected writes after payment even with legacy shipment data', async () => {
  for (const blocked of ['paid', undefined]) {
    const { id, parcels } = await fixture({ status: 'ACCEPTED', shipments: ['notPaid', blocked] });
    const previous = await state(id);
    assert.equal((await cancel(id, { parcels })).status, 409);
    assert.deepEqual(await state(id), previous);
  }
  const { id, parcels } = await fixture({ status: 'PAID', count: 3 });
  const previous = await state(id);
  assert.equal((await cancel(id, { parcels: parcels.slice(0, 2) })).status, 409);
  assert.deepEqual(await state(id), previous);
});

test('overlapping batches serialize and cancel each parcel exactly once', async () => {
  const { id, parcels } = await fixture({
    status: 'notPaid',
    count: 3,
  });
  const responses = await Promise.all([
    cancel(id, { parcels: [parcels[1], parcels[0]] }),
    cancel(id, { parcels: [parcels[2], parcels[1]] }),
  ]);
  assert.ok(responses.every((response) => response.status === 204));
  const saved = await state(id);
  assert.equal(saved.order.status, 'CANCELLED');
  assert.equal(saved.history.length, 0);
  assert.ok(saved.requests.every((r) => r.invalidated_at));
  const audits = await pool.query(
    "SELECT action,count(*)::int AS n FROM audit_logs WHERE result='SUCCESS' AND ((target_type='ORDER' AND target_seq=$1) OR (target_type='ORDER_PARCEL' AND target_seq=ANY($2::int[]))) GROUP BY action ORDER BY action",
    [id, parcels],
  );
  assert.deepEqual(audits.rows, [
    { action: 'ORDER_AMOUNT_CHANGED', n: 2 },
    { action: 'ORDER_CANCELLED', n: 1 },
    { action: 'ORDER_PARCEL_CANCELLED', n: 3 },
  ]);
});

test('later parcel audit failure rolls back earlier parcel changes, shipment history and audits', async () => {
  const { id, parcels } = await fixture({ status: 'notPaid' });
  const previous = await state(id),
    requestId = randomUUID();
  const audit = app.get(AuditService),
    original = audit.recordSuccess;
  let reachedSecond = false;
  audit.recordSuccess = async function (event, client) {
    if (event.action === 'ORDER_PARCEL_CANCELLED' && event.targetId === parcels[1]) {
      reachedSecond = true;
      throw new Error('second parcel audit failure probe');
    }
    return original.call(this, event, client);
  };
  try {
    assert.equal((await cancel(id, { parcels, requestId })).status, 500);
  } finally {
    audit.recordSuccess = original;
  }
  assert.equal(reachedSecond, true);
  assert.deepEqual(await state(id), previous);
  assert.equal(
    (
      await pool.query("SELECT 1 FROM audit_logs WHERE request_id=$1 AND result='SUCCESS'", [
        requestId,
      ])
    ).rowCount,
    0,
  );
});
