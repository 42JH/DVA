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
    errorCode,
    readyOrder,
    address,
    call,
    readDetail,
    cancelOrder,
    patchOrder,
    aiReadHeaders,
    submitOrder,
    hosts,
    cookies,
    apps,
    OrderPaymentsService,
    storedOrder,
  } = suite;
  test('legacy stored item values remain readable but cannot create payment requests or shipments', async () => {
    resetDver();
    for (const itemPrice of [0, 100000001, 9000000000]) {
      const order = await readyOrder({ paymentMethodType: 'billing' });
      await pool.query('UPDATE order_parcels SET item_price=$2 WHERE order_seq=$1', [
        order.orderSeq,
        itemPrice,
      ]);
      const before = await storedOrder(order.orderSeq);
      const totals = await counts();
      assert.equal(before.parcels[0].itemPrice, itemPrice);
      const response = await submitOrder({ ...order, version: before.version });
      assert.equal(response.status, 422);
      const error = await response.json();
      assert.equal(error.error.code, 'VALIDATION_FAILED');
      assert.ok(
        error.error.details.some(
          (detail) => detail.field === 'parcels.0.itemPrice' && detail.reason === 'priceRange',
        ),
      );
      assert.deepEqual(await storedOrder(order.orderSeq), before);
      assert.deepEqual(await counts(), totals);
      assert.equal(
        (
          await pool.query('SELECT 1 FROM order_payment_requests WHERE order_seq=$1', [
            order.orderSeq,
          ])
        ).rowCount,
        0,
      );
      assert.equal(suite.dverRequests.length, 0);
    }
  });

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

  test('AI incomplete and cancelled calls survive without a known customer and never call Dver', async () => {
    resetDver();
    const beforeCustomers = (await counts()).customers;
    for (const outcome of ['INCOMPLETE', 'CANCELLED']) {
      const input = aiResult(outcome, {
        customerSeq: undefined,
        call: {
          providerCallId: randomUUID(),
          callerPhoneNumber: '01099118822',
          incomingAt: '2026-10-27T01:00:00Z',
        },
        parcels: [{ origin: { roadAddress: '수집된 주소' } }],
      });
      const key = randomUUID();
      const response = await aiCreate(undefined, input, key);
      assert.equal(response.status, 201);
      const { data } = await response.json();
      assert.equal(data.status, outcome === 'INCOMPLETE' ? 'COLLECTING' : 'CANCELLED');
      assert.equal(data.parcelNo, null);
      assert.equal(data.totalAmount, outcome === 'CANCELLED' ? 0 : input.totalAmount);
      if (outcome === 'CANCELLED') {
        const event = (
          await pool.query(
            "SELECT actor_type,metadata FROM audit_logs WHERE target_seq=$1 AND action='ORDER_CANCELLED'",
            [data.orderSeq],
          )
        ).rows[0];
        assert.equal(event.actor_type, 'AI');
        assert.deepEqual(event.metadata, { amountBefore: input.totalAmount, amountAfter: 0 });
        assert.equal(
          (
            await pool.query('SELECT notified_price FROM order_parcels WHERE order_seq=$1', [
              data.orderSeq,
            ])
          ).rows[0].notified_price,
          input.parcels[0].notifiedPrice,
        );
      }
      const stored = (
        await pool.query('SELECT customer_seq FROM orders WHERE order_seq=$1', [data.orderSeq])
      ).rows[0];
      assert.equal(stored.customer_seq, null);
      assert.deepEqual((await (await aiCreate(undefined, input, key)).json()).data, data);
    }
    assert.equal((await counts()).customers, beforeCustomers);
    assert.equal(suite.dverRequests.length, 0);
  });

  test('AI COMPLETE validation rolls back call, customer and order before any Dver request', async () => {
    resetDver();
    const before = await counts();
    const input = aiResult('COMPLETE', {
      customerSeq: undefined,
      customer: { name: '검증 실패', phoneNumber: '01088990011' },
      parcels: [],
      totalAmount: 3500,
    });
    input.call.callerPhoneNumber = input.customer.phoneNumber;
    await errorCode(await aiCreate(undefined, input), 422, 'VALIDATION_FAILED');
    assert.deepEqual(await counts(), before);
    assert.equal(
      (
        await pool.query('SELECT 1 FROM call_sessions WHERE provider_call_id=$1', [
          input.call.providerCallId,
        ])
      ).rowCount,
      0,
    );
    assert.equal(suite.dverRequests.length, 0);
  });

  test('AI result identity cannot change phone or event timestamp; another key cannot duplicate the call order', async () => {
    const input = aiResult('INCOMPLETE'),
      key = randomUUID();
    assert.equal((await aiCreate(undefined, input, key)).status, 201);
    for (const callChange of [
      { incomingAt: '2026-10-27T01:00:01Z' },
      { callerPhoneNumber: '01011112222' },
    ])
      await errorCode(
        await aiCreate(undefined, { ...input, call: { ...input.call, ...callChange } }, key),
        409,
        'INVALID_STATE',
      );
    await errorCode(await aiCreate(undefined, input), 409, 'INVALID_STATE');
  });

  test('AI COMPLETE retries while Dver is running return SUBMITTING across application instances', async () => {
    resetDver();
    let received;
    const arrived = new Promise((resolve) => {
      received = resolve;
    });
    let finish;
    suite.dverRespond = (_req, res) => {
      finish = () => res.end(JSON.stringify(dverSuccess));
      received();
    };
    const input = aiResult(),
      key = randomUUID();
    const first = aiCreate(undefined, input, key);
    await arrived;
    try {
      const replay = await aiCreate(undefined, input, key, 1);
      assert.equal(replay.status, 202);
      assert.equal((await replay.json()).data.status, 'SUBMITTING');
      assert.equal(suite.dverRequests.length, 1);
    } finally {
      finish();
    }
    assert.equal((await (await first).json()).data.status, 'ACCEPTED');
  });

  test('AI COMPLETE reports upstream rejection or uncertainty and never resends on retry', async () => {
    for (const status of [403, 500]) {
      resetDver();
      suite.dverRespond = (_req, res) => {
        res.writeHead(status);
        res.end('{}');
      };
      const input = aiResult(),
        key = randomUUID();
      const response = await aiCreate(undefined, input, key);
      const { data } = await response.json();
      assert.equal(data.status, 'SUBMITTING_FAILED');
      assert.equal((await submissionRows(data.orderSeq)).shipments, 0);
      assert.deepEqual((await (await aiCreate(undefined, input, key)).json()).data, data);
      assert.equal(suite.dverRequests.length, 1);
    }
  });

  test('AI cannot edit cancelled draft details or sent to Dver, and only remaining details get shipments', async () => {
    resetDver();
    const order = await readyOrder({
      parcels: [{}, { origin: address, destination: address, smallBoxCount: 1, itemPrice: 1 }],
    });
    const callId = await call('01000000003');
    const before = (await (await readDetail(order.orderSeq)).json()).data;
    const [cancelled, active] = before.parcels;
    // A deleted/obsolete PIN on a cancelled snapshot must not block the remaining parcel.
    await pool.query(
      "UPDATE order_parcels SET origin_pin_scope='PERSONAL',origin_pin_seq=2147483647 WHERE order_parcel_seq=$1",
      [cancelled.orderParcelSeq],
    );
    assert.equal((await cancelOrder(order.orderSeq, [cancelled.orderParcelSeq])).status, 204);
    const partial = (await (await readDetail(order.orderSeq)).json()).data;
    assert.equal(partial.status, 'COLLECTING');
    assert.deepEqual(
      partial.parcels.map((p) => p.status),
      ['CANCELLED', 'ACTIVE'],
    );
    await errorCode(
      await patchOrder(
        order.orderSeq,
        {
          expectedVersion: partial.version,
          paymentMethodType: 'billing',
          parcels: [
            { orderParcelSeq: active.orderParcelSeq, clientComment: 'must roll back' },
            { orderParcelSeq: cancelled.orderParcelSeq, clientComment: 'must reject' },
          ],
        },
        aiReadHeaders(callId),
      ),
      409,
      'INVALID_STATE',
    );
    assert.deepEqual((await (await readDetail(order.orderSeq)).json()).data, partial);
    await errorCode(await submitOrder(order), 409, 'VERSION_CONFLICT');
    assert.equal(suite.dverRequests.length, 0);
    assert.equal((await submitOrder({ ...order, version: partial.version })).status, 200);
    assert.equal(suite.dverRequests.length, 1);
    assert.equal(suite.dverRequests[0].body.outboundParcels.length, 1);
    assert.equal(suite.dverRequests[0].body.outboundParcels[0].item.smallBox, 1);
    assert.deepEqual(await submissionRows(order.orderSeq), {
      status: 'ACCEPTED',
      shipments: 1,
      history: 1,
      acceptedAudit: 1,
    });
    assert.equal(
      (
        await pool.query('SELECT 1 FROM shipments WHERE order_parcel_seq=$1', [
          cancelled.orderParcelSeq,
        ])
      ).rowCount,
      0,
    );
    const accepted = (await (await readDetail(order.orderSeq)).json()).data;
    assert.deepEqual(
      accepted.parcels.map((p) => p.status),
      ['CANCELLED', 'ACTIVE'],
    );
    const history = await fetch(
      hosts[0] + `/api/customers/${suite.otherId}/addresses?direction=DESTINATION&limit=100`,
      { headers: { Cookie: cookies[0] } },
    );
    const historical = (await history.json()).data.filter((p) => p.orderSeq === order.orderSeq);
    assert.deepEqual(
      historical.map((p) => p.orderParcelSeq),
      [active.orderParcelSeq],
    );
  });

  test('cancelled accepted snapshots stay out of previous address suggestions while siblings remain', async () => {
    resetDver();
    const parcel = { origin: address, destination: address, smallBoxCount: 1, itemPrice: 1 };
    const order = await readyOrder({ paymentMethodType: 'billing', parcels: [parcel, parcel] });
    assert.equal((await submitOrder(order)).status, 200);
    const detail = (await (await readDetail(order.orderSeq)).json()).data;
    assert.equal(
      (await cancelOrder(order.orderSeq, [detail.parcels[0].orderParcelSeq])).status,
      204,
    );
    const remaining = (await (await readDetail(order.orderSeq)).json()).data;
    const payments = apps[0].get(OrderPaymentsService);
    const paymentKey = 'verified-' + randomUUID();
    await payments.claimApproval(
      remaining.paymentRequest.paymentRequestId,
      remaining.totalAmount,
      paymentKey,
    );
    await payments.confirmPayment(
      remaining.paymentRequest.paymentRequestId,
      remaining.totalAmount,
      paymentKey,
      randomUUID(),
    );
    assert.equal((await submissionRows(order.orderSeq)).status, 'ACCEPTED');
    const history = await fetch(
      hosts[0] + `/api/customers/${suite.otherId}/addresses?direction=DESTINATION&limit=100`,
      { headers: { Cookie: cookies[0] } },
    );
    assert.deepEqual(
      (await history.json()).data
        .filter((p) => p.orderSeq === order.orderSeq)
        .map((p) => p.orderParcelSeq),
      [detail.parcels[1].orderParcelSeq],
    );
    await errorCode(await cancelOrder(order.orderSeq), 409, 'INVALID_STATE');
    assert.equal(suite.dverRequests.length, 1, 'cancellation must not contact Dver');
  });

  test('whole and individual cancellation reject SUBMITTING while Dver is in flight', async () => {
    resetDver();
    let received, finish;
    const arrived = new Promise((resolve) => {
      received = resolve;
    });
    suite.dverRespond = (_req, res) => {
      finish = () => res.end(JSON.stringify(dverSuccess));
      received();
    };
    const order = await readyOrder();
    const detail = (await (await readDetail(order.orderSeq)).json()).data;
    const pending = submitOrder(order);
    await arrived;
    try {
      await errorCode(await cancelOrder(order.orderSeq, undefined, 1), 409, 'INVALID_STATE');
      await errorCode(
        await cancelOrder(order.orderSeq, [detail.parcels[0].orderParcelSeq], 2),
        409,
        'INVALID_STATE',
      );
    } finally {
      finish();
    }
    assert.equal((await pending).status, 200);
    assert.equal((await submissionRows(order.orderSeq)).status, 'ACCEPTED');
    assert.equal(suite.dverRequests.length, 1);
  });

  test('AI CANCELLED consultation creates cancelled details and stays separate from cancelling an existing order', async () => {
    resetDver();
    const result = await aiCreate(undefined, aiResult('CANCELLED', { parcels: [{}] }));
    assert.equal(result.status, 201);
    const { data } = await result.json();
    const detail = (await (await readDetail(data.orderSeq)).json()).data;
    assert.equal(detail.status, 'CANCELLED');
    assert.equal(detail.parcels[0].status, 'CANCELLED');
    assert.equal(suite.dverRequests.length, 0);
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

  test('submission still rejects existing shipments after removing them from order detail', async () => {
    resetDver();
    const order = await readyOrder();
    await pool.query(
      `INSERT INTO shipments(order_parcel_seq,tracking_number)
     SELECT order_parcel_seq,$2 FROM order_parcels WHERE order_seq=$1`,
      [order.orderSeq, randomUUID()],
    );
    const before = await storedOrder(order.orderSeq);
    assert.ok(before.parcels.every((parcel) => !Object.hasOwn(parcel, 'shipment')));
    await errorCode(await submitOrder(order), 409, 'INVALID_STATE');
    assert.equal(suite.dverRequests.length, 0);
    assert.deepEqual(await storedOrder(order.orderSeq), before);
    assert.deepEqual(await submissionRows(order.orderSeq), {
      status: 'COLLECTING',
      shipments: 1,
      history: 0,
      acceptedAudit: 0,
    });
  });
};
