require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { ConfigService } = require('@nestjs/config');
const { AuditService } = require('../dist/audit/audit.service');
const { OrderSubmissionRepository } = require('../dist/orders/order-submission.repository');
const f = require('./helpers/manual-orders.cjs')();

test('69: anonymous, invalid sessions, foreign Origins and inactive accounts cannot submit', async () => {
  const before = await f.counts();
  await f.error(
    await f.send(f.body(), randomUUID(), 0, { Cookie: undefined }),
    401,
    'UNAUTHORIZED',
  );
  await f.error(
    await f.send(f.body(), randomUUID(), 0, { Cookie: 'dva_session=invalid' }),
    401,
    'UNAUTHORIZED',
  );
  await f.error(await f.send(f.body(), randomUUID(), 0, { Origin: undefined }), 403, 'FORBIDDEN');
  await f.error(
    await f.send(f.body(), randomUUID(), 0, { Origin: 'https://foreign.invalid' }),
    403,
    'FORBIDDEN',
  );
  await f.pool.query("UPDATE admin_users SET status='PENDING' WHERE admin_user_seq=$1", [
    f.adminIds[0],
  ]);
  try {
    await f.error(await f.send(), 401, 'UNAUTHORIZED');
  } finally {
    await f.pool.query("UPDATE admin_users SET status='ACTIVE' WHERE admin_user_seq=$1", [
      f.adminIds[0],
    ]);
  }
  assert.deepEqual(await f.counts(), before);
  assert.equal(f.requests.length, 0);
});

test('69: malformed orders and client-supplied AI/server fields are rejected without persistence', async () => {
  const before = await f.counts();
  for (const patch of [
    { call: {} },
    { outcome: 'COMPLETE' },
    { creationSource: 'AI' },
    { status: 'ACCEPTED' },
    { version: 4 },
    { pickupRequestedAt: '2026-10-28T10:00:00' },
    { parcels: [] },
    { parcels: null },
    { parcels: [null] },
    { customerSeq: '1' },
    { customerSeq: undefined },
    { customer: { name: '둘 다', phoneNumber: f.phone() } },
  ])
    await f.error(await f.send({ ...f.body(), ...patch }), 400, 'INVALID_REQUEST');
  await f.error(await f.send(f.body(), 'bad-key'), 400, 'INVALID_REQUEST');
  await f.error(
    await f.send(f.body(), randomUUID(), 0, { 'Idempotency-Key': undefined }),
    400,
    'INVALID_REQUEST',
  );
  await f.error(
    await f.send(f.body(), randomUUID(), 0, { call_session_seq: '1' }),
    400,
    'INVALID_REQUEST',
  );
  const missingAddress = f.body();
  missingAddress.parcels[0].destination = {};
  const error = await f.error(await f.send(missingAddress), 422, 'VALIDATION_FAILED');
  assert.ok(error.error.details.some((d) => d.field.includes('destination')));
  assert.deepEqual(await f.counts(), before);
  assert.equal(f.requests.length, 0);
});

test('69: customer state, PIN ownership and company payment eligibility reuse common validation', async () => {
  const before = await f.counts();
  await f.error(await f.send({ ...f.body(), customerSeq: 2147483647 }), 404, 'NOT_FOUND');
  await f.error(await f.send({ ...f.body(), customerSeq: f.withdrawnId }), 403, 'FORBIDDEN');
  const wrongPin = f.body();
  wrongPin.parcels[0].originPin = { scope: 'PERSONAL', pinSeq: f.otherPinId };
  await f.error(await f.send(wrongPin), 403, 'FORBIDDEN');
  await f.pool.query(
    'UPDATE organizations SET monthly_billing_enabled=false WHERE organization_seq=$1',
    [f.organizationId],
  );
  try {
    await f.error(await f.send(f.body()), 403, 'FORBIDDEN');
  } finally {
    await f.pool.query(
      'UPDATE organizations SET monthly_billing_enabled=true WHERE organization_seq=$1',
      [f.organizationId],
    );
  }
  await f.error(
    await f.send({ ...f.body(), customerSeq: f.otherId, paymentMethodType: 'groupBilling' }),
    403,
    'FORBIDDEN',
  );
  assert.deepEqual(await f.counts(), before);
  const company = await f.send({ ...f.body(), paymentMethodType: 'groupBilling' });
  assert.equal((await company.json()).data.status, 'ACCEPTED');
  const personal = await f.send({
    ...f.body(),
    customerSeq: f.otherId,
    paymentMethodType: 'billing',
  });
  assert.equal((await personal.json()).data.status, 'notPaid');
  assert.equal(f.requests.length, 1);
});

test('69: configuration or payment preparation failures roll back the collecting order and creation key', async () => {
  const before = await f.counts(),
    key = randomUUID();
  const config = f.app.get(ConfigService);
  config.set('DVER_API_KEY', '');
  try {
    await f.error(await f.send(f.body(), key), 503, 'DEPENDENCY_UNAVAILABLE');
  } finally {
    config.set('DVER_API_KEY', 'manual-test-only-key');
  }
  assert.deepEqual(await f.counts(), before);
  const input = {
    ...f.body(),
    customerSeq: undefined,
    customer: { name: '롤백 고객', phoneNumber: f.phone() },
    paymentMethodType: 'billing',
  };
  const audit = f.app.get(AuditService),
    record = audit.recordSuccess;
  audit.recordSuccess = async function (...args) {
    if (args[0].action === 'ORDER_PAYMENT_PENDING') throw Error('manual-prepare-failure');
    return record.apply(this, args);
  };
  try {
    await f.error(await f.send(input, key), 500, 'INTERNAL_ERROR');
  } finally {
    audit.recordSuccess = record;
  }
  assert.deepEqual(await f.counts(), before);
  assert.equal(f.requests.length, 0);
  const retry = await f.send(input, key);
  assert.equal((await retry.json()).data.status, 'notPaid');
  assert.equal((await f.counts()).customers, before.customers + 1);
  assert.equal(f.requests.length, 0);
});

test('69: retrying a key returns the saved result, survives restart and prevents cross-admin reuse', async () => {
  const key = randomUUID(),
    input = f.body();
  const first = await f.send(input, key);
  const { data } = await first.json();
  assert.equal(data.status, 'ACCEPTED');
  const before = await f.counts();
  const changed = f.body();
  changed.parcels[0].destination.roadAddress = '재적용 금지';
  assert.deepEqual((await (await f.send(changed, key.toUpperCase())).json()).data, data);
  const app = await f.start();
  assert.deepEqual((await (await f.send(input, key, 0, {}, await app.getUrl())).json()).data, data);
  await f.error(await f.send(input, key, 1), 403, 'FORBIDDEN');
  assert.deepEqual(await f.counts(), before);
  assert.equal(f.requests.length, 1);
});

test('69: a manual endpoint cannot consume an AI order key even if the creator is the same admin', async () => {
  const key = randomUUID();
  const phone = (
    await f.pool.query('SELECT phone_number FROM customers WHERE customer_seq=$1', [f.customerId])
  ).rows[0].phone_number;
  const ai = await f.post(
    '/api/orders',
    {
      ...f.body(),
      outcome: 'INCOMPLETE',
      call: {
        providerCallId: randomUUID(),
        callerPhoneNumber: phone,
        incomingAt: '2026-10-28T01:00:00Z',
      },
    },
    key,
  );
  assert.equal(ai.status, 201);
  const before = await f.counts();
  await f.error(await f.send(f.body(), key), 409, 'INVALID_STATE');
  assert.deepEqual(await f.counts(), before);
  assert.equal(f.requests.length, 0);
});

test('69: SUBMITTING is committed before external HTTP, with no lock and no concurrent resend', async () => {
  const key = randomUUID(),
    input = f.body();
  let release;
  const arrived = new Promise((resolve) => {
    f.respond = (_request, response) => {
      release = () => response.end(JSON.stringify(f.success));
      resolve();
    };
  });
  const first = f.send(input, key);
  await arrived;
  let orderId;
  try {
    const client = await f.pool.connect();
    try {
      await client.query('BEGIN');
      const state = (
        await client.query(
          'SELECT order_seq,status FROM orders WHERE creation_request_id=$1 FOR UPDATE NOWAIT',
          [key],
        )
      ).rows[0];
      assert.equal(state.status, 'SUBMITTING');
      orderId = state.order_seq;
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const retry = await f.send(input, key);
    assert.equal(retry.status, 202);
    assert.equal((await retry.json()).data.status, 'SUBMITTING');
    assert.equal(f.requests.length, 1);
  } finally {
    release();
  }
  assert.equal((await (await first).json()).data.status, 'ACCEPTED');
  assert.ok(orderId > 0);
});

test('69: external rejection, invalid response and timeout are recorded without automatic retries', async () => {
  for (const [respond, status] of [
    [
      (_req, res) => {
        res.writeHead(403);
        res.end('{}');
      },
      'SUBMITTING_FAILED',
    ],
    [(_req, res) => res.end('<html>failed</html>'), 'SUBMITTING_FAILED'],
    [() => {}, 'SUBMITTING_FAILED'],
  ]) {
    f.respond = respond;
    const key = randomUUID(),
      before = await f.counts(),
      sent = f.requests.length;
    const response = await f.send(f.body(), key);
    assert.equal(response.status, 201);
    const { data } = await response.json();
    assert.equal(data.status, status);
    assert.equal(data.parcelNo, null);
    assert.equal((await f.counts()).shipments, before.shipments);
    assert.equal((await (await f.send(f.body(), key)).json()).data.status, status);
    assert.equal(f.requests.length, sent + 1);
  }
});

test('69: result persistence failure leaves SUBMITTING and stale recovery never resends to Dver', async () => {
  const repo = f.app.get(OrderSubmissionRepository),
    finish = repo.finish;
  const key = randomUUID(),
    before = await f.counts();
  repo.finish = async function (...args) {
    await finish.apply(this, args);
    throw Error('manual-result-failure');
  };
  let data;
  try {
    const response = await f.send(f.body(), key);
    assert.equal(response.status, 202);
    data = (await response.json()).data;
    assert.equal(data.status, 'SUBMITTING');
  } finally {
    repo.finish = finish;
  }
  assert.equal((await f.counts()).shipments, before.shipments);
  const client = await f.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('ALTER TABLE orders DISABLE TRIGGER order_header_timestamp');
    await client.query(
      "UPDATE orders SET updated_at=now()-interval '2 minutes',submission_last_attempt_at=now()-interval '20 seconds' WHERE order_seq=$1",
      [data.orderSeq],
    );
    await client.query('ALTER TABLE orders ENABLE TRIGGER order_header_timestamp');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  const retry = await f.send(f.body(), key);
  assert.equal(retry.status, 201);
  assert.equal((await retry.json()).data.status, 'SUBMITTING_FAILED');
  assert.equal(f.requests.length, 1);
  assert.equal((await f.counts()).shipments, before.shipments);
});
