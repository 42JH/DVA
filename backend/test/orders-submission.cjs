module.exports = function registerOrdersSubmission(suite) {
  const {
    test,
    resetDver,
    aiResult,
    randomUUID,
    aiCreate,
    assert,
    dverSuccess,
    submissionRows,
    pool,
    counts,
    readyOrder,
    address,
    submitOrder,
    storedOrder,
  } = suite;

  test('AI sends COMPLETE once to ORD-01 and receives the committed Dver result without submit', async () => {
    resetDver();
    const input = aiResult(),
      key = randomUUID();
    const response = await aiCreate(undefined, input, key);
    assert.equal(response.status, 201);
    const { data } = await response.json();
    assert.equal(data.status, 'ACCEPTED');
    assert.equal(data.parcelNo, dverSuccess.parcelNo);
    assert.ok(data.callSessionSeq > 0);
    assert.deepEqual(await submissionRows(data.orderSeq), {
      status: 'ACCEPTED',
      shipments: 1,
      history: 1,
      acceptedAudit: 1,
    });
    const stored = (
      await pool.query(
        'SELECT caller_phone_number,incoming_at,order_seq FROM call_sessions WHERE call_session_seq=$1',
        [data.callSessionSeq],
      )
    ).rows[0];
    assert.equal(stored.caller_phone_number, '01000000001');
    assert.equal(stored.incoming_at.toISOString(), input.call.incomingAt.replace('00Z', '00.000Z'));
    assert.equal(stored.order_seq, data.orderSeq);
    const events = (
      await pool.query(
        "SELECT action,actor_type,actor_seq,actor_name FROM audit_logs WHERE request_id=$1 AND result='SUCCESS' ORDER BY audit_log_seq",
        [response.headers.get('x-request-id')],
      )
    ).rows;
    assert.deepEqual(
      events.map((event) => event.action),
      [
        'CALL_STARTED',
        'ORDER_CREATED',
        'BILLING_MONTH_INITIALIZED',
        'BILLING_MONTH_INITIALIZED',
        'BILLING_AMOUNT_INCREASED',
        'ORDER_PAYMENT_COMPLETED',
        'ORDER_SUBMISSION_STARTED',
        'ORDER_SUBMISSION_ACCEPTED',
      ],
    );
    assert.ok(
      events
        .slice(0, 2)
        .every(
          (event) =>
            event.actor_type === 'AI' && event.actor_seq === null && event.actor_name === 'AI',
        ),
    );
    assert.ok(
      events.slice(2).every((event) => event.actor_type === 'SYSTEM' && event.actor_seq === null),
    );
    assert.deepEqual(
      (await (await aiCreate(undefined, { ...input, outcome: 'CANCELLED' }, key, 1)).json()).data,
      data,
    );
    assert.equal(suite.dverRequests.length, 1);
  });

  test('ORD-06 submits the existing order and atomically creates each shipment and initial history', async () => {
    resetDver();
    assert.equal(
      (
        await pool.query(
          "SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name IN ('submission_first_attempt_at','submission_last_attempt_at') AND udt_name='timestamptz' AND is_nullable='YES'",
        )
      ).rowCount,
      2,
    );
    const order = await readyOrder({
      parcels: [
        { origin: address, destination: address, smallBoxCount: 1, itemPrice: 1 },
        { origin: address, destination: address, otherItemDescription: '기타', itemPrice: 3000 },
      ],
    });
    const requestId = randomUUID(),
      before = await counts();
    const response = await submitOrder(order, { 'X-Request-Id': requestId });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: { status: 'ACCEPTED' }, meta: { requestId } });
    assert.equal(suite.dverRequests.length, 1);
    assert.equal(suite.dverRequests[0].headers['x-api-key'], 'test-only-dver-key');
    assert.equal(suite.dverRequests[0].body.outboundParcels.length, 2);
    assert.equal(suite.dverRequests[0].body.paymentMethodType, 'credit');
    assert.ok(suite.dverRequests[0].body.outboundParcels.every((p) => p.notifiedPrice === 3500));
    assert.equal((await counts()).orders, before.orders);
    assert.deepEqual(await submissionRows(order.orderSeq), {
      status: 'ACCEPTED',
      shipments: 2,
      history: 2,
      acceptedAudit: 1,
    });
    const detail = await storedOrder(order.orderSeq);
    assert.equal(detail.parcelNo, dverSuccess.parcelNo);
    assert.equal(Date.parse(detail.dverReceivedAt), Date.parse(dverSuccess.receivedAt));
    assert.equal(detail.status, 'ACCEPTED');
    assert.ok(detail.parcels.every((parcel) => !Object.hasOwn(parcel, 'shipment')));
    const shipments = (
      await pool.query(
        `SELECT s.status,s.version,s.tracking_number FROM shipments s
       JOIN order_parcels p USING(order_parcel_seq) WHERE p.order_seq=$1`,
        [order.orderSeq],
      )
    ).rows;
    assert.equal(new Set(shipments.map((shipment) => shipment.tracking_number)).size, 2);
    for (const shipment of shipments) {
      assert.equal(shipment.status, 'paid');
      assert.equal(shipment.version, 1);
      assert.match(shipment.tracking_number, /^DVA-[0-9a-f-]{36}$/);
    }
    await pool.query('UPDATE orders SET version=version+1 WHERE order_seq=$1', [order.orderSeq]);
    const retry = await submitOrder(order, {}, 1);
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).data.status, 'ACCEPTED');
    assert.equal(suite.dverRequests.length, 1);
    assert.equal((await submissionRows(order.orderSeq)).history, 2);
    assert.equal((await submitOrder(order)).status, 200);
  });
};
