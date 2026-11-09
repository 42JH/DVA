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
            itemPrice: 100000000,
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
    assert.equal(added.itemPrice, 100000000);
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
};
