require('reflect-metadata');
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { NestFactory } = require('@nestjs/core');
const { configureApplication } = require('../dist/configure-application');
const { hashPassword } = require('../dist/auth/password');
const { AuditService } = require('../dist/audit/audit.service');

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.DB_NAME, 'dva_webhook_test');
assert.ok(['db', '127.0.0.1'].includes(process.env.DB_HOST));
process.env.SWAGGER_ENABLED = 'true';
const origin = 'http://localhost:5173';
process.env.CORS_ORIGINS = origin;
const { AppModule } = require('../dist/app.module');
const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});
let app, base, customerId, otherId, callId;
const cookies = [],
  adminIds = [];
const phone = '01064000001';

before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApplication(app, { log: () => {} });
  await app.listen(0, '127.0.0.1');
  base = (await app.getUrl()) + '/api';
  const password = 'cancel-test-password';
  const hash = await hashPassword(password);
  for (const role of ['OPERATOR', 'SUPERVISOR', 'SYSTEM_ADMIN']) {
    const loginId = 'cancel' + role.replaceAll('_', '');
    const admin = await pool.query(
      "INSERT INTO admin_users(login_id,name,password_hash,role,status) VALUES($1,'취소 검증',$2,$3,'ACTIVE') RETURNING admin_user_seq",
      [loginId, hash, role],
    );
    adminIds.push(admin.rows[0].admin_user_seq);
    const res = await fetch(base + '/auth/login', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginId, password }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    cookies.push(res.headers.get('set-cookie').split(';')[0]);
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
      'INSERT INTO call_sessions(provider_call_id,caller_phone_number) VALUES($1,$2) RETURNING call_session_seq',
      [randomUUID(), phone],
    )
  ).rows[0].call_session_seq;
});

after(async () => {
  if (app) await app.close();
  await pool.end();
});

async function fixture({
  status = 'COLLECTING',
  count = 2,
  customer = customerId,
  shipments = [],
} = {}) {
  const id = (
    await pool.query('INSERT INTO orders(customer_seq) VALUES($1) RETURNING order_seq', [customer])
  ).rows[0].order_seq;
  const parcels = [];
  for (let position = 1; position <= count; position++) {
    const parcel = (
      await pool.query(
        "INSERT INTO order_parcels(order_seq,parcel_position,other_item_description) VALUES($1,$2,'보존할 물품') RETURNING order_parcel_seq",
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
  if (status !== 'COLLECTING')
    await pool.query(
      `UPDATE orders SET status=$2,pickup_requested_at=clock_timestamp()+interval '1 day',
      parcel_no=CASE WHEN $2='ACCEPTED' THEN 'TEST0064' ELSE NULL END,
      dver_received_at=CASE WHEN $2='ACCEPTED' THEN clock_timestamp() ELSE NULL END WHERE order_seq=$1`,
      [id, status],
    );
  return { id, parcels };
}

function cancel(id, { cookie = cookies[0], call, requestId = randomUUID(), parcel } = {}) {
  return fetch(`${base}/orders/${id}${parcel === undefined ? '' : `/parcels/${parcel}`}/cancel`, {
    method: 'POST',
    headers: {
      Origin: origin,
      'X-Request-Id': requestId,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(call === undefined ? {} : { call_session_seq: String(call) }),
    },
  });
}

async function state(id) {
  return (
    await pool.query(
      `SELECT jsonb_build_object(
    'order',(SELECT to_jsonb(o) FROM orders o WHERE order_seq=$1),
    'parcels',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY order_parcel_seq),'[]') FROM order_parcels p WHERE order_seq=$1),
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
  }
});

test('unpaid accepted order preserves receipt and snapshots; history and audit commit once', async () => {
  const { id } = await fixture({ status: 'ACCEPTED', shipments: ['notPaid', 'notPaid'] });
  const previous = await state(id);
  const requestId = randomUUID();
  assert.equal((await cancel(id, { requestId })).status, 204);
  const saved = await state(id);
  assert.equal(saved.order.status, 'CANCELLED');
  assert.equal(saved.order.parcel_no, previous.order.parcel_no);
  assert.equal(saved.order.dver_received_at, previous.order.dver_received_at);
  assert.deepEqual(
    saved.parcels.map(({ status, ...p }) => p),
    previous.parcels.map(({ status, ...p }) => p),
  );
  assert.ok(saved.shipments.every((s) => s.status === 'canceled' && s.version === 2));
  assert.equal(saved.history.length, 2);
  assert.equal(new Set(saved.history.map((h) => h.request_id)).size, 2);
  assert.ok(
    saved.history.every(
      (h) =>
        h.from_status === 'notPaid' &&
        h.to_status === 'canceled' &&
        h.actor_type === 'ADMIN' &&
        h.actor_admin_user_seq === adminIds[0],
    ),
  );
  const audit = (
    await pool.query("SELECT * FROM audit_logs WHERE request_id=$1 AND result='SUCCESS'", [
      requestId,
    ])
  ).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, 'ORDER_CANCELLED');
  assert.equal(audit[0].target_seq, id);
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
    ...['SUBMITTING', 'REVIEW_REQUIRED', 'AUTH_FAILED', 'EXPIRED'].map((status) => ({ status })),
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

test('duplicate concurrent whole requests change state/history once', async () => {
  const { id } = await fixture({ status: 'ACCEPTED', shipments: ['notPaid', 'notPaid'] });
  const responses = await Promise.all([cancel(id), cancel(id), cancel(id)]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [204, 409, 409]);
  assert.equal((await state(id)).history.length, 2);
  const audits = await pool.query(
    "SELECT count(*)::int AS n FROM audit_logs WHERE target_seq=$1 AND target_type='ORDER' AND action='ORDER_CANCELLED' AND result='SUCCESS'",
    [id],
  );
  assert.equal(audits.rows[0].n, 1);
});

test('audit failure rolls back order, parcel and shipment writes', async () => {
  const { id } = await fixture({ status: 'ACCEPTED', shipments: ['notPaid', 'notPaid'] });
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

test('cancellation waits for a concurrent payment transaction and rechecks paid state', async () => {
  const { id, parcels } = await fixture({ status: 'ACCEPTED', shipments: ['notPaid', 'notPaid'] });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("UPDATE shipments SET status='paid' WHERE order_parcel_seq=$1", [
      parcels[0],
    ]);
    const pending = cancel(id);
    let waiting = false;
    for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
      waiting = (
        await pool.query(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM shipments%') AS waiting",
        )
      ).rows[0].waiting;
      if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(waiting, true, 'cancellation must wait on the locked shipment');
    await client.query('COMMIT');
    assert.equal((await pending).status, 409);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  const saved = await state(id);
  assert.equal(saved.order.status, 'ACCEPTED');
  assert.ok(saved.parcels.every((p) => p.status === 'ACTIVE'));
  assert.equal(saved.history.length, 0);
});

test('path validation and Swagger describe empty 204 with one call header', async () => {
  for (const id of ['0', '-1', 'abc', '2147483648']) assert.equal((await cancel(id)).status, 400);
  assert.equal((await cancel(2147483647)).status, 404);
  const doc = await (await fetch(base + '/docs-json')).json();
  const operation = doc.paths['/api/orders/{id}/cancel'].post;
  assert.equal(operation.summary, '주문 전체 취소');
  assert.equal(operation.requestBody, undefined);
  assert.equal(operation.responses['204'].content, undefined);
  assert.equal(operation.responses['202'], undefined);
  assert.equal(
    operation.parameters.filter((p) => p.name.toLowerCase() === 'call_session_seq').length,
    1,
  );
  assert.equal(
    operation.parameters.some((p) => p.name.toLowerCase() === 'idempotency-key'),
    false,
  );
  assert.deepEqual(doc.components.schemas.OrderParcelDto.properties.status.enum, [
    'ACTIVE',
    'CANCELLED',
  ]);
});

test('individual cancellation preserves siblings and completes the parent only on the last parcel', async () => {
  const { id, parcels } = await fixture({ status: 'ACCEPTED', shipments: ['notPaid', 'notPaid'] });
  assert.equal((await cancel(id, { parcel: parcels[0] })).status, 204);
  const partial = await state(id);
  assert.equal(partial.order.status, 'ACCEPTED');
  assert.deepEqual(
    partial.parcels.map((p) => p.status),
    ['CANCELLED', 'ACTIVE'],
  );
  assert.deepEqual(
    partial.shipments.map((s) => s.status),
    ['canceled', 'notPaid'],
  );
  const repeated = await cancel(id, { parcel: parcels[0] });
  assert.equal(repeated.status, 204);
  assert.equal(await repeated.text(), '');
  assert.deepEqual(await state(id), partial);
  assert.equal((await cancel(id, { parcel: parcels[1] })).status, 204);
  const complete = await state(id);
  assert.equal(complete.order.status, 'CANCELLED');
  assert.equal(complete.order.parcel_no, 'TEST0064');
  assert.equal(complete.history.length, 2);
  assert.equal((await cancel(id, { parcel: parcels[0] })).status, 204);
  assert.deepEqual(await state(id), complete);
  assert.equal((await cancel(id)).status, 409);
  const audit = await pool.query(
    "SELECT action,count(*)::int AS n FROM audit_logs WHERE result='SUCCESS' AND ((target_type='ORDER' AND target_seq=$1) OR (target_type='ORDER_PARCEL' AND target_seq=ANY($2::int[]))) GROUP BY action ORDER BY action",
    [id, parcels],
  );
  assert.deepEqual(audit.rows, [
    { action: 'ORDER_CANCELLED', n: 1 },
    { action: 'ORDER_PARCEL_CANCELLED', n: 2 },
  ]);
});

test('whole cancellation skips cancelled parcels, but a paid remaining parcel still blocks all writes', async () => {
  const { id, parcels } = await fixture({ status: 'ACCEPTED', shipments: ['notPaid', 'notPaid'] });
  assert.equal((await cancel(id, { parcel: parcels[0] })).status, 204);
  assert.equal((await cancel(id)).status, 204);
  assert.equal((await state(id)).history.length, 2);
  const paid = await fixture({ status: 'ACCEPTED', shipments: ['notPaid', 'paid'] });
  assert.equal((await cancel(paid.id, { parcel: paid.parcels[0] })).status, 204);
  const previous = await state(paid.id);
  assert.equal((await cancel(paid.id)).status, 409);
  assert.equal((await cancel(paid.id, { parcel: paid.parcels[1] })).status, 409);
  assert.deepEqual(await state(paid.id), previous);
});

test('individual route validates parcel membership, IDs and AI ownership before any no-op or mutation', async () => {
  const mine = await fixture();
  const other = await fixture({ customer: otherId });
  for (const parcel of ['0', '-1', 'bad', '2147483648'])
    assert.equal((await cancel(mine.id, { parcel })).status, 400);
  assert.equal((await cancel(mine.id, { parcel: other.parcels[0] })).status, 404);
  assert.equal((await cancel(mine.id, { parcel: 2147483647 })).status, 404);
  assert.equal(
    (await cancel(other.id, { parcel: other.parcels[0], cookie: null, call: callId })).status,
    404,
  );
  assert.equal((await cancel(other.id)).status, 204);
  assert.equal(
    (await cancel(other.id, { parcel: other.parcels[0], cookie: null, call: callId })).status,
    404,
  );
  assert.equal(
    (await cancel(mine.id, { parcel: mine.parcels[0], cookie: null, call: callId })).status,
    204,
  );
  assert.equal((await state(mine.id)).order.status, 'COLLECTING');
  const accepted = await fixture({ status: 'ACCEPTED', shipments: ['notPaid', 'notPaid'] });
  assert.equal(
    (await cancel(accepted.id, { parcel: accepted.parcels[0], cookie: null, call: callId })).status,
    204,
  );
  assert.equal((await state(accepted.id)).history[0].actor_type, 'SYSTEM');
});

test('individual retries and different-parcel cancellations serialize without duplicate history', async () => {
  const { id, parcels } = await fixture({ status: 'ACCEPTED', shipments: ['notPaid', 'notPaid'] });
  const first = await Promise.all(
    Array.from({ length: 3 }, () => cancel(id, { parcel: parcels[0] })),
  );
  assert.ok(first.every((r) => r.status === 204));
  assert.equal((await state(id)).history.length, 1);
  assert.equal((await cancel(id)).status, 204);
  const second = await fixture({ status: 'ACCEPTED', shipments: ['notPaid', 'notPaid'] });
  const different = await Promise.all(
    second.parcels.map((parcel) => cancel(second.id, { parcel })),
  );
  assert.ok(different.every((r) => r.status === 204));
  assert.equal((await state(second.id)).order.status, 'CANCELLED');
  assert.equal((await state(second.id)).history.length, 2);
});

test('failure while completing the last parcel rolls back both cancellation audits and all states', async () => {
  const { id, parcels } = await fixture({ status: 'ACCEPTED', count: 1, shipments: ['notPaid'] });
  const previous = await state(id);
  const requestId = randomUUID();
  const audit = app.get(AuditService),
    original = audit.recordSuccess;
  audit.recordSuccess = async function (event, client) {
    if (event.action === 'ORDER_CANCELLED') throw new Error('parent audit failure probe');
    return original.call(this, event, client);
  };
  try {
    assert.equal((await cancel(id, { parcel: parcels[0], requestId })).status, 500);
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

test('individual Swagger has both database identifiers, no body and a single optional call header', async () => {
  const doc = await (await fetch(base + '/docs-json')).json();
  const operation = doc.paths['/api/orders/{id}/parcels/{orderParcelSeq}/cancel'].post;
  assert.equal(operation.summary, '주문 상세 개별 취소');
  assert.equal(operation.requestBody, undefined);
  assert.equal(operation.responses['204'].content, undefined);
  assert.equal(operation.responses['202'], undefined);
  assert.deepEqual(
    operation.parameters
      .filter((p) => p.in === 'path')
      .map((p) => p.name)
      .sort(),
    ['id', 'orderParcelSeq'],
  );
  const headers = operation.parameters.filter((p) => p.in === 'header');
  assert.deepEqual(
    headers.map((p) => p.name),
    ['call_session_seq'],
  );
  assert.equal(headers[0].required, false);
});
