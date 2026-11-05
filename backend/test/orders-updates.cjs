module.exports = function registerOrdersUpdates(suite) {
  const {
    test,
    readOrder,
    address,
    pool,
    storedOrder,
    randomUUID,
    patchOrder,
    assert,
    readCustomer,
    errorCode,
    counts,
    call,
    apps,
    AuditService,
    aiReadHeaders,
    aiCreate,
    readDetail,
    readOrders,
    create,
    hosts,
  } = suite;
  test('ORD-04 merges addresses, preserves omitted parcels and appends after the largest position', async () => {
    const id = await readOrder(suite.customerId, [
      {
        origin: address,
        destination: address,
        originPin: { scope: 'PERSONAL', pinSeq: suite.personalPin },
        documentCount: 2,
        smallBoxCount: 3,
        itemPrice: 4000,
        clientComment: '유지',
      },
      { destination: { name: '변경하지 않을 상세' } },
    ]);
    await pool.query(
      'UPDATE order_parcels SET parcel_position=5 WHERE order_seq=$1 AND parcel_position=2',
      [id],
    );
    const before = await storedOrder(id);
    const requestId = randomUUID();
    const response = await patchOrder(
      id,
      {
        expectedVersion: before.version,
        paymentMethodType: 'billing',
        pickupRequestedAt: '2026-10-28T10:00:00+09:00',
        parcels: [
          {
            orderParcelSeq: before.parcels[0].orderParcelSeq,
            destination: { roadAddress: "배송로 '); DROP TABLE orders; --", detailAddress: null },
            origin: { postalCode: '00000' },
            documentCount: 0,
          },
          {
            destination: { name: '새 상세', phoneNumber: '01000012345' },
            smallBoxCount: 1,
            itemPrice: Number.MAX_SAFE_INTEGER,
          },
        ],
      },
      { 'X-Request-Id': requestId },
    );
    assert.equal(response.status, 200);
    const result = await response.json(),
      after = await storedOrder(id);
    assert.deepEqual(result, { data: { version: after.version }, meta: { requestId } });
    assert.ok(after.version > before.version);
    assert.equal(after.paymentMethodType, 'billing');
    assert.equal(Date.parse(after.pickupRequestedAt), Date.parse('2026-10-28T01:00:00Z'));
    assert.deepEqual(after.parcels[0], {
      ...before.parcels[0],
      documentCount: 0,
      origin: { ...before.parcels[0].origin, postalCode: '00000' },
      destination: {
        ...before.parcels[0].destination,
        roadAddress: "배송로 '); DROP TABLE orders; --",
        detailAddress: null,
      },
    });
    assert.deepEqual(after.parcels[1], before.parcels[1]);
    const added = after.parcels[2];
    assert.equal(added.parcelPosition, 6);
    assert.equal(added.destination.phoneNumber, '01000012345');
    assert.equal(added.origin.name, null);
    assert.equal(added.originPin, null);
    assert.equal(added.documentCount, 0);
    assert.equal(added.clientComment, '');
    assert.equal(added.notifiedPrice, null);
    assert.equal(added.itemPrice, Number.MAX_SAFE_INTEGER);
    assert.equal(Object.hasOwn(added, 'shipment'), false);
    assert.equal(after.parcelNo, null);
    assert.equal(after.dverReceivedAt, null);
    assert.equal(after.status, 'COLLECTING');
    assert.deepEqual(
      (
        await pool.query('SELECT address_data FROM personal_pins WHERE personal_pin_seq=$1', [
          suite.personalPin,
        ])
      ).rows[0].address_data,
      address,
    );
    assert.deepEqual(
      (
        await pool.query(
          "SELECT actor_seq,metadata FROM audit_logs WHERE action='ORDER_UPDATED' AND request_id=$1 AND result='SUCCESS'",
          [requestId],
        )
      ).rows,
      [{ actor_seq: suite.adminId, metadata: {} }],
    );
  });

  test('ORD-04 clears nullable values and preserves zero or empty text without resetting omitted data', async () => {
    const id = await readOrder(suite.customerId, [
      {
        origin: address,
        destination: address,
        originPin: { scope: 'PERSONAL', pinSeq: suite.personalPin },
        itemPrice: 100,
        smallBoxCount: 2,
        clientComment: '이전',
      },
    ]);
    await pool.query(
      "UPDATE orders SET pickup_requested_at='2026-10-28T00:00:00Z' WHERE order_seq=$1",
      [id],
    );
    const before = await storedOrder(id);
    const emptyAddress = Object.fromEntries(Object.keys(address).map((key) => [key, null]));
    assert.equal(
      (
        await patchOrder(id, {
          expectedVersion: before.version,
          pickupRequestedAt: null,
          parcels: [
            {
              orderParcelSeq: before.parcels[0].orderParcelSeq,
              origin: emptyAddress,
              originPin: null,
              itemPrice: null,
              smallBoxCount: 0,
              clientComment: '',
            },
          ],
        })
      ).status,
      200,
    );
    const after = await storedOrder(id);
    assert.equal(after.pickupRequestedAt, null);
    assert.deepEqual(after.parcels[0].origin, emptyAddress);
    assert.deepEqual(after.parcels[0].destination, before.parcels[0].destination);
    assert.equal(after.parcels[0].originPin, null);
    assert.equal(after.parcels[0].itemPrice, null);
    assert.equal(after.parcels[0].smallBoxCount, 0);
    assert.equal(after.parcels[0].clientComment, '');
  });

  test('ORD-04 consumes the version even for an unchanged value and rejects replay', async () => {
    const { customer } = await readCustomer();
    const id = await readOrder(customer),
      before = await storedOrder(id);
    const input = { expectedVersion: before.version, paymentMethodType: before.paymentMethodType };
    const response = await patchOrder(id, input);
    assert.equal(response.status, 200);
    const after = await storedOrder(id);
    assert.equal((await response.json()).data.version, after.version);
    assert.ok(after.version > before.version);
    await errorCode(await patchOrder(id, input), 409, 'VERSION_CONFLICT');
    assert.deepEqual(await storedOrder(id), after);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM audit_logs WHERE action='ORDER_UPDATED' AND target_seq=$1 AND result='SUCCESS'",
          [id],
        )
      ).rows[0].count,
      1,
    );
  });

  test('ORD-04 rejects foreign or missing details and malformed requests without partial writes', async () => {
    const id = await readOrder(suite.customerId, [{ smallBoxCount: 1 }]);
    const other = await storedOrder(await readOrder(suite.otherId, [{ smallBoxCount: 2 }]));
    const before = await storedOrder(id),
      beforeCounts = await counts();
    for (const parcelId of [other.parcels[0].orderParcelSeq, 2147483647])
      await errorCode(
        await patchOrder(id, {
          expectedVersion: before.version,
          paymentMethodType: 'billing',
          parcels: [{ smallBoxCount: 3 }, { orderParcelSeq: parcelId, smallBoxCount: 4 }],
        }),
        404,
        'NOT_FOUND',
      );
    for (const input of [
      { expectedVersion: before.version },
      { expectedVersion: before.version, parcels: [] },
      { expectedVersion: before.version, parcels: [{}] },
      { expectedVersion: before.version, parcels: [{ origin: {} }] },
      { expectedVersion: before.version, parcels: [{ destination: null }] },
      { expectedVersion: before.version, status: 'ACCEPTED' },
      { expectedVersion: before.version, customerSeq: suite.otherId },
      {
        expectedVersion: before.version,
        parcels: [1, 2].map(() => ({
          orderParcelSeq: before.parcels[0].orderParcelSeq,
          smallBoxCount: 1,
        })),
      },
    ])
      await errorCode(await patchOrder(id, input), 400, 'INVALID_REQUEST');
    await errorCode(
      await patchOrder(2147483647, { expectedVersion: 1, paymentMethodType: 'billing' }),
      404,
      'NOT_FOUND',
    );
    for (const invalidId of ['abc', '0', '2147483648'])
      await errorCode(
        await patchOrder(invalidId, { expectedVersion: 1, paymentMethodType: 'billing' }),
        400,
        'INVALID_REQUEST',
      );
    assert.deepEqual(await storedOrder(id), before);
    assert.deepEqual(await counts(), beforeCounts);
  });

  test('ORD-04 concurrent saves across app instances append once with one winning version', async () => {
    const { customer } = await readCustomer();
    const id = await readOrder(customer),
      before = await storedOrder(id);
    const input = { expectedVersion: before.version, parcels: [{ smallBoxCount: 1 }] };
    const results = await Promise.all([0, 1, 2].map((index) => patchOrder(id, input, {}, index)));
    assert.deepEqual(results.map((response) => response.status).sort(), [200, 409, 409]);
    const after = await storedOrder(id);
    assert.equal(after.parcels.length, 1);
    for (const response of results) {
      if (response.status === 200)
        assert.equal((await response.json()).data.version, after.version);
      else await errorCode(response, 409, 'VERSION_CONFLICT');
    }
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM audit_logs WHERE action='ORDER_UPDATED' AND target_seq=$1 AND result='SUCCESS'",
          [id],
        )
      ).rows[0].count,
      1,
    );
  });

  test('ORD-04 rolls back header, details, call binding and success audit on storage failures', async () => {
    const { customer, phone } = await readCustomer();
    const id = await readOrder(customer, [{ smallBoxCount: 1 }]),
      callId = await call(phone);
    const before = await storedOrder(id),
      beforeCounts = await counts();
    const audit = apps[0].get(AuditService);
    const input = {
      expectedVersion: before.version,
      paymentMethodType: 'billing',
      parcels: [
        { orderParcelSeq: before.parcels[0].orderParcelSeq, smallBoxCount: 2 },
        { smallBoxCount: 3 },
      ],
    };
    for (const [owner, method] of [
      [suite.repository, 'updateParcel'],
      [suite.repository, 'insertParcels'],
      [audit, 'recordSuccess'],
    ]) {
      const original = owner[method];
      owner[method] = async function (...args) {
        const result = await original.apply(this, args);
        if (method !== 'recordSuccess' || args[0].action === 'ORDER_UPDATED')
          throw Error('update-rollback-test');
        return result;
      };
      try {
        assert.equal((await patchOrder(id, input, aiReadHeaders(callId))).status, 500);
      } finally {
        owner[method] = original;
      }
      assert.deepEqual(await storedOrder(id), before);
      assert.deepEqual(await counts(), beforeCounts);
      assert.equal(
        (
          await pool.query('SELECT order_seq FROM call_sessions WHERE call_session_seq=$1', [
            callId,
          ])
        ).rows[0].order_seq,
        null,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM audit_logs WHERE action='ORDER_UPDATED' AND target_seq=$1 AND result='SUCCESS'",
            [id],
          )
        ).rows[0].count,
        0,
      );
    }
    assert.equal((await patchOrder(id, input, aiReadHeaders(callId))).status, 200);
  });

  test('ORD-04 AI rejects every non-COLLECTING state without changing orders or shipments', async () => {
    const { customer, phone } = await readCustomer();
    const callId = await call(phone);
    for (const status of [
      'notPaid',
      'PAID',
      'SUBMITTING',
      'ACCEPTED',
      'SUBMISSION_FAILED',
      'CANCELLED',
    ]) {
      const id = await readOrder(customer, [{ smallBoxCount: 1 }]);
      await pool.query(
        "UPDATE orders SET status=$2,pickup_requested_at='2026-10-28T00:00:00Z',parcel_no=$3,dver_received_at=$4 WHERE order_seq=$1",
        [
          id,
          status,
          status === 'ACCEPTED' ? 'UPDT0061' : null,
          status === 'ACCEPTED' ? '2026-10-27T00:00:00Z' : null,
        ],
      );
      const before = await storedOrder(id);
      if (status === 'ACCEPTED')
        await pool.query(
          "INSERT INTO shipments(order_parcel_seq,tracking_number,status) VALUES($1,$2,'sent')",
          [before.parcels[0].orderParcelSeq, 'update-' + randomUUID()],
        );
      const snapshot = await storedOrder(id);
      await errorCode(
        await patchOrder(
          id,
          {
            expectedVersion: snapshot.version,
            parcels: [
              {
                orderParcelSeq: snapshot.parcels[0].orderParcelSeq,
                destination: { name: '변경 시도' },
              },
            ],
          },
          aiReadHeaders(callId),
        ),
        409,
        'INVALID_STATE',
      );
      assert.deepEqual(await storedOrder(id), snapshot);
    }
  });

  test('ORD-04 checks personal PIN ownership and permits clearing a revoked reference', async () => {
    const id = await readOrder(suite.customerId, [{ smallBoxCount: 1 }]);
    let before = await storedOrder(id);
    const change = (pin) => ({
      expectedVersion: before.version,
      parcels: [{ orderParcelSeq: before.parcels[0].orderParcelSeq, originPin: pin }],
    });
    await errorCode(
      await patchOrder(id, change({ scope: 'PERSONAL', pinSeq: suite.otherPin })),
      403,
      'FORBIDDEN',
    );
    await errorCode(
      await patchOrder(id, change({ scope: 'COMPANY', pinSeq: 2147483647 })),
      400,
      'INVALID_REQUEST',
    );
    assert.equal(
      (await patchOrder(id, change({ scope: 'PERSONAL', pinSeq: suite.personalPin }))).status,
      200,
    );
    before = await storedOrder(id);
    await pool.query(
      'UPDATE personal_pins SET deleted_at=clock_timestamp() WHERE personal_pin_seq=$1',
      [suite.personalPin],
    );
    try {
      await errorCode(
        await patchOrder(id, {
          expectedVersion: before.version,
          parcels: [{ orderParcelSeq: before.parcels[0].orderParcelSeq, smallBoxCount: 2 }],
        }),
        403,
        'FORBIDDEN',
      );
      assert.deepEqual(await storedOrder(id), before);
      assert.equal((await patchOrder(id, change(null))).status, 200);
      assert.equal((await storedOrder(id)).parcels[0].originPin, null);
    } finally {
      await pool.query('UPDATE personal_pins SET deleted_at=NULL WHERE personal_pin_seq=$1', [
        suite.personalPin,
      ]);
    }
  });

  test('legacy COMPANY references preserve only the same parcel and address snapshot, and never authorize a new selection', async () => {
    const id = await readOrder(suite.customerId, [
      { origin: address, smallBoxCount: 1 },
      { origin: address, smallBoxCount: 1 },
    ]);
    let before = await storedOrder(id);
    const parcelId = before.parcels[0].orderParcelSeq;
    const legacy = { scope: 'COMPANY', pinSeq: suite.companyPin };
    await pool.query(
      "UPDATE order_parcels SET origin_pin_scope='COMPANY',origin_pin_seq=$2 WHERE order_parcel_seq=$1",
      [parcelId, legacy.pinSeq],
    );
    before = await storedOrder(id);
    const patch = (change) =>
      patchOrder(id, {
        expectedVersion: before.version,
        parcels: [{ orderParcelSeq: parcelId, ...change }],
      });
    for (const change of [
      { originPin: { ...legacy, pinSeq: legacy.pinSeq + 1 } },
      { origin: { name: '다른 출발지' } },
      { originPin: legacy, origin: { name: '다른 출발지' } },
      { orderParcelSeq: before.parcels[1].orderParcelSeq, originPin: legacy },
      { orderParcelSeq: undefined, originPin: legacy, origin: address },
    ]) {
      await errorCode(await patch(change), 400, 'INVALID_REQUEST');
      assert.deepEqual(await storedOrder(id), before);
    }
    assert.equal(
      (await patch({ originPin: legacy, origin: address, smallBoxCount: 2 })).status,
      200,
    );
    let current = await storedOrder(id);
    assert.deepEqual(current.parcels[0].origin, before.parcels[0].origin);
    assert.deepEqual(current.parcels[0].originPin, legacy);
    before = current;
    assert.equal((await patch({ clientComment: '과거 주소 유지' })).status, 200);
    current = await storedOrder(id);
    assert.deepEqual(current.parcels[0].originPin, legacy);
    before = current;
    assert.equal((await patch({ origin: { name: '새 출발지' }, originPin: null })).status, 200);
    current = await storedOrder(id);
    assert.equal(current.parcels[0].originPin, null);
    assert.equal(current.parcels[0].origin.name, '새 출발지');
  });

  test('ORD-04 AI continues an explicitly selected customer order and cannot replace a call binding', async () => {
    const { customer, phone } = await readCustomer();
    const callId = await call(phone),
      id = await readOrder(customer);
    const before = await storedOrder(id);
    const response = await patchOrder(
      id,
      { expectedVersion: before.version, parcels: [{ destination: { name: 'AI 수집' } }] },
      { ...aiReadHeaders(callId), Origin: undefined },
    );
    assert.equal(response.status, 200);
    assert.equal(
      (await pool.query('SELECT order_seq FROM call_sessions WHERE call_session_seq=$1', [callId]))
        .rows[0].order_seq,
      id,
    );
    const another = await readOrder(customer),
      other = await storedOrder(another);
    await errorCode(
      await patchOrder(
        another,
        { expectedVersion: other.version, paymentMethodType: 'billing' },
        aiReadHeaders(callId),
      ),
      409,
      'INVALID_STATE',
    );
    assert.deepEqual(await storedOrder(another), other);
    const staleCall = await call(phone);
    await errorCode(
      await patchOrder(
        id,
        { expectedVersion: before.version, paymentMethodType: 'billing' },
        aiReadHeaders(staleCall),
      ),
      409,
      'VERSION_CONFLICT',
    );
    assert.equal(
      (
        await pool.query('SELECT order_seq FROM call_sessions WHERE call_session_seq=$1', [
          staleCall,
        ])
      ).rows[0].order_seq,
      null,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT actor_seq FROM audit_logs WHERE action='ORDER_UPDATED' AND target_seq=$1 AND result='SUCCESS'",
          [id],
        )
      ).rows[0].actor_seq,
      null,
    );
  });

  test('ORD-04 AI may finish a previously linked order after call end but cannot bind a new order', async () => {
    const { customer, phone } = await readCustomer();
    const callId = await call(phone);
    const response = await aiCreate(callId, { customerSeq: customer });
    assert.equal(response.status, 201);
    const { orderSeq: id, version } = (await response.json()).data;
    await pool.query(
      "UPDATE call_sessions SET started_at='2026-10-27T00:00:00Z',ended_at='2026-10-27T00:01:00Z' WHERE call_session_seq=$1",
      [callId],
    );
    const input = {
      expectedVersion: version,
      parcels: [{ destination: { name: '종료 전 수집한 내용' } }],
    };
    assert.equal((await patchOrder(id, input, aiReadHeaders(callId))).status, 200);
    await errorCode(await patchOrder(id, input, aiReadHeaders(callId)), 409, 'VERSION_CONFLICT');
    const recovery = await readDetail(id, aiReadHeaders(callId));
    assert.equal(recovery.status, 200);
    const recovered = (await recovery.json()).data;
    assert.equal(recovered.parcels.length, 1);
    assert.ok(recovered.version > version);
    assert.equal(
      (
        await patchOrder(
          id,
          {
            expectedVersion: recovered.version,
            parcels: [{ orderParcelSeq: recovered.parcels[0].orderParcelSeq, smallBoxCount: 1 }],
          },
          aiReadHeaders(callId),
        )
      ).status,
      200,
    );
    assert.equal((await storedOrder(id)).parcels.length, 1);
    await errorCode(await readOrders('', aiReadHeaders(callId)), 409, 'INVALID_STATE');
    const other = await readOrder(customer);
    await errorCode(await readDetail(other, aiReadHeaders(callId)), 409, 'INVALID_STATE');
    const unbound = await call(phone, true),
      before = await storedOrder(id);
    await errorCode(
      await patchOrder(
        id,
        { expectedVersion: before.version, paymentMethodType: 'billing' },
        aiReadHeaders(unbound),
      ),
      409,
      'INVALID_STATE',
    );
    assert.deepEqual(await storedOrder(id), before);
  });

  test('ORD-04 rejects AI calls without matching active customers, a valid call or the proper session', async () => {
    const { customer, phone } = await readCustomer();
    const id = await readOrder(customer),
      before = await storedOrder(id);
    const input = { expectedVersion: before.version, paymentMethodType: 'billing' };
    for (const callId of [await call(), await call('01000000003')])
      await errorCode(await patchOrder(id, input, aiReadHeaders(callId)), 403, 'FORBIDDEN');
    for (const header of [undefined, 'abc', '0', '2147483648'])
      await errorCode(
        await patchOrder(id, input, { Cookie: undefined, call_session_seq: header }),
        400,
        'INVALID_REQUEST',
      );
    await errorCode(await patchOrder(id, input, aiReadHeaders(2147483647)), 404, 'NOT_FOUND');
    const callId = await call(phone);
    for (const Cookie of ['dva_session=bad', 'dva_session=' + 'f'.repeat(64)])
      await errorCode(
        await patchOrder(id, input, { ...aiReadHeaders(callId), Cookie }),
        401,
        'UNAUTHORIZED',
      );
    for (const Origin of [undefined, 'https://untrusted.invalid'])
      await errorCode(await patchOrder(id, input, { Origin }), 403, 'FORBIDDEN');
    await pool.query("UPDATE customers SET status='WITHDRAWN' WHERE customer_seq=$1", [customer]);
    await errorCode(await patchOrder(id, input, aiReadHeaders(callId)), 403, 'FORBIDDEN');
    await errorCode(await patchOrder(id, input), 403, 'FORBIDDEN');
    assert.deepEqual(await storedOrder(id), before);
  });

  test('ORD-04 all active administrator roles save without a call, inactive sessions fail', async () => {
    const { customer } = await readCustomer();
    const id = await readOrder(customer);
    for (const index of [0, 1, 2]) {
      const before = await storedOrder(id);
      assert.equal(
        (
          await patchOrder(
            id,
            { expectedVersion: before.version, paymentMethodType: 'billing' },
            {},
            index,
          )
        ).status,
        200,
      );
    }
    const before = await storedOrder(id);
    await pool.query("UPDATE admin_users SET status='PENDING' WHERE admin_user_seq=$1", [
      suite.adminId,
    ]);
    try {
      await errorCode(
        await patchOrder(id, { expectedVersion: before.version, paymentMethodType: 'billing' }),
        401,
        'UNAUTHORIZED',
      );
    } finally {
      await pool.query("UPDATE admin_users SET status='ACTIVE' WHERE admin_user_seq=$1", [
        suite.adminId,
      ]);
    }
    assert.deepEqual(await storedOrder(id), before);
  });

  test('order APIs use the literal DB column header and reject former or hyphenated names', async () => {
    const { customer, phone } = await readCustomer();
    const id = await readOrder(customer),
      callId = await call(phone);
    const before = await storedOrder(id),
      beforeCounts = await counts();
    for (const name of ['X-Call-Session-Id', 'X-Call-Session-Seq', 'call-session-seq']) {
      const headers = { Cookie: undefined, [name]: String(callId) };
      await errorCode(
        await create({ customerSeq: customer }, randomUUID(), 0, headers),
        400,
        'INVALID_REQUEST',
      );
      await errorCode(await readOrders('', headers), 400, 'INVALID_REQUEST');
      await errorCode(await readDetail(id, headers), 400, 'INVALID_REQUEST');
      const response = await patchOrder(
        id,
        { expectedVersion: before.version, paymentMethodType: 'billing' },
        headers,
      );
      assert.equal(response.status, 400);
      const error = (await response.json()).error;
      assert.equal(error.code, 'INVALID_REQUEST');
      assert.ok(error.message.includes('call_session_seq'));
    }
    assert.deepEqual(await storedOrder(id), before);
    assert.deepEqual(await counts(), beforeCounts);
    // HTTP 헤더의 대소문자 구분 없음은 유지하며 밑줄 이름을 그대로 읽는다.
    assert.equal(
      (await readDetail(id, { Cookie: undefined, CALL_SESSION_SEQ: String(callId) })).status,
      200,
    );
    const spec = await (await fetch(hosts[0] + '/api/docs-json')).json();
    for (const operation of [
      spec.paths['/api/orders'].get,
      spec.paths['/api/orders'].post,
      spec.paths['/api/orders/{id}'].get,
      spec.paths['/api/orders/{id}'].patch,
    ]) {
      const headers = operation.parameters.filter(
        (parameter) => parameter.in === 'header' && parameter.name !== 'Idempotency-Key',
      );
      assert.equal(headers.length, 1);
      assert.equal(headers[0].name, 'call_session_seq');
      assert.ok(headers[0].description.includes('call_sessions.call_session_seq'));
    }
  });
};
