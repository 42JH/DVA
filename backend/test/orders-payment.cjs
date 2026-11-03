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
    storedOrder,
    address,
    patchOrder,
    call,
    aiReadHeaders,
    randomUUID,
    dverSuccess,
    apps,
    OrdersRepository,
    ConfigService,
    AuditService,
    NestFactory,
    AppModule,
    configureApplication,
    origin,
    cookies,
    waitForBlockedBy,
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

  test('ORD-06 checks saved completeness, legacy cat, active customer and PIN; validation failures preserve the collecting order', async () => {
    resetDver();
    const partial = await readyOrder({ pickupRequestedAt: null, parcels: [{}] });
    const response = await submitOrder(partial);
    assert.equal(response.status, 422);
    const failure = (await response.json()).error;
    assert.equal(failure.code, 'VALIDATION_FAILED');
    assert.ok(failure.details.some((x) => x.field === 'parcels.0.origin.name'));
    assert.equal((await submissionRows(partial.orderSeq)).status, 'COLLECTING');
    const legacy = await readyOrder();
    await pool.query("UPDATE orders SET payment_method_type='cat' WHERE order_seq=$1", [
      legacy.orderSeq,
    ]);
    legacy.version = (await storedOrder(legacy.orderSeq)).version;
    await errorCode(await submitOrder(legacy), 422, 'VALIDATION_FAILED');
    const withdrawn = await readyOrder();
    await pool.query("UPDATE customers SET status='WITHDRAWN' WHERE customer_seq=$1", [
      suite.otherId,
    ]);
    try {
      await errorCode(await submitOrder(withdrawn), 403, 'FORBIDDEN');
    } finally {
      await pool.query("UPDATE customers SET status='ACTIVE' WHERE customer_seq=$1", [
        suite.otherId,
      ]);
    }
    const pin = await readyOrder({
      customerSeq: suite.customerId,
      parcels: [
        {
          origin: address,
          destination: address,
          smallBoxCount: 1,
          itemPrice: 0,
          originPin: { scope: 'COMPANY', pinSeq: suite.companyPin },
        },
      ],
    });
    await pool.query("UPDATE memberships SET status='INACTIVE' WHERE customer_seq=$1", [
      suite.customerId,
    ]);
    try {
      await errorCode(await submitOrder(pin), 403, 'FORBIDDEN');
    } finally {
      await pool.query("UPDATE memberships SET status='ACTIVE' WHERE customer_seq=$1", [
        suite.customerId,
      ]);
    }
    assert.equal(suite.dverRequests.length, 0);
    const patched = await patchOrder(partial.orderSeq, {
      expectedVersion: partial.version,
      pickupRequestedAt: new Date(Date.now() + 86400000).toISOString(),
      parcels: [
        {
          orderParcelSeq: (await storedOrder(partial.orderSeq)).parcels[0].orderParcelSeq,
          origin: address,
          destination: address,
          smallBoxCount: 1,
          itemPrice: 0,
        },
      ],
    });
    assert.equal(patched.status, 200);
    partial.version = (await patched.json()).data.version;
    assert.equal((await submitOrder(partial)).status, 200);
  });

  test('ORD-06 rejects invalid path/body and keeps session and Origin checks', async () => {
    resetDver();
    const order = await readyOrder();
    for (const body of [
      {},
      { expectedVersion: '1' },
      { expectedVersion: 0 },
      { expectedVersion: 1.5 },
      { expectedVersion: 2147483648 },
      { expectedVersion: order.version, confirmed: true },
      { expectedVersion: order.version, parcels: [] },
    ])
      await errorCode(await submitOrder(order, {}, 0, body), 400, 'INVALID_REQUEST');
    await errorCode(await submitOrder({ ...order, orderSeq: 0 }), 400, 'INVALID_REQUEST');
    await errorCode(await submitOrder({ ...order, orderSeq: 2147483647 }), 404, 'NOT_FOUND');
    await errorCode(
      await submitOrder({ ...order, version: order.version + 1 }),
      409,
      'VERSION_CONFLICT',
    );
    await errorCode(
      await submitOrder(order, { Origin: 'https://untrusted.invalid' }),
      403,
      'FORBIDDEN',
    );
    await errorCode(
      await submitOrder(order, { Cookie: 'dva_session=broken' }),
      401,
      'UNAUTHORIZED',
    );
    await errorCode(
      await submitOrder(order, { Cookie: undefined, Origin: undefined }),
      400,
      'INVALID_REQUEST',
    );
    assert.equal(suite.dverRequests.length, 0);
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

  test('ORD-06 uses the order identity, ignores obsolete keys and rejects cancelled or expired orders', async () => {
    resetDver();
    const first = await readyOrder(),
      second = await readyOrder();
    const headers = { 'Idempotency-Key': randomUUID() };
    assert.equal((await submitOrder(first, headers)).status, 200);
    assert.equal((await submitOrder(second, headers)).status, 200);
    const replay = await submitOrder({ ...first, version: first.version + 1 });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).data.status, 'ACCEPTED');
    for (const status of ['CANCELLED']) {
      const order = await readyOrder();
      await pool.query('UPDATE orders SET status=$2 WHERE order_seq=$1', [order.orderSeq, status]);
      await errorCode(await submitOrder(order), 409, 'INVALID_STATE');
    }
    assert.equal(suite.dverRequests.length, 2);
  });

  test('ORD-06 commits SUBMITTING and releases locks before HTTP; concurrent retries only return status', async () => {
    resetDver();
    const order = await readyOrder();
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
            'SELECT status,version FROM orders WHERE order_seq=$1 FOR UPDATE NOWAIT',
            [order.orderSeq],
          )
        ).rows[0];
        assert.equal(row.status, 'SUBMITTING');
        assert.equal(row.version, order.version + 1); // Payment fixes the pickup time.
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

  test('ORD-06 serializes concurrent preparation on the existing order row', async () => {
    resetDver();
    const order = await readyOrder();
    const originalStart = suite.submissionRepository.start;
    const secondRepository = apps[1].get(OrdersRepository);
    const originalLock = secondRepository.lockOrder;
    let release, entered, attempted;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const preparing = new Promise((resolve) => {
      entered = resolve;
    });
    const competing = new Promise((resolve) => {
      attempted = resolve;
    });
    suite.submissionRepository.start = async function (...args) {
      const result = await originalStart.apply(this, args);
      entered();
      await gate;
      return result;
    };
    secondRepository.lockOrder = function (...args) {
      const result = originalLock.apply(this, args);
      attempted();
      return result;
    };
    const first = submitOrder(order);
    let second;
    try {
      await Promise.race([
        preparing,
        first.then((r) => {
          throw Error(`Preparation failed: ${r.status}`);
        }),
      ]);
      second = submitOrder(order, {}, 1);
      await Promise.race([
        competing,
        second.then((r) => {
          throw Error(`Competing request failed: ${r.status}`);
        }),
      ]);
      assert.equal(suite.dverRequests.length, 0);
    } finally {
      release();
      suite.submissionRepository.start = originalStart;
      secondRepository.lockOrder = originalLock;
    }
    assert.equal((await first).status, 200);
    const replay = await second;
    assert.ok([200, 202].includes(replay.status));
    assert.ok(['ACCEPTED', 'SUBMITTING'].includes((await replay.json()).data.status));
    assert.equal((await submitOrder(order, {}, 2)).status, 200);
    assert.equal(suite.dverRequests.length, 1);
  });

  test('ORD-06 records auth failures and unknown outcomes without shipments or a second external request', async () => {
    for (const mode of ['auth', 'error', 'invalid', 'disconnect']) {
      resetDver();
      const order = await readyOrder();
      suite.dverRespond = (req, res) => {
        if (mode === 'disconnect') return req.socket.destroy();
        res.statusCode = mode === 'auth' ? 403 : mode === 'error' ? 500 : 200;
        res.end(mode === 'auth' ? 'Authorization data is wrong!' : '{}');
      };
      const response = await submitOrder(order);
      assert.equal(response.status, 200);
      const status = 'SUBMITTING_FAILED';
      assert.equal((await response.json()).data.status, status);
      assert.deepEqual(await submissionRows(order.orderSeq), {
        status,
        shipments: 0,
        history: 0,
        acceptedAudit: 0,
      });
      assert.equal((await submitOrder(order, {}, 1)).status, 200);
      assert.equal((await submitOrder(order)).status, 200);
      assert.equal(suite.dverRequests.length, 1);
    }
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

  test('ORD-06 result storage failure rolls back shipments/audit and stale SUBMITTING becomes review without resending', async () => {
    for (const failure of ['shipment', 'audit']) {
      resetDver();
      const order = await readyOrder();
      const owner = failure === 'shipment' ? suite.submissionRepository : apps[0].get(AuditService);
      const method = failure === 'shipment' ? 'finish' : 'recordSuccess',
        original = owner[method];
      owner[method] = async function (...args) {
        await original.apply(this, args);
        if (failure === 'shipment' || args[0].action === 'ORDER_SUBMISSION_ACCEPTED')
          throw Error('submit-finalize-rollback');
      };
      try {
        const response = await submitOrder(order);
        assert.equal(response.status, 202);
        assert.equal((await response.json()).data.status, 'SUBMITTING');
      } finally {
        owner[method] = original;
      }
      assert.deepEqual(await submissionRows(order.orderSeq), {
        status: 'SUBMITTING',
        shipments: 0,
        history: 0,
        acceptedAudit: 0,
      });
      assert.equal((await submitOrder(order, {}, 1)).status, 202);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Set an old timestamp only in the disposable fixture; restore the trigger before commit.
        await client.query('ALTER TABLE orders DISABLE TRIGGER order_header_timestamp');
        await client.query(
          "UPDATE orders SET updated_at=now()-interval '2 minutes',submission_last_attempt_at=now()-interval '20 seconds' WHERE order_seq=$1",
          [order.orderSeq],
        );
        await client.query('ALTER TABLE orders ENABLE TRIGGER order_header_timestamp');
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      const recovery = await submitOrder(order, {}, 1);
      assert.equal(recovery.status, 200);
      assert.equal((await recovery.json()).data.status, 'SUBMITTING_FAILED');
      assert.equal((await submitOrder(order)).status, 200);
      assert.equal(suite.dverRequests.length, 1);
    }
  });

  test('ORD-06 stored submission state survives a new application instance without a request key', async () => {
    resetDver();
    const order = await readyOrder();
    assert.equal((await submitOrder(order)).status, 200);
    const app = await NestFactory.create(AppModule, { logger: false });
    apps.push(app);
    configureApplication(app, { log: () => {} });
    await app.listen(0, '127.0.0.1');
    const response = await fetch((await app.getUrl()) + `/api/orders/${order.orderSeq}/submit`, {
      method: 'POST',
      headers: {
        Origin: origin,
        Cookie: cookies[0],
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expectedVersion: order.version }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.status, 'ACCEPTED');
    assert.equal(suite.dverRequests.length, 1);
  });

  test('ORD-06 waits for membership eligibility and continues the original request', async () => {
    resetDver();
    const order = await readyOrder({
      customerSeq: suite.customerId,
      paymentMethodType: 'groupBilling',
    });
    const lock = await pool.connect();
    let pending;
    try {
      await lock.query('BEGIN');
      await lock.query('SELECT membership_seq FROM memberships WHERE customer_seq=$1 FOR UPDATE', [
        suite.customerId,
      ]);
      pending = submitOrder(order);
      await waitForBlockedBy(lock.processID);
      assert.equal(suite.dverRequests.length, 0);
      assert.equal((await submissionRows(order.orderSeq)).status, 'COLLECTING');
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
      if (pending) await pending;
    }
    assert.equal((await pending).status, 200);
    assert.equal(suite.dverRequests.length, 1);
  });
};
