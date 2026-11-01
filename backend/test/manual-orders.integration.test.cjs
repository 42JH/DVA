const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const f = require('./helpers/manual-orders.cjs')();

test('69: each active admin role submits a complete manual order without a call', async () => {
  for (let actor = 0; actor < 3; actor++) {
    const before = await f.counts();
    const input = f.body();
    input.parcels[0].originPin = { scope: 'PERSONAL', pinSeq: f.pinId };
    input.parcels.push({
      ...structuredClone(input.parcels[0]),
      destination: { ...f.address, roadAddress: '다른 도착로 2' },
    });
    input.totalAmount = 7000;
    const response = await f.send(input, randomUUID(), actor);
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const { data, meta } = await response.json();
    assert.equal(data.status, 'ACCEPTED');
    assert.equal(data.creationSource, 'ADMIN');
    assert.equal(data.parcelNo, f.success.parcelNo);
    assert.ok(meta.requestId);
    assert.equal(Object.hasOwn(data, 'callSessionSeq'), false);
    assert.equal(response.headers.get('location'), `/api/orders/${data.orderSeq}`);
    const after = await f.counts();
    assert.deepEqual(after, {
      ...before,
      orders: before.orders + 1,
      parcels: before.parcels + 2,
      shipments: before.shipments + 2,
    });
    const sent = f.requests.at(-1);
    assert.equal(sent.method, 'POST');
    assert.equal(sent.url, '/parcel');
    assert.equal(sent.headers['x-api-key'], 'manual-test-only-key');
    assert.equal(sent.body.outboundParcels.length, 2);
    assert.deepEqual(
      sent.body.outboundParcels.map((p) => p.notifiedPrice),
      [3500, 3500],
    );
    assert.equal(sent.body.outboundParcels[0].item.smallBox, 2);
    assert.equal(Object.hasOwn(sent.body, 'creationSource'), false);
    const detail = (await (await f.get(`/api/orders/${data.orderSeq}`, actor)).json()).data;
    assert.equal(detail.creationSource, 'ADMIN');
    assert.equal(detail.parcels.length, 2);
    const list = (await (await f.get(`/api/orders?customerSeq=${f.customerId}`, actor)).json())
      .data;
    assert.equal(list.find((o) => o.orderSeq === data.orderSeq).creationSource, 'ADMIN');
    const history = await f.pool.query(
      `SELECT h.to_status,h.actor_type FROM shipment_status_history h JOIN shipments s USING(shipment_seq) JOIN order_parcels p USING(order_parcel_seq) WHERE p.order_seq=$1`,
      [data.orderSeq],
    );
    assert.equal(history.rowCount, 2);
    assert.ok(history.rows.every((h) => h.to_status === 'paid' && h.actor_type === 'SYSTEM'));
    const audit = (
      await f.pool.query(
        "SELECT action,actor_type,actor_seq,result FROM audit_logs WHERE target_type='ORDER' AND target_seq=$1 ORDER BY audit_log_seq",
        [data.orderSeq],
      )
    ).rows;
    assert.deepEqual(
      audit.map((a) => a.action),
      [
        'ORDER_CREATED',
        'ORDER_PAYMENT_COMPLETED',
        'ORDER_SUBMISSION_STARTED',
        'ORDER_SUBMISSION_ACCEPTED',
      ],
    );
    assert.equal(audit[0].actor_seq, f.adminIds[actor]);
    assert.equal(audit[0].actor_type, 'ADMIN');
    assert.ok(audit.slice(1).every((a) => a.actor_type === 'SYSTEM' && a.actor_seq === null));
    assert.ok(audit.every((a) => a.result === 'SUCCESS'));
  }
  assert.equal(f.requests.length, 3);
});

test('69: new customers are registered atomically and an existing phone does not overwrite their name', async () => {
  const phoneNumber = f.phone();
  const input = f.body();
  delete input.customerSeq;
  input.customer = { name: '신규 수기 고객', phoneNumber };
  input.paymentMethodType = 'billing';
  const before = await f.counts();
  const created = await f.send(input);
  assert.equal(created.status, 201);
  assert.equal((await created.json()).data.status, 'notPaid');
  assert.equal(f.requests.length, 0);
  assert.equal((await f.counts()).customers, before.customers + 1);
  const replayCustomer = await f.send({
    ...input,
    customer: { name: '덮어쓰지 않음', phoneNumber },
  });
  assert.equal(replayCustomer.status, 201);
  assert.equal((await f.counts()).customers, before.customers + 1);
  assert.equal(
    (await f.pool.query('SELECT name FROM customers WHERE phone_number=$1', [phoneNumber])).rows[0]
      .name,
    '신규 수기 고객',
  );
});

test('69: legacy admin drafts remain partial and AI results keep the existing payload and response', async () => {
  const before = await f.counts();
  const draft = await f.post('/api/orders', { customerSeq: f.customerId });
  assert.equal(draft.status, 201);
  const draftData = (await draft.json()).data;
  assert.deepEqual(Object.keys(draftData).sort(), ['orderSeq', 'version']);
  assert.equal(
    (await (await f.get(`/api/orders/${draftData.orderSeq}`)).json()).data.creationSource,
    'ADMIN',
  );
  const input = f.body();
  input.customerSeq = f.otherId;
  input.outcome = 'COMPLETE';
  input.call = {
    providerCallId: 'ai-manual-regression-' + randomUUID(),
    callerPhoneNumber: (
      await f.pool.query('SELECT phone_number FROM customers WHERE customer_seq=$1', [f.otherId])
    ).rows[0].phone_number,
    incomingAt: '2026-10-28T01:00:00Z',
  };
  const ai = await f.post('/api/orders', input, randomUUID(), 0, {
    Cookie: undefined,
    Origin: undefined,
  });
  assert.equal(ai.status, 201);
  const aiData = (await ai.json()).data;
  assert.equal(aiData.status, 'ACCEPTED');
  assert.ok(aiData.callSessionSeq > 0);
  assert.equal(
    (await (await f.get(`/api/orders/${aiData.orderSeq}`)).json()).data.creationSource,
    'AI',
  );
  assert.equal((await f.counts()).calls, before.calls + 1);
  assert.equal(f.requests.length, 1);
});
