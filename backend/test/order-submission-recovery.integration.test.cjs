require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { OrderSubmissionRepository } = require('../dist/orders/order-submission.repository');
const f = require('./helpers/manual-orders.cjs')();

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
        "UPDATE orders SET updated_at=clock_timestamp()-interval '2 minutes' WHERE order_seq=$1",
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
  assert.equal((await response.json()).data.status, 'SUBMISSION_FAILED');
  assert.equal(f.requests.length, 1);
  const detail = (await (await f.get(`/api/orders/${id}`)).json()).data;
  assert.equal(detail.status, 'SUBMISSION_FAILED');
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
