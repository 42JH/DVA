module.exports = function registerOrdersReads(suite) {
  const {
    test,
    readCustomer,
    readOrder,
    pool,
    readOrders,
    assert,
    randomUUID,
    call,
    aiReadHeaders,
    errorCode,
    testMembership,
    address,
    readDetail,
  } = suite;
  test('ORD-02 paginates orders once each, including zero-detail drafts and equal creation times', async () => {
    const { customer } = await readCustomer();
    const ids = [];
    for (let i = 0; i < 3; i++)
      ids.push(
        await readOrder(
          customer,
          Array.from({ length: i }, () => ({})),
        ),
      );
    await pool.query("UPDATE orders SET created_at='2026-10-27T01:00:00Z' WHERE customer_seq=$1", [
      customer,
    ]);
    const first = await readOrders(`?customerSeq=${customer}&limit=2`);
    assert.equal(first.status, 200);
    const body = await first.json();
    assert.deepEqual(Object.keys(body).sort(), ['data', 'hasNext', 'total_count']);
    assert.equal(body.hasNext, true);
    assert.deepEqual(
      body.data.map((o) => o.orderSeq),
      [ids[2], ids[1]],
    );
    assert.deepEqual(
      body.data.map((o) => o.parcelCount),
      [2, 1],
    );
    assert.equal(Object.hasOwn(body.data[0], 'shipmentStatuses'), false);
    assert.equal(body.data[0].pickupRequestedAt, null);
    assert.equal(body.data[0].status, 'COLLECTING');
    const last = await (await readOrders(`?customerSeq=${customer}&limit=2&offset=2`)).json();
    assert.equal(last.hasNext, false);
    assert.deepEqual(
      last.data.map((o) => o.orderSeq),
      [ids[0]],
    );
    assert.equal(last.data[0].parcelCount, 0);
    assert.deepEqual(await (await readOrders(`?customerSeq=${customer}&offset=3`)).json(), {
      data: [],
      hasNext: false,
      total_count: 3,
    });
  });

  test('ORD-02 combines filters, keeps date boundaries and aggregates all parcels without duplicates', async () => {
    const { customer } = await readCustomer();
    const selected = await readOrder(customer, [
      { destination: { name: 'Alice_100%' } },
      { destination: { name: '다른 수령인' } },
      { destination: { name: 'Alice_100%' } },
    ]);
    const end = await readOrder(customer, [{ destination: { name: 'Alice_100%' } }]);
    await pool.query(
      "UPDATE orders SET created_at='2026-10-27T00:00:00Z',pickup_requested_at='2026-10-28T00:00:00Z',status='ACCEPTED',parcel_no='READ0058',dver_received_at='2026-10-27T01:00:00Z' WHERE order_seq=$1",
      [selected],
    );
    await pool.query("UPDATE orders SET created_at='2026-10-28T00:00:00Z' WHERE order_seq=$1", [
      end,
    ]);
    const parcels = (
      await pool.query(
        'SELECT order_parcel_seq FROM order_parcels WHERE order_seq=$1 ORDER BY parcel_position',
        [selected],
      )
    ).rows;
    for (const [i, p] of parcels.entries())
      await pool.query(
        'INSERT INTO shipments(order_parcel_seq,tracking_number,status) VALUES($1,$2,$3)',
        [p.order_parcel_seq, randomUUID(), ['paid', 'sent', 'paid'][i]],
      );
    const filters = new URLSearchParams({
      customerSeq: customer,
      from: '2026-10-27T09:00:00+09:00',
      to: '2026-10-28T00:00:00Z',
      status: 'ACCEPTED',
      recipientName: 'alice_100%',
    });
    const response = await readOrders('?' + filters);
    assert.equal(response.status, 200);
    const { data, hasNext } = await response.json();
    assert.equal(hasNext, false);
    assert.equal(data.length, 1);
    assert.equal(data[0].orderSeq, selected);
    assert.equal(data[0].parcelCount, 3);
    assert.equal(data[0].status, 'ACCEPTED');
    assert.equal(Object.hasOwn(data[0], 'shipmentStatuses'), false);
    const range = await (
      await readOrders(`?customerSeq=${customer}&from=2026-10-27T00:00:00Z&to=2026-10-28T00:00:00Z`)
    ).json();
    assert.deepEqual(
      range.data.map((o) => o.orderSeq),
      [selected],
    );
    for (const text of ['%', '_', "' OR 1=1 --"]) {
      const result = await (
        await readOrders(`?customerSeq=${customer}&recipientName=${encodeURIComponent(text)}`)
      ).json();
      assert.equal(result.data.length, text.includes('OR') ? 0 : 2);
    }
    assert.deepEqual(
      (await (await readOrders(`?customerSeq=${customer}&status=CANCELLED`)).json()).data,
      [],
    );
  });

  test('order list filters every order status independently of shipment state', async () => {
    const { customer } = await readCustomer();
    const statuses = [
      'COLLECTING',
      'notPaid',
      'PAID',
      'SUBMITTING',
      'ACCEPTED',
      'SUBMISSION_FAILED',
      'CANCELLED',
    ];
    const orders = new Map();
    for (const status of statuses) {
      const id = await readOrder(customer);
      await pool.query(
        `UPDATE orders SET status=$2,pickup_requested_at='2026-10-28T00:00:00Z',
       parcel_no=CASE WHEN $2='ACCEPTED' THEN 'READ0058' END,
       dver_received_at=CASE WHEN $2='ACCEPTED' THEN '2026-10-27T00:00:00Z'::timestamptz END
       WHERE order_seq=$1`,
        [id, status],
      );
      orders.set(status, id);
    }
    for (const status of statuses) {
      const response = await readOrders(`?customerSeq=${customer}&status=${status}`);
      assert.equal(response.status, 200);
      const { data } = await response.json();
      assert.deepEqual(
        data.map((order) => [order.orderSeq, order.status]),
        [[orders.get(status), status]],
      );
      assert.equal(Object.hasOwn(data[0], 'shipmentStatuses'), false);
    }
  });

  test('ORD-02 AI scope comes from the active call customer, never arbitrary customer filters', async () => {
    const { customer, phone } = await readCustomer();
    const own = await readOrder(customer);
    await readOrder(suite.otherId);
    const callId = await call(phone);
    const result = await readOrders('', aiReadHeaders(callId));
    assert.equal(result.status, 200);
    assert.deepEqual(
      (await result.json()).data.map((o) => o.orderSeq),
      [own],
    );
    assert.equal((await readOrders(`?customerSeq=${customer}`, aiReadHeaders(callId))).status, 200);
    await errorCode(
      await readOrders(`?customerSeq=${suite.otherId}`, aiReadHeaders(callId)),
      403,
      'FORBIDDEN',
    );
    await errorCode(await readOrders('', aiReadHeaders(await call())), 403, 'FORBIDDEN');
    await errorCode(
      await readOrders('', aiReadHeaders(await call('01099999999'))),
      403,
      'FORBIDDEN',
    );
    await errorCode(
      await readOrders('', aiReadHeaders(await call(phone, true))),
      409,
      'INVALID_STATE',
    );
    await pool.query("UPDATE customers SET status='WITHDRAWN' WHERE customer_seq=$1", [customer]);
    await errorCode(await readOrders('', aiReadHeaders(callId)), 403, 'FORBIDDEN');
    // The same organization does not grant access to another customer's orders.
    const organizationCall = await call('01000000003');
    await testMembership(pool, {
      customerSeq: suite.otherId,
      organizationSeq: suite.organizationId,
      employeeNo: 'read-other',
    });
    await errorCode(
      await readOrders(`?customerSeq=${suite.customerId}`, aiReadHeaders(organizationCall)),
      403,
      'FORBIDDEN',
    );
  });

  test('ORD-02 validates filters and call IDs while preserving administrator authentication', async () => {
    for (const query of [
      '?from=2026-10-28T00:00:00Z&to=2026-10-27T00:00:00Z',
      '?from=2026-10-27T00:00:00Z&to=2026-10-27T00:00:00Z',
      '?from=2026-10-27T00:00:00+99:00',
      '?customerSeq=1&customerSeq=2',
      '?limit=101',
      '?offset=-1',
      '?status=unknown',
      '?shipmentStatus=sent',
      '?recipientName=',
      '?unknown=1',
    ])
      await errorCode(await readOrders(query), 400, 'INVALID_REQUEST');
    for (const callId of [undefined, '', 'abc', '0', '-1', '2147483648', '1,2']) {
      await errorCode(
        await readOrders('', { Cookie: undefined, call_session_seq: callId }),
        400,
        'INVALID_REQUEST',
      );
    }
    await errorCode(await readOrders('', aiReadHeaders(2147483647)), 404, 'NOT_FOUND');
    const callId = await call('01000000001');
    await errorCode(
      await readOrders('', { ...aiReadHeaders(callId), Cookie: 'dva_session=expired' }),
      401,
      'UNAUTHORIZED',
    );
    for (let i = 0; i < 3; i++) assert.equal((await readOrders('', {}, i)).status, 200);
  });

  test('ORD-03 returns draft details, every nullable address field and the actual version without writes', async () => {
    const { customer } = await readCustomer();
    const id = await readOrder(customer, [
      { origin: { name: '수집한 이름', phoneNumber: '01000000001' }, itemPrice: 0 },
      { destination: address, itemPrice: Number.MAX_SAFE_INTEGER, documentCount: 2 },
      {},
    ]);
    const before = (
      await pool.query('SELECT version,updated_at FROM orders WHERE order_seq=$1', [id])
    ).rows[0];
    const response = await readDetail(id);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.match(body.meta.requestId, /^[0-9a-f-]{36}$/);
    const order = body.data;
    assert.equal(order.orderSeq, id);
    assert.equal(order.customerSeq, customer);
    assert.equal(order.status, 'COLLECTING');
    assert.equal(order.version, before.version);
    assert.equal(Date.parse(order.updatedAt), before.updated_at.getTime());
    assert.equal(order.parcelNo, null);
    assert.equal(order.dverReceivedAt, null);
    assert.equal(order.pickupRequestedAt, null);
    assert.deepEqual(
      order.parcels.map((p) => p.parcelPosition),
      [1, 2, 3],
    );
    const emptyAddress = Object.fromEntries(Object.keys(address).map((key) => [key, null]));
    assert.deepEqual(order.parcels[0].origin, {
      ...emptyAddress,
      name: '수집한 이름',
      phoneNumber: '01000000001',
    });
    assert.deepEqual(order.parcels[0].destination, emptyAddress);
    assert.deepEqual(order.parcels[1].destination, address);
    assert.equal(order.parcels[0].itemPrice, 0);
    assert.equal(order.parcels[1].itemPrice, Number.MAX_SAFE_INTEGER);
    assert.equal(order.parcels[2].itemPrice, null);
    for (const parcel of order.parcels) {
      assert.equal(parcel.orderSeq, id);
      assert.ok(Number.isInteger(parcel.orderParcelSeq));
      assert.equal(parcel.originPin, null);
      assert.equal(Object.hasOwn(parcel, 'shipment'), false);
      assert.equal(parcel.notifiedPrice, null);
    }
    assert.equal(order.creationRequestId, undefined);
    assert.equal(order.deliverySyncStatus, undefined);
    assert.equal(order.parcelCount, undefined);
    assert.equal(order.shipmentStatuses, undefined);
    assert.deepEqual(
      (await pool.query('SELECT version,updated_at FROM orders WHERE order_seq=$1', [id])).rows[0],
      before,
    );
    const empty = await readOrder(customer);
    assert.deepEqual((await (await readDetail(empty)).json()).data.parcels, []);
  });

  test('order detail returns order snapshots and status without exposing stored shipment data', async () => {
    const { customer } = await readCustomer();
    const pin = (
      await pool.query(
        'INSERT INTO personal_pins(customer_seq,address_data) VALUES($1,$2) RETURNING personal_pin_seq',
        [customer, address],
      )
    ).rows[0].personal_pin_seq;
    const id = await readOrder(customer, [
      {
        origin: address,
        originPin: { scope: 'PERSONAL', pinSeq: pin },
        destination: address,
        smallBoxCount: 1,
        itemPrice: 0,
      },
      { destination: { name: '두 번째 수령인' } },
    ]);
    await pool.query('UPDATE personal_pins SET address_data=$2 WHERE personal_pin_seq=$1', [
      pin,
      { ...address, roadAddress: '변경된 원본 주소' },
    ]);
    const parcel = (
      await pool.query(
        'SELECT order_parcel_seq FROM order_parcels WHERE order_seq=$1 ORDER BY parcel_position LIMIT 1',
        [id],
      )
    ).rows[0].order_parcel_seq;
    await pool.query(
      "UPDATE orders SET status='ACCEPTED',pickup_requested_at='2026-10-28T00:00:00Z',parcel_no='READ0058',dver_received_at='2026-10-27T00:00:00Z' WHERE order_seq=$1",
      [id],
    );
    const trackingNumber = randomUUID();
    await pool.query(
      "INSERT INTO shipments(order_parcel_seq,tracking_number,status,version,status_changed_at) VALUES($1,$2,'sent',3,'2026-10-27T01:00:00Z')",
      [parcel, trackingNumber],
    );
    const storedShipment = (
      await pool.query('SELECT * FROM shipments WHERE order_parcel_seq=$1', [parcel])
    ).rows[0];
    const order = (await (await readDetail(id)).json()).data;
    assert.equal(order.status, 'ACCEPTED');
    assert.equal(order.parcelNo, 'READ0058');
    assert.equal(Date.parse(order.dverReceivedAt), Date.parse('2026-10-27T00:00:00Z'));
    assert.deepEqual(order.parcels[0].origin, address);
    assert.deepEqual(order.parcels[0].originPin, { scope: 'PERSONAL', pinSeq: pin });
    assert.deepEqual(order.parcels[0].destination, address);
    assert.equal(order.parcels[0].smallBoxCount, 1);
    assert.equal(order.parcels[0].itemPrice, 0);
    for (const parcel of order.parcels) {
      assert.equal(Object.hasOwn(parcel, 'shipment'), false);
      assert.equal(Object.hasOwn(parcel, 'trackingNumber'), false);
      assert.equal(parcel.status, 'ACTIVE');
      assert.equal(Object.hasOwn(parcel, 'shipmentStatus'), false);
    }
    assert.equal(JSON.stringify(order).includes(trackingNumber), false);
    assert.deepEqual(
      (await pool.query('SELECT * FROM shipments WHERE order_parcel_seq=$1', [parcel])).rows[0],
      storedShipment,
    );
    for (let i = 0; i < 3; i++) assert.equal((await readDetail(id, {}, i)).status, 200);
  });

  test('ORD-03 scopes AI detail reads to the call customer and hides other or missing orders equally', async () => {
    const { customer, phone } = await readCustomer();
    const own = await readOrder(customer),
      other = await readOrder(suite.otherId);
    const callId = await call(phone);
    assert.equal((await readDetail(own, aiReadHeaders(callId))).status, 200);
    const forbidden = await readDetail(other, aiReadHeaders(callId));
    const missing = await readDetail(2147483647, aiReadHeaders(callId));
    assert.equal(forbidden.status, 404);
    assert.equal(missing.status, 404);
    assert.deepEqual((await forbidden.json()).error, (await missing.json()).error);
    await errorCode(await readDetail(own, aiReadHeaders(await call())), 403, 'FORBIDDEN');
    await errorCode(
      await readDetail(own, aiReadHeaders(await call(phone, true))),
      409,
      'INVALID_STATE',
    );
    await errorCode(
      await readDetail(own, { ...aiReadHeaders(callId), Cookie: 'dva_session=expired' }),
      401,
      'UNAUTHORIZED',
    );
    await errorCode(await readDetail(own, { Cookie: undefined }), 400, 'INVALID_REQUEST');
    await pool.query("UPDATE customers SET status='WITHDRAWN' WHERE customer_seq=$1", [customer]);
    await errorCode(await readDetail(own, aiReadHeaders(callId)), 403, 'FORBIDDEN');
    assert.equal((await readDetail(own)).status, 200);
    for (const bad of ['0', '-1', '2147483648', '1.5', '1e2', 'abc'])
      await errorCode(await readDetail(bad), 400, 'INVALID_REQUEST');
  });

  test('ORD-03 keeps order version and parcels in one snapshot during a concurrent edit', async () => {
    const { customer, phone } = await readCustomer();
    const id = await readOrder(customer, [{ origin: { name: '변경 전' } }]);
    const callId = await call(phone);
    const before = (await pool.query('SELECT version FROM orders WHERE order_seq=$1', [id])).rows[0]
      .version;
    const original = suite.repository.detail;
    suite.repository.detail = async function (...args) {
      await pool.query("UPDATE order_parcels SET origin_name='변경 후' WHERE order_seq=$1", [id]);
      return original.apply(this, args);
    };
    try {
      const response = await readDetail(id, aiReadHeaders(callId));
      assert.equal(response.status, 200);
      const order = (await response.json()).data;
      assert.equal(order.version, before);
      assert.equal(order.parcels[0].origin.name, '변경 전');
    } finally {
      suite.repository.detail = original;
    }
    const after = (await (await readDetail(id)).json()).data;
    assert.ok(after.version > before);
    assert.equal(after.parcels[0].origin.name, '변경 후');
  });
};
