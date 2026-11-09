module.exports = function registerOrdersCreation(suite) {
  const {
    test,
    address,
    call,
    aiCreate,
    assert,
    pool,
    counts,
    errorCode,
    randomUUID,
    apps,
    AuditService,
    create,
  } = suite;
  test('AI uses the same ORD-01 for partial and complete data, with one linked order and no shipment', async () => {
    for (const parcels of [
      [{ origin: { name: '수집 중' } }],
      [{ origin: address, destination: address, smallBoxCount: 1, itemPrice: 1 }],
    ]) {
      const callId = await call('01000000001');
      const response = await aiCreate(callId, {
        customerSeq: suite.customerId,
        pickupRequestedAt: '2026-10-28T10:00:00+09:00',
        parcels,
      });
      assert.equal(response.status, 201);
      const { data } = await response.json();
      const stored = (
        await pool.query(
          'SELECT o.status,o.customer_seq,o.version,c.order_seq FROM orders o JOIN call_sessions c ON c.order_seq=o.order_seq WHERE c.call_session_seq=$1',
          [callId],
        )
      ).rows[0];
      assert.deepEqual(stored, {
        status: 'COLLECTING',
        customer_seq: suite.customerId,
        version: data.version,
        order_seq: data.orderSeq,
      });
      assert.equal(
        (
          await pool.query(
            'SELECT count(*) FROM shipments s JOIN order_parcels p USING(order_parcel_seq) WHERE p.order_seq=$1',
            [data.orderSeq],
          )
        ).rows[0].count,
        '0',
      );
      const audit = (
        await pool.query(
          "SELECT actor_seq FROM audit_logs WHERE action='ORDER_CREATED' AND target_seq=$1 AND result='SUCCESS'",
          [data.orderSeq],
        )
      ).rows;
      assert.deepEqual(audit, [{ actor_seq: null }]);
    }
  });

  test('AI requires a real open call and never trusts arbitrary customer or administrator headers', async () => {
    const before = await counts(),
      body = { customerSeq: suite.customerId };
    for (const id of [undefined, 0, 'bad', '1.5', 2147483648])
      await errorCode(await aiCreate(id, body), 400, 'INVALID_REQUEST');
    await errorCode(await aiCreate(2147483647, body), 404, 'NOT_FOUND');
    await errorCode(await aiCreate(await call(null, true), body), 409, 'INVALID_STATE');
    await errorCode(
      await aiCreate(await call('01099999999'), body, randomUUID(), 0, {
        'X-Admin-User-Seq': String(suite.adminId),
      }),
      403,
      'FORBIDDEN',
    );
    assert.deepEqual(await counts(), before);
  });

  test('call replay returns the first response after termination; a new key cannot create another order', async () => {
    const callId = await call(),
      key = randomUUID(),
      body = { customerSeq: suite.customerId };
    const first = await aiCreate(callId, body, key);
    assert.equal(first.status, 201);
    const { data } = await first.json();
    await pool.query(
      "UPDATE call_sessions SET started_at='2026-10-27T00:00:00Z',ended_at='2026-10-27T00:01:00Z' WHERE call_session_seq=$1",
      [callId],
    );
    const replay = await aiCreate(callId, body, key, 1);
    assert.equal(replay.status, 201);
    assert.deepEqual((await replay.json()).data, data);
    await errorCode(await aiCreate(callId, body), 409, 'INVALID_STATE');
    const unchanged = await aiCreate(callId, { ...body, paymentMethodType: 'billing' }, key);
    assert.equal(unchanged.status, 201);
    assert.deepEqual((await unchanged.json()).data, data);
    assert.equal(
      (
        await pool.query('SELECT payment_method_type FROM orders WHERE order_seq=$1', [
          data.orderSeq,
        ])
      ).rows[0].payment_method_type,
      null,
    );
    assert.equal(
      (await pool.query('SELECT status FROM orders WHERE order_seq=$1', [data.orderSeq])).rows[0]
        .status,
      'COLLECTING',
    );
  });

  test('AI call linkage, new customer, order and creation key roll back together on audit failure', async () => {
    const callId = await call('01000559999'),
      key = randomUUID();
    const body = { customer: { name: 'AI 신규 고객', phoneNumber: '01000559999' }, parcels: [{}] };
    const audit = apps[0].get(AuditService),
      original = audit.recordSuccess,
      before = await counts();
    audit.recordSuccess = async (event, client) => {
      if (event.action === 'ORDER_CREATED') throw Error('rollback-test');
      return original.call(audit, event, client);
    };
    try {
      assert.equal((await aiCreate(callId, body, key)).status, 500);
      assert.deepEqual(await counts(), before);
      assert.equal(
        (
          await pool.query('SELECT order_seq FROM call_sessions WHERE call_session_seq=$1', [
            callId,
          ])
        ).rows[0].order_seq,
        null,
      );
    } finally {
      audit.recordSuccess = original;
    }
    assert.equal((await aiCreate(callId, body, key)).status, 201);
  });

  test('all active administrator roles create COLLECTING orders with defaults and no shipments', async () => {
    const before = await counts();
    for (let index = 0; index < 3; index++) {
      const response = await create(undefined, undefined, index);
      assert.equal(response.status, 201);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const { data, meta } = await response.json();
      assert.deepEqual(Object.keys(data).sort(), ['orderSeq', 'version']);
      assert.equal(meta.requestId, response.headers.get('x-request-id'));
      const row = (
        await pool.query(
          'SELECT customer_seq,payment_method_type,pickup_requested_at,status,version,parcel_no,dver_received_at FROM orders WHERE order_seq=$1',
          [data.orderSeq],
        )
      ).rows[0];
      assert.deepEqual(row, {
        customer_seq: suite.customerId,
        payment_method_type: null,
        pickup_requested_at: null,
        status: 'COLLECTING',
        version: 1,
        parcel_no: null,
        dver_received_at: null,
      });
      assert.equal(data.version, row.version);
    }
    assert.equal((await counts()).shipments, before.shipments);
  });

  require('./orders-migrations.cjs').paymentMethod(suite);
};
