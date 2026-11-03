require('reflect-metadata');
const { beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { OrderSubmissionRepository } = require('../dist/orders/order-submission.repository');
const f = require('./helpers/manual-orders.cjs')();

beforeEach(async () => {
  // 워커는 DB 전체를 조회하므로 fixture가 확인한 임시 DB의 주문을 사례마다 비운다.
  await f.pool.query('TRUNCATE TABLE orders CASCADE');
});

async function interruptedOrder(stale = false) {
  const repository = f.app.get(OrderSubmissionRepository);
  const finish = repository.finish;
  repository.finish = async function (...args) {
    await finish.apply(this, args);
    throw new Error('submission-result-save-interrupted');
  };
  let id;
  try {
    const response = await f.send();
    assert.equal(response.status, 202);
    const data = (await response.json()).data;
    assert.equal(data.status, 'SUBMITTING');
    id = data.orderSeq;
  } finally {
    repository.finish = finish;
  }
  if (stale) {
    const client = await f.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE orders DISABLE TRIGGER order_header_timestamp');
      await client.query(
        "UPDATE orders SET updated_at=clock_timestamp()-interval '2 minutes',submission_last_attempt_at=clock_timestamp()-interval '20 seconds' WHERE order_seq=$1",
        [id],
      );
      await client.query('ALTER TABLE orders ENABLE TRIGGER order_header_timestamp');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  return id;
}

const retry = (id, headers) =>
  f.post(`/api/admin/orders/${id}/retry`, {}, randomUUID(), 0, headers);

test('10-minute retry policy stores a timed-out attempt as SUBMITTING_FAILED without repeating payment', async () => {
  f.respond = () => {};
  const response = await f.send();
  const data = (await response.json()).data;
  assert.equal(data.status, 'SUBMITTING_FAILED');
  const row = (
    await f.pool.query(
      `SELECT submission_first_attempt_at,submission_last_attempt_at,
       (SELECT count(*)::int FROM order_billing_charges b WHERE b.order_seq=o.order_seq) AS charges
       FROM orders o WHERE order_seq=$1`,
      [data.orderSeq],
    )
  ).rows[0];
  assert.ok(row.submission_first_attempt_at);
  assert.ok(row.submission_last_attempt_at);
  assert.equal(row.charges, 1);
  assert.equal(f.requests.length, 1);
});

test('admin retry preserves a fresh SUBMITTING order without another external submission', async () => {
  const id = await interruptedOrder();
  const response = await retry(id);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.status, 'SUBMITTING');
  assert.equal(f.requests.length, 1);
});

test('admin retry recovers a stale submission once, audits it and waits for a subsequent explicit retry', async () => {
  const id = await interruptedOrder(true);
  const response = await retry(id);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.status, 'SUBMITTING_FAILED');
  assert.equal(f.requests.length, 1);
  const detail = (await (await f.get(`/api/orders/${id}`)).json()).data;
  assert.equal(detail.status, 'SUBMITTING_FAILED');
  assert.equal(detail.parcels.length, 1);
  assert.equal(detail.totalAmount, 3500);
  assert.equal(
    (
      await f.pool.query(
        "SELECT count(*)::int AS n FROM audit_logs WHERE target_type='ORDER' AND target_seq=$1 AND action='ORDER_SUBMISSION_FAILED' AND result='SUCCESS'",
        [id],
      )
    ).rows[0].n,
    1,
  );
  const responses = await Promise.all([retry(id), retry(id)]);
  for (const result of responses) {
    assert.equal(result.status, 200);
    assert.ok(['SUBMITTING', 'ACCEPTED'].includes((await result.json()).data.status));
  }
  assert.equal(f.requests.length, 2);
  assert.equal((await (await f.get(`/api/orders/${id}`)).json()).data.status, 'ACCEPTED');
  assert.equal(
    (
      await f.pool.query(
        'SELECT count(*)::int AS n FROM order_billing_charges WHERE order_seq=$1',
        [id],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await f.pool.query(
        'SELECT count(*)::int AS n FROM shipments s JOIN order_parcels p USING(order_parcel_seq) WHERE p.order_seq=$1',
        [id],
      )
    ).rows[0].n,
    1,
  );
});

test('an unauthenticated admin retry cannot change a stale submission', async () => {
  const id = await interruptedOrder(true);
  await f.error(await retry(id, { Cookie: undefined }), 401, 'UNAUTHORIZED');
  assert.equal((await (await f.get(`/api/orders/${id}`)).json()).data.status, 'SUBMITTING');
  assert.equal(f.requests.length, 1);
});

const { OrderMaintenanceWorker } = require('../dist/orders/order-maintenance.worker');
const { OrderSubmissionService } = require('../dist/orders/order-submission.service');
const { OrderPaymentsService } = require('../dist/orders/order-payments.service');

async function failedOrder(name = '재접수 검증 ' + randomUUID()) {
  f.respond = (_request, response) => response.writeHead(503).end('test-only-unavailable');
  const input = f.body();
  input.parcels[0].origin.name = name;
  const response = await f.send(input);
  assert.equal(response.status, 201);
  const data = (await response.json()).data;
  assert.equal(data.status, 'SUBMITTING_FAILED');
  return data.orderSeq;
}

async function previousMinute(ids) {
  const client = await f.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('ALTER TABLE orders DISABLE TRIGGER order_header_timestamp');
    await client.query(
      "UPDATE orders SET updated_at=clock_timestamp()-interval '61 seconds',submission_first_attempt_at=LEAST(submission_first_attempt_at,clock_timestamp()-interval '61 seconds'),submission_last_attempt_at=clock_timestamp()-interval '61 seconds' WHERE order_seq=ANY($1::int[])",
      [ids],
    );
    await client.query('ALTER TABLE orders ENABLE TRIGGER order_header_timestamp');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const stored = async (id) => (await (await f.get(`/api/orders/${id}`)).json()).data;
function succeed() {
  f.respond = (_request, response) => response.end(JSON.stringify(f.success));
}
function gate() {
  let release;
  const promise = new Promise((resolve) => (release = resolve));
  return { promise, release };
}

async function submissionAge(id, first, last) {
  return (
    await f.pool.query(
      `UPDATE orders SET submission_first_attempt_at=statement_timestamp()-$2::interval,
       submission_last_attempt_at=statement_timestamp()-$3::interval WHERE order_seq=$1
       RETURNING submission_first_attempt_at`,
      [id, first, last],
    )
  ).rows[0].submission_first_attempt_at;
}

test('worker recovers an unanswered SUBMITTING attempt after ten seconds without an API replay', async () => {
  const id = await interruptedOrder();
  const first = await submissionAge(id, '20 seconds', '11 seconds');
  await f.app.get(OrderMaintenanceWorker).run();
  assert.equal((await stored(id)).status, 'SUBMITTING_FAILED');
  assert.equal(f.requests.length, 1, 'recovery does not bypass the one-minute retry interval');
  assert.deepEqual(
    (await f.pool.query('SELECT submission_first_attempt_at FROM orders WHERE order_seq=$1', [id]))
      .rows[0].submission_first_attempt_at,
    first,
  );
});

test('the ten-minute boundary ends automatic retries and explicit admin retry never reopens the window', async () => {
  const id = await failedOrder();
  const first = await submissionAge(id, '10 minutes', '61 seconds');
  const worker = f.app.get(OrderMaintenanceWorker);
  await worker.run();
  assert.equal((await stored(id)).status, 'SUBMISSION_FAILED');
  assert.equal(f.requests.length, 1);
  await worker.run();
  assert.equal(f.requests.length, 1);
  assert.equal((await (await retry(id)).json()).data.status, 'SUBMISSION_FAILED');
  assert.equal(f.requests.length, 2, 'an explicit manual request remains available');
  await worker.run();
  assert.equal(f.requests.length, 2, 'a manual failure never opens another automatic window');
  assert.deepEqual(
    (await f.pool.query('SELECT submission_first_attempt_at FROM orders WHERE order_seq=$1', [id]))
      .rows[0].submission_first_attempt_at,
    first,
  );
  succeed();
  assert.equal((await (await retry(id)).json()).data.status, 'ACCEPTED');
});

test('a restarted worker keeps the original retry clock and stops an expired interrupted attempt', async () => {
  const id = await interruptedOrder();
  const first = await submissionAge(id, '11 minutes', '11 seconds');
  const second = await f.start();
  await second.get(OrderMaintenanceWorker).run();
  assert.equal((await stored(id)).status, 'SUBMISSION_FAILED');
  assert.equal(f.requests.length, 1);
  assert.deepEqual(
    (await f.pool.query('SELECT submission_first_attempt_at FROM orders WHERE order_seq=$1', [id]))
      .rows[0].submission_first_attempt_at,
    first,
  );
});

test('a restarted worker retries within the original window without moving its first attempt', async () => {
  const id = await failedOrder();
  const first = await submissionAge(id, '2 minutes', '61 seconds');
  const second = await f.start();
  succeed();
  await second.get(OrderMaintenanceWorker).run();
  assert.equal((await stored(id)).status, 'ACCEPTED');
  assert.equal(f.requests.length, 2);
  assert.deepEqual(
    (await f.pool.query('SELECT submission_first_attempt_at FROM orders WHERE order_seq=$1', [id]))
      .rows[0].submission_first_attempt_at,
    first,
  );
});

test('an attempt near the automatic deadline cannot wait another full ten seconds', async () => {
  const id = await failedOrder();
  await submissionAge(id, '9 minutes 58 seconds', '61 seconds');
  f.respond = () => {};
  const started = Date.now();
  const response = await retry(id);
  assert.equal((await response.json()).data.status, 'SUBMISSION_FAILED');
  assert.ok(Date.now() - started < 5000, 'the remaining retry window caps the HTTP timeout');
  assert.equal(f.requests.length, 2);
  await f.app.get(OrderMaintenanceWorker).run();
  assert.equal(f.requests.length, 2);
});

test('a previous attempt cannot accept or overwrite a newer submission or duplicate its shipments', async () => {
  const id = await failedOrder();
  const previous = (
    await f.pool.query(
      'SELECT submission_last_attempt_at::text AS attempt FROM orders WHERE order_seq=$1',
      [id],
    )
  ).rows[0].attempt;
  const repository = f.app.get(OrderSubmissionRepository);
  const client = await f.pool.connect();
  try {
    await client.query('BEGIN');
    const current = await repository.start(client, id);
    const result = {
      status: 'ACCEPTED',
      parcelNo: 'TEST0069',
      receivedAt: new Date().toISOString(),
    };
    assert.equal(await repository.finish(client, id, result, previous), undefined);
    assert.equal(
      (await client.query('SELECT status FROM orders WHERE order_seq=$1', [id])).rows[0].status,
      'SUBMITTING',
    );
    assert.equal(await repository.finish(client, id, result, current.attempt), 'ACCEPTED');
    assert.equal(await repository.finish(client, id, result, current.attempt), undefined);
    await client.query('COMMIT');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  assert.equal(
    (
      await f.pool.query(
        'SELECT 1 FROM shipments s JOIN order_parcels p USING(order_parcel_seq) WHERE p.order_seq=$1',
        [id],
      )
    ).rowCount,
    1,
  );
});

test('twenty expired paid orders cannot occupy the retry batch ahead of a current order', async () => {
  await f.pool
    .query(`INSERT INTO orders(status,payment_method_type,total_amount,created_at,updated_at,paid_at,pickup_requested_at)
    SELECT 'PAID','billing',3500,statement_timestamp()-interval '6 years',statement_timestamp()-interval '6 years',
      statement_timestamp()-interval '6 years',statement_timestamp()-interval '6 years'+interval '1 hour'
    FROM generate_series(1,20)`);
  const id = await failedOrder();
  await previousMinute([id]);
  succeed();
  await f.app.get(OrderMaintenanceWorker).run();
  assert.equal((await stored(id)).status, 'ACCEPTED');
  assert.equal(f.requests.length, 2);
  assert.equal((await f.pool.query("SELECT 1 FROM orders WHERE status='PAID'")).rowCount, 20);
});

test('failure tab is separate from PAID with filtered totals, pagination, all admin roles and Swagger', async () => {
  const marker = '실패탭-' + randomUUID();
  const ids = [await failedOrder(marker), await failedOrder(marker)];
  const url = `/api/admin/orders?q=${encodeURIComponent(marker)}&statusGroup=SUBMISSION_FAILED`;
  for (let actor = 0; actor < 3; actor++) {
    const response = await f.get(url + '&limit=1', actor);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.total_count, 2);
    assert.equal(body.hasNext, true);
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].status, 'SUBMITTING_FAILED');
  }
  const emptyPage = await (await f.get(url + '&offset=100')).json();
  assert.equal(emptyPage.total_count, 2);
  assert.equal(emptyPage.hasNext, false);
  assert.deepEqual(emptyPage.data, []);
  const paid = await (
    await f.get(`/api/admin/orders?q=${encodeURIComponent(marker)}&statusGroup=PAID`)
  ).json();
  assert.equal(paid.total_count, 0);
  assert.deepEqual(paid.data, []);
  const all = await (await f.get(`/api/admin/orders?q=${encodeURIComponent(marker)}`)).json();
  assert.equal(all.total_count, 2);
  const doc = await (await fetch(f.host + '/api/docs-json')).json();
  assert.deepEqual(
    doc.paths['/api/admin/orders'].get.parameters.find((p) => p.name === 'statusGroup').schema.enum,
    ['COLLECTING', 'notPaid', 'PAID', 'SUBMISSION_FAILED', 'CANCELLED'],
  );
  succeed();
  for (const id of ids) assert.equal((await (await retry(id)).json()).data.status, 'ACCEPTED');
});

test('worker retries a failed order once per minute, preserves payment and pickup, and stops on success', async () => {
  const id = await failedOrder();
  const before = await stored(id);
  await previousMinute([id]);
  const worker = f.app.get(OrderMaintenanceWorker);
  await worker.run();
  assert.equal(f.requests.length, 2);
  assert.equal((await stored(id)).status, 'SUBMITTING_FAILED');
  assert.deepEqual(f.requests[1].body, f.requests[0].body);
  await worker.run();
  assert.equal(f.requests.length, 2, 'a fresh failure waits for the next minute');
  await previousMinute([id]);
  succeed();
  await worker.run();
  assert.equal(f.requests.length, 3);
  const after = await stored(id);
  assert.equal(after.status, 'ACCEPTED');
  assert.equal(after.totalAmount, before.totalAmount);
  assert.equal(after.paidAt, before.paidAt);
  assert.equal(after.pickupRequestedAt, before.pickupRequestedAt);
  await worker.run();
  assert.equal(f.requests.length, 3);
  const facts = (
    await f.pool.query(
      `SELECT
       (SELECT count(*)::int FROM order_billing_charges WHERE order_seq=$1) AS charges,
       (SELECT count(*)::int FROM audit_logs WHERE target_type='ORDER' AND target_seq=$1 AND action='ORDER_PAYMENT_COMPLETED') AS payments,
       (SELECT count(*)::int FROM audit_logs WHERE target_type='ORDER' AND target_seq=$1 AND action='ORDER_RESUBMISSION_STARTED' AND actor_type='SYSTEM') AS automatic,
       (SELECT count(*)::int FROM shipments s JOIN order_parcels p USING(order_parcel_seq) WHERE p.order_seq=$1) AS shipments`,
      [id],
    )
  ).rows[0];
  assert.deepEqual(facts, { charges: 1, payments: 1, automatic: 2, shipments: 1 });
});

for (const rival of ['admin', 'worker']) {
  test(`a stale worker snapshot cannot resend after a competing ${rival} attempt has already failed`, async () => {
    const id = await failedOrder();
    await previousMinute([id]);
    const secondApp = rival === 'worker' ? await f.start() : f.app;
    const service = secondApp.get(OrderSubmissionService);
    const original = service.submitPaidOrder;
    const selected = gate();
    const resume = gate();
    service.submitPaidOrder = async function (...args) {
      if (args[0] === id) {
        selected.release();
        await resume.promise;
      }
      return original.apply(this, args);
    };
    const waiting = secondApp.get(OrderMaintenanceWorker).run();
    try {
      await Promise.race([
        selected.promise,
        waiting.then(() => {
          throw Error('worker never selected the failed order');
        }),
      ]);
      if (rival === 'worker') {
        await f.app.get(OrderMaintenanceWorker).run();
      } else {
        service.submitPaidOrder = original;
        const response = await retry(id);
        assert.equal((await response.json()).data.status, 'SUBMITTING_FAILED');
      }
      assert.equal(f.requests.length, 2);
      resume.release();
      await waiting;
      assert.equal(f.requests.length, 2, 'the selected snapshot was consumed by the other attempt');
      assert.equal((await stored(id)).status, 'SUBMITTING_FAILED');
    } finally {
      service.submitPaidOrder = original;
      resume.release();
      await waiting;
    }
    succeed();
    assert.equal((await (await retry(id)).json()).data.status, 'ACCEPTED');
  });
}

test('worker still sends a PAID order immediately without repeating completed card payment', async () => {
  const response = await f.send({ ...f.body(), paymentMethodType: 'billing' });
  const order = (await response.json()).data;
  assert.equal(order.status, 'notPaid');
  const service = f.app.get(OrderSubmissionService);
  const original = service.submitPaidOrder;
  service.submitPaidOrder = async () => {
    throw Error('test-only-interrupted-before-submission');
  };
  const payments = f.app.get(OrderPaymentsService);
  try {
    const paymentKey = 'test-' + randomUUID();
    await payments.claimApproval(order.paymentRequest.paymentRequestId, 3500, paymentKey);
    await assert.rejects(
      payments.confirmPayment(
        order.paymentRequest.paymentRequestId,
        3500,
        paymentKey,
        randomUUID(),
      ),
      /test-only-interrupted-before-submission/,
    );
  } finally {
    service.submitPaidOrder = original;
  }
  assert.equal((await stored(order.orderSeq)).status, 'PAID');
  assert.equal(f.requests.length, 0);
  await f.app.get(OrderMaintenanceWorker).run();
  assert.equal(f.requests.length, 1);
  assert.equal((await stored(order.orderSeq)).status, 'ACCEPTED');
  await f.app.get(OrderMaintenanceWorker).run();
  assert.equal(f.requests.length, 1);
});

test('worker batches rotate past twenty failed orders without sending a fresh failure twice', async () => {
  const ids = [];
  for (let i = 0; i < 21; i++) ids.push(await failedOrder());
  await previousMinute(ids);
  const worker = f.app.get(OrderMaintenanceWorker);
  await worker.run();
  assert.equal(f.requests.length, 41);
  await worker.run();
  assert.equal(f.requests.length, 42);
  await worker.run();
  assert.equal(f.requests.length, 42);
  const attempts = (
    await f.pool.query(
      "SELECT target_seq,count(*)::int AS n FROM audit_logs WHERE action='ORDER_RESUBMISSION_STARTED' AND target_type='ORDER' AND actor_type='SYSTEM' AND target_seq=ANY($1::int[]) GROUP BY target_seq",
      [ids],
    )
  ).rows;
  assert.equal(attempts.length, 21);
  assert.ok(attempts.every((attempt) => attempt.n === 1));
  succeed();
  for (const id of ids) await retry(id);
});
