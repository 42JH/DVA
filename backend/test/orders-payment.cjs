module.exports = function registerOrdersPayment(suite) {
  const {
    test,
    resetDver,
    readCustomer,
    readyOrder,
    submitOrder,
    assert,
    submissionRows,
    pool,
    errorCode,
    patchOrder,
    call,
    aiReadHeaders,
    dverSuccess,
    apps,
    ConfigService,
    AuditService,
  } = suite;
  test('ORD-06 payment eligibility uses active enterprise membership and allows credit for both kinds', async () => {
    resetDver();
    const { customer: personalCustomer } = await readCustomer();
    for (const [customerSeq, paymentMethodType, expected] of [
      [suite.customerId, 'credit', 200],
      [personalCustomer, 'credit', 200],
      [suite.customerId, 'groupBilling', 200],
      [personalCustomer, 'billing', 200],
      [suite.customerId, 'billing', 200],
      [personalCustomer, 'groupBilling', 403],
    ]) {
      const order = await readyOrder({ customerSeq, paymentMethodType }),
        before = suite.dverRequests.length;
      const response = await submitOrder(order);
      assert.equal(response.status, expected, `${customerSeq} ${paymentMethodType}`);
      if (expected === 200) {
        assert.equal(
          (await response.json()).data.status,
          paymentMethodType === 'billing' ? 'notPaid' : 'ACCEPTED',
        );
        if (paymentMethodType === 'billing') assert.equal(suite.dverRequests.length, before);
        else assert.equal(suite.dverRequests.at(-1).body.paymentMethodType, paymentMethodType);
      } else {
        assert.equal((await response.json()).error.code, 'FORBIDDEN');
        assert.equal(suite.dverRequests.length, before);
        assert.equal((await submissionRows(order.orderSeq)).status, 'COLLECTING');
      }
    }
    for (const [table, column, id] of [
      ['memberships', 'customer_seq', suite.customerId],
      ['organizations', 'organization_seq', suite.organizationId],
    ]) {
      const order = await readyOrder({
          customerSeq: suite.customerId,
          paymentMethodType: 'groupBilling',
        }),
        before = suite.dverRequests.length;
      await pool.query(`UPDATE ${table} SET status='INACTIVE' WHERE ${column}=$1`, [id]);
      try {
        await errorCode(await submitOrder(order), 403, 'FORBIDDEN');
      } finally {
        await pool.query(`UPDATE ${table} SET status='ACTIVE' WHERE ${column}=$1`, [id]);
      }
      assert.equal(suite.dverRequests.length, before);
    }
  });

  test('ORD-06 AI requires matching phone and active call; an ended call can replay its bound order', async () => {
    resetDver();
    const { customer, phone } = await readCustomer();
    const order = await readyOrder({ customerSeq: customer });
    for (const callId of [await call(), await call('01099990000')])
      await errorCode(await submitOrder(order, aiReadHeaders(callId)), 403, 'FORBIDDEN');
    const ended = await call(phone, true);
    await pool.query('UPDATE call_sessions SET order_seq=$2 WHERE call_session_seq=$1', [
      ended,
      order.orderSeq,
    ]);
    await errorCode(await submitOrder(order, aiReadHeaders(ended)), 409, 'INVALID_STATE');
    const callId = await call(phone);
    assert.equal((await submitOrder(order, aiReadHeaders(callId))).status, 200);
    assert.equal(
      (await pool.query('SELECT order_seq FROM call_sessions WHERE call_session_seq=$1', [callId]))
        .rows[0].order_seq,
      order.orderSeq,
    );
    await pool.query(
      'UPDATE call_sessions SET started_at=now(),ended_at=now() WHERE call_session_seq=$1',
      [callId],
    );
    assert.equal((await submitOrder(order, aiReadHeaders(callId), 1)).status, 200);
    assert.equal(suite.dverRequests.length, 1);
    assert.equal((await submitOrder(order, aiReadHeaders(callId))).status, 200);
    const unboundEnded = await call(phone, true);
    await errorCode(await submitOrder(order, aiReadHeaders(unboundEnded)), 409, 'INVALID_STATE');
    await errorCode(
      await submitOrder(order, aiReadHeaders(await call('01099990000'))),
      403,
      'FORBIDDEN',
    );
  });

  test('ORD-06 commits SUBMITTING and releases locks before HTTP; concurrent retries only return status', async () => {
    resetDver();
    const requested = new Date(Date.now() + 86400000).toISOString();
    const order = await readyOrder({ pickupRequestedAt: requested });
    let release, received;
    const arrived = new Promise((resolve) => {
      received = resolve;
    });
    suite.dverRespond = (_req, res) => {
      release = () => res.end(JSON.stringify(dverSuccess));
      received();
    };
    const first = submitOrder(order);
    try {
      await Promise.race([
        arrived,
        first.then((response) => {
          throw Error(`Request ended before external call: ${response.status}`);
        }),
      ]);
      const locked = await pool.connect();
      try {
        await locked.query('BEGIN');
        const row = (
          await locked.query(
            'SELECT status,version,pickup_requested_at FROM orders WHERE order_seq=$1 FOR UPDATE NOWAIT',
            [order.orderSeq],
          )
        ).rows[0];
        assert.equal(row.status, 'SUBMITTING');
        assert.equal(row.version, order.version); // Payment preserves the future pickup time.
        assert.equal(row.pickup_requested_at.toISOString(), requested);
      } finally {
        await locked.query('ROLLBACK');
        locked.release();
      }
      const retry = await submitOrder(order, {}, 1);
      assert.equal(retry.status, 202);
      assert.equal(retry.headers.get('location'), `/api/orders/${order.orderSeq}`);
      assert.equal((await retry.json()).data.status, 'SUBMITTING');
      assert.equal((await submitOrder(order, {}, 2)).status, 202);
      await errorCode(
        await patchOrder(
          order.orderSeq,
          { expectedVersion: order.version, paymentMethodType: 'credit' },
          aiReadHeaders(await call('01000000003')),
        ),
        409,
        'INVALID_STATE',
      );
      assert.equal(suite.dverRequests.length, 1);
    } finally {
      release?.();
      await first;
    }
    assert.equal((await submissionRows(order.orderSeq)).status, 'ACCEPTED');
  });

  test('ORD-06 configuration failure prevents payment; dispatch audit failure preserves paid order for recovery', async () => {
    resetDver();
    const { customer, phone } = await readCustomer();
    const order = await readyOrder({ customerSeq: customer }),
      callId = await call(phone);
    const config = apps[0].get(ConfigService),
      audit = apps[0].get(AuditService);
    config.set('DVER_API_KEY', '');
    try {
      await errorCode(await submitOrder(order), 503, 'DEPENDENCY_UNAVAILABLE');
    } finally {
      config.set('DVER_API_KEY', 'test-only-dver-key');
    }
    const original = audit.recordSuccess;
    audit.recordSuccess = async function (...args) {
      await original.apply(this, args);
      if (args[0].action === 'ORDER_SUBMISSION_STARTED') throw Error('submit-prepare-rollback');
    };
    try {
      assert.equal((await submitOrder(order, aiReadHeaders(callId))).status, 500);
    } finally {
      audit.recordSuccess = original;
    }
    assert.deepEqual(await submissionRows(order.orderSeq), {
      status: 'PAID',
      shipments: 0,
      history: 0,
      acceptedAudit: 0,
    });
    assert.equal(
      (await pool.query('SELECT order_seq FROM call_sessions WHERE call_session_seq=$1', [callId]))
        .rows[0].order_seq,
      order.orderSeq,
    );
    assert.equal(suite.dverRequests.length, 0);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM audit_logs WHERE target_seq=$1 AND action='ORDER_PAYMENT_COMPLETED'",
          [order.orderSeq],
        )
      ).rows[0].n,
      1,
    );
    assert.equal((await submitOrder(order)).status, 200);
    assert.equal((await submissionRows(order.orderSeq)).status, 'ACCEPTED');
    assert.equal(suite.dverRequests.length, 1);
  });
};
