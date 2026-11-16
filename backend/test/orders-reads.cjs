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
  test('concurrent order reads keep customer filters and AI authorization separate', async () => {
    const first = await readCustomer();
    const second = await readCustomer();
    const own = await readOrder(first.customer, []);
    const other = await readOrder(second.customer, []);
    const ownQuery = `?customerSeq=${first.customer}`;
    const otherQuery = `?customerSeq=${second.customer}`;
    const callId = await call(first.phone);
    const [admin, duplicate, separate, forbidden, malformed] = await Promise.all([
      readOrders(ownQuery),
      readOrders(ownQuery),
      readOrders(otherQuery),
      readOrders(otherQuery, aiReadHeaders(callId)),
      readOrders(ownQuery, { call_session_seq: 'invalid' }),
    ]);
    for (const response of [admin, duplicate, separate]) assert.equal(response.status, 200);
    const body = await admin.json();
    assert.deepEqual(await duplicate.json(), body);
    assert.deepEqual(
      body.data.map((order) => order.orderSeq),
      [own],
    );
    assert.deepEqual(
      (await separate.json()).data.map((order) => order.orderSeq),
      [other],
    );
    await errorCode(forbidden, 403, 'FORBIDDEN');
    await errorCode(malformed, 400, 'INVALID_REQUEST');
    await readOrder(first.customer, []);
    assert.equal((await (await readOrders(ownQuery)).json()).total_count, 2);
  });

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

  test('ORD-03 returns draft details, every nullable address field and the actual version without writes', async () => {
    const { customer } = await readCustomer();
    const id = await readOrder(customer, [
      { origin: { name: '수집한 이름', phoneNumber: '01000000001' }, itemPrice: 1 },
      { destination: address, itemPrice: 100000000, documentCount: 2 },
      {},
    ]);
    // Past stored values remain readable even when new requests no longer accept them.
    await pool.query(
      'UPDATE order_parcels SET item_price=CASE parcel_position WHEN 1 THEN 0 ELSE 9007199254740991 END WHERE order_seq=$1 AND parcel_position IN (1,2)',
      [id],
    );
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
    await errorCode(await readDetail(own, aiReadHeaders(undefined)), 400, 'INVALID_REQUEST');
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
