const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const f = require('./helpers/manual-orders.cjs')();

test('manual recipient landlines survive persistence, Dver submission and personal PIN registration while sender landlines never submit', async () => {
  for (const phone of ['0212345678', '03212345678']) {
    const input = f.body();
    input.parcels[0].destination = { ...input.parcels[0].destination, phoneNumber: phone };
    const response = await f.send(input, randomUUID());
    assert.equal(response.status, 201, await response.clone().text());
    const { data } = await response.json();
    assert.equal(data.status, 'ACCEPTED');
    assert.equal(f.requests.at(-1).body.outboundParcels[0].destination.phoneNumber, phone);
    const saved = (await (await f.get(`/api/orders/${data.orderSeq}`)).json()).data;
    assert.equal(saved.parcels[0].destination.phoneNumber, phone);
    assert.equal(
      (
        await f.pool.query(
          "SELECT 1 FROM personal_pins WHERE customer_seq=$1 AND deleted_at IS NULL AND address_data->>'phoneNumber'=$2",
          [f.customerId, phone],
        )
      ).rowCount,
      1,
    );
    const count = f.requests.length;
    input.parcels[0].origin = { ...input.parcels[0].origin, phoneNumber: phone };
    const rejected = await f.send(input, randomUUID());
    assert.equal(rejected.status, 400);
    assert.equal(f.requests.length, count);
  }
});

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

test('manual reception saves only recipients once per customer across duplicate parcels and concurrent orders', async () => {
  const destination = { ...f.address, name: '수령인', roadAddress: '자동 PIN ' + randomUUID() };
  const second = { ...destination, detailAddress: '다른 호수' };
  const input = f.body();
  input.paymentMethodType = 'billing';
  input.parcels[0].origin = { ...f.address, roadAddress: '보내는 곳 ' + randomUUID() };
  input.parcels = [destination, second, destination, f.address].map((address) => ({
    ...structuredClone(input.parcels[0]),
    destination: address,
  }));
  input.totalAmount = 14000;
  const existing = (
    await f.pool.query(
      'SELECT to_jsonb(p) AS data FROM personal_pins p WHERE personal_pin_seq=$1',
      [f.pinId],
    )
  ).rows[0].data;
  const reversed = structuredClone(input);
  reversed.parcels.reverse();
  for (const response of await Promise.all([f.send(input), f.send(reversed)])) {
    assert.equal(response.status, 201, await response.clone().text());
    assert.equal((await response.json()).data.status, 'notPaid');
  }
  const pins = async (customerId, address) =>
    (
      await f.pool.query(
        'SELECT personal_pin_seq,label,address_data,version FROM personal_pins WHERE customer_seq=$1 AND deleted_at IS NULL AND pin_identity(address_data)=pin_identity($2::jsonb)',
        [customerId, address],
      )
    ).rows;
  for (const address of [destination, second]) {
    const saved = await pins(f.customerId, address);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].label, destination.name);
    assert.deepEqual(saved[0].address_data, address);
  }
  assert.equal((await pins(f.customerId, input.parcels[0].origin)).length, 0);
  assert.deepEqual(
    (
      await f.pool.query(
        'SELECT to_jsonb(p) AS data FROM personal_pins p WHERE personal_pin_seq=$1',
        [f.pinId],
      )
    ).rows[0].data,
    existing,
  );
  const other = f.body();
  other.customerSeq = f.otherId;
  other.paymentMethodType = 'billing';
  other.parcels[0].destination = destination;
  assert.equal((await f.send(other)).status, 201);
  assert.equal((await pins(f.otherId, destination)).length, 1);
  assert.equal(f.requests.length, 0);
});
