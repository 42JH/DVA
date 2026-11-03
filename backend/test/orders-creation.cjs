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
    resetDver,
    emptyAiResult,
    readDetail,
    ConfigService,
    hosts,
    cookies,
    aiResult,
    DatabaseService,
    NestFactory,
    AppModule,
    configureApplication,
  } = suite;
  test('AI uses the same ORD-01 for partial and complete data, with one linked order and no shipment', async () => {
    for (const parcels of [
      [{ origin: { name: '수집 중' } }],
      [{ origin: address, destination: address, smallBoxCount: 1, itemPrice: 0 }],
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

  test('concurrent AI retries across application instances create one order per call', async () => {
    const callId = await call(),
      key = randomUUID(),
      body = { customerSeq: suite.customerId };
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, i) => aiCreate(callId, body, key, i % 2)),
    );
    const ids = [];
    for (const response of responses) {
      assert.ok([201, 409].includes(response.status));
      if (response.status === 201) ids.push((await response.json()).data.orderSeq);
      else assert.equal((await response.json()).error.code, 'REQUEST_IN_PROGRESS');
    }
    assert.ok(ids.length > 0);
    assert.equal(new Set(ids).size, 1);
    assert.equal((await (await aiCreate(callId, body, key)).json()).data.orderSeq, ids[0]);
    const secondCall = await call();
    const differentKeys = await Promise.all([
      aiCreate(secondCall, body),
      aiCreate(secondCall, body, randomUUID(), 1),
    ]);
    assert.deepEqual(differentKeys.map((r) => r.status).sort(), [201, 409]);
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

  test('administrator cookies require current sessions and Origin without falling back to AI', async () => {
    const before = await counts();
    for (const Cookie of ['dva_session=bad', 'dva_session=' + 'f'.repeat(64)]) {
      await errorCode(
        await create(undefined, undefined, 0, {
          Cookie,
          Authorization: 'Bearer fake-ai-token',
          'X-Admin-User-Seq': String(suite.adminId),
        }),
        401,
        'UNAUTHORIZED',
      );
    }
    for (const Origin of [undefined, 'https://untrusted.invalid'])
      await errorCode(await create(undefined, undefined, 0, { Origin }), 403, 'FORBIDDEN');
    await pool.query("UPDATE admin_users SET status='PENDING' WHERE admin_user_seq=$1", [
      suite.adminId,
    ]);
    try {
      await errorCode(await create(), 401, 'UNAUTHORIZED');
    } finally {
      await pool.query("UPDATE admin_users SET status='ACTIVE' WHERE admin_user_seq=$1", [
        suite.adminId,
      ]);
    }
    assert.deepEqual(await counts(), before);
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

  test('an empty AI result preserves its call without creating an order, payment or Dver submission', async () => {
    resetDver();
    const before = await counts();
    const input = emptyAiResult();
    const key = randomUUID();
    const response = await aiCreate(undefined, input, key);
    assert.equal(response.status, 201);
    const saved = (await response.json()).data;
    assert.equal(saved.status, 'NO_ORDER');
    assert.equal(saved.orderSeq, null);
    assert.equal(saved.version, null);
    assert.equal(saved.paymentRequest, null);
    assert.equal(saved.totalAmount, null);
    assert.ok(saved.callSessionSeq > 0);
    const session = (
      await pool.query(
        'SELECT order_seq,customer_seq FROM call_sessions WHERE call_session_seq=$1',
        [saved.callSessionSeq],
      )
    ).rows[0];
    assert.equal(session.order_seq, null);
    assert.equal(session.customer_seq, suite.customerId);
    const replay = await aiCreate(undefined, input, key, 1);
    assert.equal(replay.status, 201);
    assert.deepEqual((await replay.json()).data, saved);
    assert.deepEqual(await counts(), before);
    assert.equal(suite.dverRequests.length, 0);
  });

  test('empty incomplete and cancelled snapshots ignore blank parcels and preserve all existing orders', async () => {
    const before = await counts();
    for (const outcome of ['INCOMPLETE', 'CANCELLED']) {
      for (const parcels of [
        undefined,
        [],
        [{}],
        [
          {
            origin: { name: null, detailAddress: ' ' },
            destination: {},
            smallBoxCount: 0,
            itemPrice: null,
            notifiedPrice: null,
          },
        ],
      ]) {
        const response = await aiCreate(undefined, emptyAiResult({ outcome, parcels }));
        assert.equal(response.status, 201);
        const result = (await response.json()).data;
        assert.equal(result.status, 'NO_ORDER');
        assert.equal(result.orderSeq, null);
      }
    }
    assert.deepEqual(await counts(), before);
  });

  test('partly collected AI orders are retained without assigning an unspecified payment method', async () => {
    resetDver();
    for (const change of [
      { parcels: [{ destination: { name: '수령인만 수집' } }] },
      { parcels: [{ smallBoxCount: 1 }] },
      { parcels: [{ itemPrice: 0 }] },
      { paymentMethodType: 'billing' },
      { pickupRequestedAt: '2026-12-01T00:00:00Z' },
    ]) {
      const response = await aiCreate(undefined, emptyAiResult(change));
      assert.equal(response.status, 201);
      const saved = (await response.json()).data;
      assert.equal(saved.status, 'COLLECTING');
      assert.ok(saved.orderSeq > 0);
      const detail = (await (await readDetail(saved.orderSeq)).json()).data;
      assert.equal(detail.paymentMethodType, change.paymentMethodType ?? null);
      assert.equal(saved.paymentRequest, null);
    }
    assert.equal(suite.dverRequests.length, 0);
  });

  test('empty AI results keep replay identity after call termination and reject key or call reuse', async () => {
    const input = emptyAiResult(),
      key = randomUUID();
    const saved = (await (await aiCreate(undefined, input, key)).json()).data;
    const before = await counts();
    await pool.query(
      "UPDATE call_sessions SET started_at=incoming_at,ended_at=incoming_at+interval '1 minute' WHERE call_session_seq=$1",
      [saved.callSessionSeq],
    );
    const replay = await aiCreate(undefined, { ...input, paymentMethodType: 'billing' }, key, 1);
    assert.equal(replay.status, 201);
    assert.deepEqual((await replay.json()).data, saved);
    await errorCode(await aiCreate(undefined, emptyAiResult(), key), 403, 'FORBIDDEN');
    await errorCode(await create({ customerSeq: suite.customerId }, key), 403, 'FORBIDDEN');
    await errorCode(await aiCreate(undefined, input), 409, 'INVALID_STATE');
    assert.deepEqual(await counts(), before);
    assert.equal(
      (
        await pool.query('SELECT 1 FROM empty_ai_order_results WHERE call_session_seq=$1', [
          saved.callSessionSeq,
        ])
      ).rowCount,
      1,
    );
  });

  test('concurrent empty and collected AI results serialize by request key and call identity', async () => {
    for (const sameKey of [true, false]) {
      const input = emptyAiResult(),
        key = randomUUID(),
        before = await counts();
      const responses = await Promise.all([
        aiCreate(undefined, input, key),
        aiCreate(undefined, input, sameKey ? key : randomUUID(), 1),
      ]);
      assert.ok(responses.some((response) => response.status === 201));
      for (const response of responses) {
        assert.ok([201, 409].includes(response.status));
        if (response.status === 201) assert.equal((await response.json()).data.status, 'NO_ORDER');
      }
      const session = (
        await pool.query(
          'SELECT call_session_seq,order_seq FROM call_sessions WHERE provider_call_id=$1',
          [input.call.providerCallId],
        )
      ).rows;
      assert.equal(session.length, 1);
      assert.equal(session[0].order_seq, null);
      assert.equal(
        (
          await pool.query('SELECT 1 FROM empty_ai_order_results WHERE call_session_seq=$1', [
            session[0].call_session_seq,
          ])
        ).rowCount,
        1,
      );
      assert.deepEqual(await counts(), before);
    }
    const input = emptyAiResult();
    const responses = await Promise.all([
      aiCreate(undefined, input),
      aiCreate(undefined, { ...input, parcels: [{ smallBoxCount: 1 }] }, randomUUID(), 1),
    ]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
    const saved = (await (await responses.find((response) => response.status === 201)).json()).data;
    const session = (
      await pool.query('SELECT order_seq FROM call_sessions WHERE provider_call_id=$1', [
        input.call.providerCallId,
      ])
    ).rows[0];
    assert.equal(session.order_seq, saved.orderSeq);
  });

  test('order-free calls still accept AI events and analysis and remain visible to administrators', async () => {
    const input = emptyAiResult();
    const result = (await (await aiCreate(undefined, input)).json()).data;
    const config = apps[0].get(ConfigService),
      previous = config.get('AI_INSIGHTS_TOKEN');
    const token = 'test-only-empty-order-insights-token';
    config.set('AI_INSIGHTS_TOKEN', token);
    const post = (path, body) =>
      fetch(hosts[0] + `/api/ai/calls/${result.callSessionSeq}/${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    try {
      const events = await post('events', {
        providerCallId: input.call.providerCallId,
        events: [
          {
            eventId: randomUUID(),
            eventOrder: 1,
            kind: 'AI_ACTION',
            occurredAt: input.call.incomingAt,
            offsetSeconds: 0,
            payload: {
              action: 'ORDER_SUBMITTED',
              orderSeq: null,
              summaryText: '주문 없는 통화 결과 수신',
            },
          },
        ],
      });
      assert.equal(events.status, 204, await events.text());
      const analysis = await post('analysis', {
        providerCallId: input.call.providerCallId,
        startedAt: input.call.incomingAt,
        endedAt: '2026-10-27T01:01:00Z',
        aiPersonaVersionSeq: null,
        repeatQuestionCount: 0,
        hasComplaint: false,
        complaints: [],
      });
      assert.equal(analysis.status, 204, await analysis.text());
      const response = await fetch(hosts[0] + `/api/calls/${result.callSessionSeq}`, {
        headers: { Cookie: cookies[0] },
      });
      assert.equal(response.status, 200);
      const detail = (await response.json()).data;
      assert.equal(detail.call.orderSeq, null);
      assert.equal(detail.analysis.repeatQuestionCount, 0);
      assert.equal(Object.hasOwn(detail.analysis, 'result'), false);
      assert.equal(detail.aiActionCount, 1);
    } finally {
      config.set('AI_INSIGHTS_TOKEN', previous);
    }
  });

  test('a failed empty-result receipt rolls back the new call and can be retried safely', async () => {
    const input = emptyAiResult(),
      key = randomUUID(),
      before = await counts();
    const save = suite.repository.saveEmptyResult;
    suite.repository.saveEmptyResult = async () => {
      throw Error('test-only-receipt-failure');
    };
    try {
      assert.equal((await aiCreate(undefined, input, key)).status, 500);
    } finally {
      suite.repository.saveEmptyResult = save;
    }
    assert.deepEqual(await counts(), before);
    assert.equal(
      (
        await pool.query('SELECT 1 FROM call_sessions WHERE provider_call_id=$1', [
          input.call.providerCallId,
        ])
      ).rowCount,
      0,
    );
    assert.equal(
      (await pool.query('SELECT 1 FROM empty_ai_order_results WHERE request_id=$1', [key]))
        .rowCount,
      0,
    );
    const replay = await aiCreate(undefined, input, key);
    assert.equal(replay.status, 201);
    assert.equal((await replay.json()).data.status, 'NO_ORDER');
  });

  test('complete AI results must select a payment method before anything is persisted', async () => {
    resetDver();
    const before = await counts();
    const input = aiResult('COMPLETE', { paymentMethodType: undefined });
    const response = await aiCreate(undefined, input);
    assert.equal(response.status, 422);
    const problem = await response.json();
    assert.ok(
      problem.error.details.some(
        (entry) => entry.field === 'paymentMethodType' && entry.reason === 'required',
      ),
    );
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

  require('./orders-migrations.cjs').paymentMethod(suite);

  test('partial parcel snapshots retain field mapping, defaults and the actual trigger-updated version', async () => {
    const response = await create({
      customerSeq: suite.customerId,
      paymentMethodType: 'billing',
      pickupRequestedAt: '2026-10-28T10:00:00+09:00',
      parcels: [
        {
          origin: address,
          destination: { name: '수령인' },
          originPin: { scope: 'PERSONAL', pinSeq: suite.personalPin },
          documentCount: 2,
          itemPrice: 123,
          clientComment: "' ; SELECT 1; --",
        },
        { origin: { name: '둘째' }, smallBoxCount: 1 },
      ],
    });
    assert.equal(response.status, 201);
    const { data } = await response.json();
    const rows = (
      await pool.query('SELECT * FROM order_parcels WHERE order_seq=$1 ORDER BY parcel_position', [
        data.orderSeq,
      ])
    ).rows;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].origin_phone_number, address.phoneNumber);
    assert.equal(rows[0].origin_road_address, address.roadAddress);
    assert.equal(rows[0].origin_postal_code, address.postalCode);
    assert.equal(Object.hasOwn(rows[0], 'origin_latitude'), false);
    assert.equal(Object.hasOwn(rows[0], 'origin_longitude'), false);
    assert.equal(rows[0].destination_name, '수령인');
    assert.equal(Object.hasOwn(rows[0], 'destination_latitude'), false);
    assert.equal(Object.hasOwn(rows[0], 'destination_longitude'), false);
    assert.equal(rows[0].destination_phone_number, null);
    assert.equal(rows[0].origin_pin_seq, suite.personalPin);
    assert.equal(rows[0].document_count, 2);
    assert.equal(rows[0].item_price, '123');
    assert.equal(rows[0].client_comment, "' ; SELECT 1; --");
    assert.equal(rows[1].parcel_position, 2);
    assert.equal(rows[1].document_count, 0);
    assert.equal(rows[1].item_price, null);
    assert.ok(rows.every((row) => row.notified_price === null));
    const header = (
      await pool.query('SELECT version,pickup_requested_at FROM orders WHERE order_seq=$1', [
        data.orderSeq,
      ])
    ).rows[0];
    assert.equal(header.pickup_requested_at.toISOString(), '2026-10-28T01:00:00.000Z');
    assert.equal(data.version, header.version);
    assert.equal(data.version, 3);
  });

  test('2500 details use bounded bulk inserts, preserve trigger versions and roll back earlier batches on failure', async () => {
    const database = apps[0].get(DatabaseService),
      transaction = database.transaction;
    let writes = 0,
      failAt = 0;
    database.transaction = (work) =>
      transaction.call(database, async (client) => {
        const query = client.query;
        client.query = async function (sql, ...args) {
          const result = await query.call(this, sql, ...args);
          if (/^\s*INSERT INTO order_parcels\b/.test(sql)) {
            writes++;
            assert.equal(args[0].length, 1);
            if (writes === failAt) throw Error('bulk-parcel-rollback');
          }
          return result;
        };
        try {
          return await work(client);
        } finally {
          client.query = query;
        }
      });
    const input = {
      customerSeq: suite.customerId,
      parcels: Array.from({ length: 2500 }, () => ({ smallBoxCount: 1 })),
    };
    try {
      const response = await create(input);
      assert.equal(response.status, 201, await response.clone().text());
      const result = (await response.json()).data;
      assert.equal(writes, 13);
      const stored = (
        await pool.query(
          'SELECT count(*)::int AS count,min(parcel_position) AS first,max(parcel_position) AS last,sum(small_box_count)::int AS boxes FROM order_parcels WHERE order_seq=$1',
          [result.orderSeq],
        )
      ).rows[0];
      assert.deepEqual(stored, { count: 2500, first: 1, last: 2500, boxes: 2500 });
      assert.equal(result.version, 2501);
      const before = await counts();
      writes = 0;
      failAt = 2;
      await errorCode(await create(input), 500, 'INTERNAL_ERROR');
      assert.deepEqual(await counts(), before);
    } finally {
      database.transaction = transaction;
    }
  });

  test('invalid bodies and keys fail before order writes', async () => {
    const before = await counts();
    for (const body of [
      { customerSeq: '1' },
      { customerSeq: suite.customerId, parcels: [{ origin: { extra: 1 } }] },
      { customerSeq: suite.customerId, parcels: [{ notifiedPrice: 0 }] },
    ])
      await errorCode(await create(body), 400, 'INVALID_REQUEST');
    for (const key of ['bad', ''])
      await errorCode(await create(undefined, key), 400, 'INVALID_REQUEST');
    await errorCode(
      await create(undefined, undefined, 0, { 'Idempotency-Key': undefined }),
      400,
      'INVALID_REQUEST',
    );
    await errorCode(await create({ customerSeq: 2147483647 }), 404, 'NOT_FOUND');
    await errorCode(await create({ customerSeq: suite.withdrawnId }), 403, 'FORBIDDEN');
    assert.deepEqual(await counts(), before);
  });

  test('PIN access is checked for the order customer and active company membership', async () => {
    const body = (scope, pinSeq) => ({
      customerSeq: suite.customerId,
      parcels: [{ originPin: { scope, pinSeq } }],
    });
    for (const pin of [suite.otherPin, 2147483647])
      await errorCode(await create(body('PERSONAL', pin)), 403, 'FORBIDDEN');
    assert.equal((await create(body('COMPANY', suite.companyPin))).status, 201);
    await pool.query("UPDATE memberships SET status='INACTIVE' WHERE customer_seq=$1", [
      suite.customerId,
    ]);
    try {
      await errorCode(await create(body('COMPANY', suite.companyPin)), 403, 'FORBIDDEN');
    } finally {
      await pool.query("UPDATE memberships SET status='ACTIVE' WHERE customer_seq=$1", [
        suite.customerId,
      ]);
    }
    await pool.query("UPDATE organizations SET status='INACTIVE' WHERE organization_seq=$1", [
      suite.organizationId,
    ]);
    try {
      await errorCode(await create(body('COMPANY', suite.companyPin)), 403, 'FORBIDDEN');
    } finally {
      await pool.query("UPDATE organizations SET status='ACTIVE' WHERE organization_seq=$1", [
        suite.organizationId,
      ]);
    }
  });

  test('creation key returns the current order version without applying a second body or accepting another actor', async () => {
    const key = randomUUID(),
      requestId = randomUUID();
    const first = await create({ customerSeq: suite.customerId }, key, 0, {
      'X-Request-Id': requestId,
    });
    assert.equal(first.status, 201);
    const { data } = await first.json();
    await pool.query("UPDATE orders SET payment_method_type='cat' WHERE order_seq=$1", [
      data.orderSeq,
    ]);
    const current = (
      await pool.query('SELECT version,creation_request_id FROM orders WHERE order_seq=$1', [
        data.orderSeq,
      ])
    ).rows[0];
    assert.equal(current.creation_request_id, key);
    const replay = await create(
      { customerSeq: suite.customerId, paymentMethodType: 'groupBilling' },
      key.toUpperCase(),
    );
    assert.equal(replay.status, 201);
    assert.deepEqual((await replay.json()).data, {
      orderSeq: data.orderSeq,
      version: current.version,
    });
    assert.ok(current.version > data.version);
    assert.equal(
      (
        await pool.query('SELECT payment_method_type FROM orders WHERE order_seq=$1', [
          data.orderSeq,
        ])
      ).rows[0].payment_method_type,
      'cat',
    );
    const logs = (
      await pool.query(
        "SELECT actor_seq,request_id,metadata FROM audit_logs WHERE action='ORDER_CREATED' AND target_seq=$1 AND result='SUCCESS'",
        [data.orderSeq],
      )
    ).rows;
    assert.deepEqual(logs, [{ actor_seq: suite.adminId, request_id: requestId, metadata: {} }]);
    await errorCode(await create({ customerSeq: suite.customerId }, key, 1), 403, 'FORBIDDEN');
    await errorCode(
      await aiCreate(await call(), { customerSeq: suite.customerId }, key),
      403,
      'FORBIDDEN',
    );
    await assert.rejects(
      pool.query('INSERT INTO orders(creation_request_id) VALUES($1)', [key]),
      (error) => error.code === '23505',
    );
  });

  test('AI replay stays bound to the original call even after restart and order changes', async () => {
    const callId = await call(),
      key = randomUUID(),
      body = { customerSeq: suite.customerId };
    const first = await aiCreate(callId, body, key);
    assert.equal(first.status, 201);
    const { orderSeq } = (await first.json()).data;
    await pool.query("UPDATE orders SET payment_method_type='cat' WHERE order_seq=$1", [orderSeq]);
    await errorCode(await aiCreate(await call(), body, key), 403, 'FORBIDDEN');
    await errorCode(await create(body, key), 403, 'FORBIDDEN');
    const restarted = await NestFactory.create(AppModule, { logger: false });
    apps.push(restarted);
    configureApplication(restarted, { log: () => {} });
    await restarted.listen(0, '127.0.0.1');
    const retry = await fetch((await restarted.getUrl()) + '/api/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
        call_session_seq: String(callId),
      },
      body: JSON.stringify(body),
    });
    assert.equal(retry.status, 201);
    const version = (await pool.query('SELECT version FROM orders WHERE order_seq=$1', [orderSeq]))
      .rows[0].version;
    assert.deepEqual((await retry.json()).data, { orderSeq, version });
  });

  test('in-flight duplicates across application instances return 409 and retry the stored result', async () => {
    const key = randomUUID(),
      client = await pool.connect();
    await client.query('BEGIN');
    try {
      assert.equal(await suite.repository.lockCreation(client, key), true);
      await errorCode(await create(undefined, key), 409, 'REQUEST_IN_PROGRESS');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    const cookieB = cookies[1];
    cookies[1] = cookies[0];
    try {
      const responses = await Promise.all(
        Array.from({ length: 6 }, (_, i) => create(undefined, key, i % 2)),
      );
      const ids = [];
      for (const response of responses) {
        assert.ok([201, 409].includes(response.status));
        if (response.status === 201) ids.push((await response.json()).data.orderSeq);
        else assert.equal((await response.json()).error.code, 'REQUEST_IN_PROGRESS');
      }
      assert.ok(ids.length > 0);
      assert.equal(new Set(ids).size, 1);
      const retry = await create(undefined, key, 1);
      assert.equal(retry.status, 201);
      assert.equal((await retry.json()).data.orderSeq, ids[0]);
      assert.equal(
        (await pool.query('SELECT count(*) FROM orders WHERE creation_request_id=$1', [key]))
          .rows[0].count,
        '1',
      );
    } finally {
      cookies[1] = cookieB;
    }
  });

  test('creation key and success-audit failures roll back header, parcels and creation key while preserving safe failure audit', async () => {
    const audit = apps[0].get(AuditService);
    for (const [target, method] of [
      [suite.repository, 'insert'],
      [audit, 'recordSuccess'],
    ]) {
      const original = target[method],
        before = await counts(),
        requestId = randomUUID(),
        key = randomUUID();
      target[method] = async function (...args) {
        if (method === 'insert') await original.apply(this, args);
        throw new Error('private-order-diagnostic');
      };
      try {
        const response = await create(
          { customerSeq: suite.customerId, parcels: [{ origin: { name: '비공개이름' } }] },
          key,
          0,
          { 'X-Request-Id': requestId },
        );
        assert.equal(response.status, 500);
        assert.ok(!(await response.text()).includes('private-order-diagnostic'));
        assert.deepEqual(await counts(), before);
        const logs = (
          await pool.query('SELECT result,metadata FROM audit_logs WHERE request_id=$1', [
            requestId,
          ])
        ).rows;
        assert.deepEqual(logs, [{ result: 'FAILED', metadata: {} }]);
      } finally {
        target[method] = original;
      }
      assert.equal(
        (
          await create(
            { customerSeq: suite.customerId, parcels: [{ origin: { name: '비공개이름' } }] },
            key,
          )
        ).status,
        201,
      );
    }
  });

  test('new customer and draft order are saved together, with one customer audit and a creation key', async () => {
    const key = randomUUID(),
      requestId = randomUUID();
    const input = {
      customer: { name: '신규 주문 고객', phoneNumber: '01000550001' },
      parcels: [{}],
    };
    const before = await counts();
    const response = await create(input, key, 0, { 'X-Request-Id': requestId });
    assert.equal(response.status, 201);
    const { data } = await response.json();
    const customer = (
      await pool.query(
        'SELECT c.customer_seq,c.name,c.phone_number,c.status FROM customers c JOIN orders o USING(customer_seq) WHERE o.order_seq=$1',
        [data.orderSeq],
      )
    ).rows[0];
    assert.equal(customer.name, input.customer.name);
    assert.equal(customer.phone_number, input.customer.phoneNumber);
    assert.equal(customer.status, 'ACTIVE');
    assert.equal(Number((await counts()).customers), Number(before.customers) + 1);
    const replay = await create(
      {
        customer: { phoneNumber: input.customer.phoneNumber, name: input.customer.name },
        parcels: [{}],
        paymentMethodType: 'credit',
      },
      key,
    );
    assert.equal(replay.status, 201);
    assert.deepEqual((await replay.json()).data, data);
    const afterReplay = await counts();
    assert.equal(Number(afterReplay.orders), Number(before.orders) + 1);
    assert.equal(Number(afterReplay.customers), Number(before.customers) + 1);
    for (const changed of [
      { ...input.customer, name: '다른 이름' },
      { ...input.customer, phoneNumber: '01000550002' },
    ])
      assert.deepEqual(
        (await (await create({ ...input, customer: changed }, key)).json()).data,
        data,
      );
    assert.deepEqual(await counts(), afterReplay);
    const logs = (
      await pool.query(
        'SELECT action,target_type,target_seq,actor_seq,result,metadata FROM audit_logs WHERE request_id=$1 ORDER BY action',
        [requestId],
      )
    ).rows;
    assert.deepEqual(logs, [
      {
        action: 'CUSTOMER_CREATED',
        target_type: 'CUSTOMER',
        target_seq: customer.customer_seq,
        actor_seq: suite.adminId,
        result: 'SUCCESS',
        metadata: {},
      },
      {
        action: 'ORDER_CREATED',
        target_type: 'ORDER',
        target_seq: data.orderSeq,
        actor_seq: suite.adminId,
        result: 'SUCCESS',
        metadata: {},
      },
    ]);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*) FROM audit_logs WHERE target_type='CUSTOMER' AND target_seq=$1 AND action='CUSTOMER_CREATED'",
          [customer.customer_seq],
        )
      ).rows[0].count,
      '1',
    );
  });

  test('existing phone links the same customer without overwriting identity, status or PIN scope', async () => {
    const input = {
      customer: { name: '기존 이름 덮어쓰기 시도', phoneNumber: '01000000001' },
      parcels: [{ originPin: { scope: 'PERSONAL', pinSeq: suite.personalPin } }],
    };
    const before = await counts(),
      requestId = randomUUID();
    const response = await create(input, randomUUID(), 0, { 'X-Request-Id': requestId });
    assert.equal(response.status, 201);
    const { data } = await response.json();
    assert.equal(
      (await pool.query('SELECT customer_seq FROM orders WHERE order_seq=$1', [data.orderSeq]))
        .rows[0].customer_seq,
      suite.customerId,
    );
    assert.deepEqual(
      (
        await pool.query('SELECT name,status FROM customers WHERE customer_seq=$1', [
          suite.customerId,
        ])
      ).rows[0],
      { name: '주문 검증', status: 'ACTIVE' },
    );
    assert.equal((await counts()).customers, before.customers);
    assert.deepEqual(
      (await pool.query('SELECT action FROM audit_logs WHERE request_id=$1', [requestId])).rows,
      [{ action: 'ORDER_CREATED' }],
    );
    await errorCode(
      await create({
        ...input,
        parcels: [{ originPin: { scope: 'PERSONAL', pinSeq: suite.otherPin } }],
      }),
      403,
      'FORBIDDEN',
    );
    await errorCode(
      await create({ customer: { name: '탈퇴 복원 시도', phoneNumber: '01000000002' } }),
      403,
      'FORBIDDEN',
    );
    assert.equal(
      (await pool.query('SELECT status FROM customers WHERE customer_seq=$1', [suite.withdrawnId]))
        .rows[0].status,
      'WITHDRAWN',
    );
  });

  test('invalid or ambiguous customer references never create customer or order rows', async () => {
    const before = await counts();
    for (const body of [
      {},
      { customerSeq: suite.customerId, customer: { name: '신규', phoneNumber: '01000550100' } },
      { customerSeq: null, customer: { name: '신규', phoneNumber: '01000550100' } },
      { customer: null },
      { customer: { name: ' ', phoneNumber: '01000550100' } },
      { customer: { name: '신규', phoneNumber: '010-0055-0100' } },
      { customer: { name: '신규', phoneNumber: '01000550100', status: 'ACTIVE' } },
    ])
      await errorCode(await create(body), 400, 'INVALID_REQUEST');
    await errorCode(
      await create({ customer: { name: '신규', phoneNumber: '01000550100' } }, randomUUID(), 0, {
        Cookie: undefined,
      }),
      400,
      'INVALID_REQUEST',
    );
    assert.deepEqual(await counts(), before);
  });

  test('concurrent distinct orders across instances share a single newly registered phone identity', async () => {
    const customer = { name: '동시 주문 고객', phoneNumber: '01000550003' };
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, i) => create({ customer }, randomUUID(), i % 2)),
    );
    const ids = [];
    for (const response of responses) {
      assert.equal(response.status, 201);
      ids.push((await response.json()).data.orderSeq);
    }
    assert.equal(new Set(ids).size, 6);
    const rows = (
      await pool.query('SELECT customer_seq,name FROM customers WHERE phone_number=$1', [
        customer.phoneNumber,
      ])
    ).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, customer.name);
    const linked = (
      await pool.query('SELECT DISTINCT customer_seq FROM orders WHERE order_seq=ANY($1::int[])', [
        ids,
      ])
    ).rows;
    assert.deepEqual(linked, [{ customer_seq: rows[0].customer_seq }]);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*) FROM audit_logs WHERE action='CUSTOMER_CREATED' AND target_seq=$1",
          [rows[0].customer_seq],
        )
      ).rows[0].count,
      '1',
    );
  });

  test('PIN denial, creation key failure and order-audit failure roll back newly registered customers too', async () => {
    const deniedBefore = await counts();
    await errorCode(
      await create({
        customer: { name: '거절된 신규', phoneNumber: '01000550004' },
        parcels: [{ originPin: { scope: 'PERSONAL', pinSeq: suite.personalPin } }],
      }),
      403,
      'FORBIDDEN',
    );
    assert.deepEqual(await counts(), deniedBefore);
    const audit = apps[0].get(AuditService);
    for (const [index, [target, method]] of [
      [suite.repository, 'insert'],
      [audit, 'recordSuccess'],
    ].entries()) {
      const original = target[method],
        before = await counts(),
        requestId = randomUUID(),
        key = randomUUID();
      const input = {
        customer: { name: '롤백 고객', phoneNumber: `0100055001${index}` },
        parcels: [{}],
      };
      target[method] = async function (...args) {
        if (method === 'recordSuccess' && args[0].action !== 'ORDER_CREATED')
          return original.apply(this, args);
        if (method === 'insert') await original.apply(this, args);
        throw new Error('private-customer-order-diagnostic');
      };
      try {
        const response = await create(input, key, 0, { 'X-Request-Id': requestId });
        assert.equal(response.status, 500);
        assert.ok(!(await response.text()).includes('private-customer-order-diagnostic'));
        assert.deepEqual(await counts(), before);
        assert.deepEqual(
          (
            await pool.query('SELECT result,metadata FROM audit_logs WHERE request_id=$1', [
              requestId,
            ])
          ).rows,
          [{ result: 'FAILED', metadata: {} }],
        );
      } finally {
        target[method] = original;
      }
      assert.equal((await create(input, key)).status, 201);
      assert.equal(Number((await counts()).customers), Number(before.customers) + 1);
    }
  });

  test('a fully populated new-customer order remains COLLECTING until a separate final submission', async () => {
    const before = await counts();
    const response = await create({
      customer: { name: '정보 완성 고객', phoneNumber: '01000550020' },
      pickupRequestedAt: '2026-10-28T10:00:00+09:00',
      paymentMethodType: 'billing',
      parcels: [{ origin: address, destination: address, smallBoxCount: 1, itemPrice: 0 }],
    });
    assert.equal(response.status, 201);
    const { data } = await response.json();
    assert.deepEqual(
      (
        await pool.query(
          'SELECT status,parcel_no,dver_received_at FROM orders WHERE order_seq=$1',
          [data.orderSeq],
        )
      ).rows[0],
      { status: 'COLLECTING', parcel_no: null, dver_received_at: null },
    );
    assert.equal((await counts()).shipments, before.shipments);
  });

  test('Swagger omits coordinates from all address request and response schemas', async () => {
    const response = await fetch(hosts[0] + '/api/docs-json');
    assert.equal(response.status, 200);
    const schemas = (await response.json()).components.schemas;
    for (const name of [
      'CustomerAddressDto',
      'PinAddressInputDto',
      'PinAddressDto',
      'OrderAddressPatchDto',
      'OrderAddressValueDto',
    ])
      assert.ok(schemas[name], name);
    for (const [name, schema] of Object.entries(schemas))
      for (const field of ['latitude', 'longitude']) {
        assert.equal(Object.hasOwn(schema.properties ?? {}, field), false, name + '.' + field);
        assert.equal((schema.required ?? []).includes(field), false, name + '.' + field);
      }
  });
};
