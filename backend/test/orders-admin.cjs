module.exports = function registerOrdersAdmin(suite) {
  const {
    test,
    readCustomer,
    randomUUID,
    readOrder,
    pool,
    screenOrders,
    assert,
    address,
    errorCode,
    resetDver,
    readyOrder,
    storedOrder,
    patchOrder,
    apps,
    AuditService,
    call,
    aiReadHeaders,
  } = suite;
  test('admin screen lists one row per stored order and all saved parcel parties/items with matching totals', async () => {
    const { customer } = await readCustomer();
    const marker = 'screen' + randomUUID();
    const parcels = [
      {
        origin: {
          name: marker + ' 발송인',
          phoneNumber: '01098765432',
          roadAddress: '출발 도로',
          jibunAddress: '출발 지번',
          detailAddress: '101호',
        },
        destination: { name: '첫 수령인', roadAddress: '첫 도착지' },
        documentCount: 1,
      },
      {
        origin: { name: '둘째 발송인' },
        destination: {
          name: marker + ' 두번째 한글',
          roadAddress: marker + ' 도로_%',
          phoneNumber: '01098765433',
        },
        smallBoxCount: 2,
        otherItemDescription: '기타 물품',
      },
    ];
    const id = await readOrder(customer, parcels);
    const emptyId = await readOrder(customer);
    await pool.query(
      "UPDATE orders SET created_at='2091-01-01T00:00:00Z' WHERE order_seq=ANY($1::int[])",
      [[id, emptyId]],
    );
    const range = { from: '2091-01-01T00:00:00Z', to: '2091-01-02T00:00:00Z' };
    const response = await screenOrders({ ...range, limit: '1' });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const first = await response.json();
    assert.deepEqual(Object.keys(first).sort(), ['data', 'hasNext', 'statusCounts', 'total_count']);
    assert.deepEqual(first.statusCounts, {
      all: 2,
      incomplete: 0,
      notPaid: 0,
      paid: 0,
      submissionFailed: 0,
      cancelled: 0,
    });
    assert.equal(first.total_count, 2);
    assert.equal(first.hasNext, true);
    assert.equal(first.data[0].orderSeq, emptyId);
    assert.deepEqual(first.data[0].parcels, []);
    const second = await (await screenOrders({ ...range, limit: '1', offset: '1' })).json();
    assert.equal(second.total_count, 2);
    assert.equal(second.hasNext, false);
    const row = second.data[0];
    assert.deepEqual(Object.keys(row).sort(), [
      'createdAt',
      'customerSeq',
      'orderSeq',
      'organizationName',
      'parcels',
      'pickupRequestedAt',
      'status',
    ]);
    assert.equal(row.orderSeq, id);
    assert.equal(row.customerSeq, customer);
    assert.equal(row.organizationName, null);
    assert.equal(row.parcels.length, 2);
    assert.equal(row.parcels[0].origin.name, parcels[0].origin.name);
    assert.equal(row.parcels[1].destination.name, parcels[1].destination.name);
    assert.equal(row.parcels[1].smallBoxCount, 2);
    for (const parcel of row.parcels) {
      assert.deepEqual(Object.keys(parcel).sort(), [
        'bigBoxCount',
        'destination',
        'documentCount',
        'mediumBoxCount',
        'orderParcelSeq',
        'origin',
        'otherItemDescription',
        'smallBoxCount',
        'status',
      ]);
      assert.deepEqual(Object.keys(parcel.origin).sort(), [
        'detailAddress',
        'jibunAddress',
        'name',
        'phoneNumber',
        'roadAddress',
      ]);
    }
    for (const q of [marker.toUpperCase() + ' 두번째 한글', marker + ' 도로_%', '010-9876-5433']) {
      const found = await (await screenOrders({ ...range, q })).json();
      assert.equal(found.total_count, 1);
      assert.deepEqual(
        found.data.map((o) => o.orderSeq),
        [id],
      );
      assert.equal(found.data[0].parcels.length, 2);
    }
    assert.deepEqual(await (await screenOrders({ ...range, offset: '100' })).json(), {
      data: [],
      hasNext: false,
      total_count: 2,
      statusCounts: {
        all: 2,
        incomplete: 0,
        notPaid: 0,
        paid: 0,
        submissionFailed: 0,
        cancelled: 0,
      },
    });
    assert.deepEqual(await (await screenOrders({ ...range, q: "' OR 1=1 --" })).json(), {
      data: [],
      hasNext: false,
      total_count: 0,
      statusCounts: {
        all: 0,
        incomplete: 0,
        notPaid: 0,
        paid: 0,
        submissionFailed: 0,
        cancelled: 0,
      },
    });
    for (let index = 0; index < 3; index++)
      assert.equal((await screenOrders(range, {}, index)).status, 200);
  });

  test('admin screen tabs group payment-complete states and retain actual receipt statuses', async () => {
    const { customer } = await readCustomer();
    const states = [
      'COLLECTING',
      'notPaid',
      'PAID',
      'SUBMITTING',
      'ACCEPTED',
      'SUBMITTING_FAILED',
      'SUBMISSION_FAILED',
      'CANCELLED',
    ];
    for (const status of states) {
      const id = await readOrder(customer, [
        { origin: address, destination: address, documentCount: 1, notifiedPrice: 1000 },
      ]);
      await pool.query(
        `UPDATE orders SET status=$2,total_amount=1000,created_at='2092-01-01T00:00:00Z',pickup_requested_at='2092-01-02T00:00:00Z',
      parcel_no=CASE WHEN $2='ACCEPTED' THEN 'SCRN0058' END,
      dver_received_at=CASE WHEN $2='ACCEPTED' THEN '2092-01-01T00:00:00Z'::timestamptz END WHERE order_seq=$1`,
        [id, status],
      );
    }
    for (const statusGroup of ['COLLECTING', 'notPaid', 'PAID', 'SUBMISSION_FAILED', 'CANCELLED']) {
      const body = await (
        await screenOrders({
          from: '2092-01-01T00:00:00Z',
          to: '2092-01-02T00:00:00Z',
          statusGroup,
        })
      ).json();
      const expected =
        statusGroup === 'PAID'
          ? ['PAID', 'SUBMITTING', 'ACCEPTED']
          : statusGroup === 'SUBMISSION_FAILED'
            ? ['SUBMITTING_FAILED', 'SUBMISSION_FAILED']
            : [statusGroup];
      assert.equal(body.total_count, expected.length);
      assert.deepEqual(body.statusCounts, {
        all: 8,
        incomplete: 0,
        notPaid: 1,
        paid: 3,
        submissionFailed: 2,
        cancelled: 1,
      });
      assert.ok(body.data.every((order) => order.parcels.length === 1));
      assert.deepEqual(body.data.map((o) => o.status).sort(), expected.sort());
    }
  });

  test('admin screen rejects AI access, invalid sessions and malformed query values and documents its exact projection', async () => {
    for (const headers of [
      { Cookie: '' },
      { Cookie: '', call_session_seq: '1' },
      { Cookie: 'dva_session=invalid' },
    ])
      await errorCode(await screenOrders({}, headers), 401, 'UNAUTHORIZED');
    for (const query of [
      { statusGroup: 'SUBMITTING' },
      { status: 'PAID' },
      { customerSeq: '1' },
      { limit: '0' },
      { offset: '-1' },
      { from: '2026-01-02T00:00:00Z', to: '2026-01-01T00:00:00Z' },
      { from: '2026-01-01' },
      { q: 'x'.repeat(201) },
    ])
      await errorCode(await screenOrders(query), 400, 'INVALID_REQUEST');
  });

  // Admin order edits: all states retain receipt/payment facts; fees follow active details.
  test('admins edit, append and remove details in all seven states and derive the total', async () => {
    resetDver();
    for (const [index, status] of [
      'COLLECTING',
      'notPaid',
      'PAID',
      'SUBMITTING',
      'ACCEPTED',
      'SUBMISSION_FAILED',
      'CANCELLED',
    ].entries()) {
      const order = await readyOrder({
        paymentMethodType: 'billing',
        parcels: [
          { origin: address, destination: address, documentCount: 1, notifiedPrice: 2500 },
          { origin: address, destination: address, smallBoxCount: 1, notifiedPrice: 3500 },
        ],
      });
      await pool.query(
        "UPDATE orders SET status=$2,parcel_no=$3,dver_received_at=$4,paid_at=$5,payment_due_at=CASE WHEN $2='notPaid' THEN clock_timestamp()+interval '1 day' ELSE NULL END,created_at=clock_timestamp()-interval '1 year' WHERE order_seq=$1",
        [
          order.orderSeq,
          status,
          status === 'ACCEPTED' ? 'ADM00030' : null,
          status === 'ACCEPTED' ? '2026-10-30T00:00:00Z' : null,
          ['COLLECTING', 'notPaid', 'CANCELLED'].includes(status) ? null : '2026-10-30T00:00:00Z',
        ],
      );
      const before = await storedOrder(order.orderSeq);
      const first = before.parcels[0],
        removed = before.parcels[1];
      const response = await patchOrder(
        order.orderSeq,
        {
          expectedVersion: before.version,
          parcels: [
            {
              orderParcelSeq: first.orderParcelSeq,
              destination: { name: '관리자 수정' },
              notifiedPrice: 3000,
            },
            { origin: address, destination: address, mediumBoxCount: 1, notifiedPrice: 4000 },
          ],
          removeParcelSeqs: [removed.orderParcelSeq],
        },
        {},
        index % 3,
      );
      assert.equal(response.status, 200, status + ': ' + (await response.clone().text()));
      const after = await storedOrder(order.orderSeq);
      assert.equal(after.status, status);
      assert.equal(after.paymentMethodType, before.paymentMethodType);
      assert.equal(after.paidAt, before.paidAt);
      assert.equal(after.parcelNo, before.parcelNo);
      assert.equal(after.dverReceivedAt, before.dverReceivedAt);
      assert.equal(after.parcels.length, 3);
      assert.equal(after.parcels[0].destination.name, '관리자 수정');
      assert.equal(after.parcels[1].status, 'CANCELLED');
      assert.deepEqual({ ...after.parcels[1], status: removed.status }, removed);
      assert.equal(after.totalAmount, status === 'CANCELLED' ? 0 : 7000);
      assert.equal(after.parcels[2].status, status === 'CANCELLED' ? 'CANCELLED' : 'ACTIVE');
      assert.equal((await response.json()).data.version, after.version);
      assert.ok(after.version > before.version);
      await errorCode(
        await patchOrder(order.orderSeq, {
          expectedVersion: before.version,
          removeParcelSeqs: [removed.orderParcelSeq],
        }),
        409,
        'VERSION_CONFLICT',
      );
    }
    assert.equal(suite.dverRequests.length, 0);
  });

  test('admin waiting-payment changes replace only changed amounts and keep the original expiry', async () => {
    const order = await readyOrder({ paymentMethodType: 'billing' });
    await pool.query(
      "UPDATE orders SET status='notPaid',payment_due_at=clock_timestamp()+interval '1 day' WHERE order_seq=$1",
      [order.orderSeq],
    );
    const request = (
      await pool.query(
        'INSERT INTO order_payment_requests(order_seq,amount,expires_at) SELECT order_seq,total_amount,payment_due_at FROM orders WHERE order_seq=$1 RETURNING *',
        [order.orderSeq],
      )
    ).rows[0];
    let before = await storedOrder(order.orderSeq);
    assert.equal(
      (
        await patchOrder(order.orderSeq, {
          expectedVersion: before.version,
          parcels: [
            {
              orderParcelSeq: before.parcels[0].orderParcelSeq,
              destination: { name: '주소만 변경' },
            },
          ],
        })
      ).status,
      200,
    );
    let after = await storedOrder(order.orderSeq);
    assert.equal(after.paymentRequest.paymentRequestId, request.payment_request_id);
    assert.equal(
      (
        await patchOrder(order.orderSeq, {
          expectedVersion: after.version,
          parcels: [{ orderParcelSeq: after.parcels[0].orderParcelSeq, notifiedPrice: 5000 }],
        })
      ).status,
      200,
    );
    after = await storedOrder(order.orderSeq);
    assert.equal(after.totalAmount, 5000);
    assert.equal(after.paymentRequest.amount, 5000);
    assert.notEqual(after.paymentRequest.paymentRequestId, request.payment_request_id);
    assert.equal(Date.parse(after.paymentRequest.expiresAt), request.expires_at.getTime());
    assert.ok(
      (
        await pool.query(
          'SELECT invalidated_at FROM order_payment_requests WHERE payment_request_id=$1',
          [request.payment_request_id],
        )
      ).rows[0].invalidated_at,
    );
    await pool.query(
      'UPDATE order_payment_requests SET approval_started_at=clock_timestamp() WHERE payment_request_id=$1',
      [after.paymentRequest.paymentRequestId],
    );
    before = await storedOrder(order.orderSeq);
    await errorCode(
      await patchOrder(order.orderSeq, {
        expectedVersion: before.version,
        removeParcelSeqs: [before.parcels[0].orderParcelSeq],
      }),
      409,
      'REQUEST_IN_PROGRESS',
    );
    assert.deepEqual(await storedOrder(order.orderSeq), before);
    await pool.query(
      'UPDATE order_payment_requests SET approval_started_at=NULL WHERE payment_request_id=$1',
      [after.paymentRequest.paymentRequestId],
    );
    assert.equal(
      (
        await patchOrder(order.orderSeq, {
          expectedVersion: before.version,
          removeParcelSeqs: [before.parcels[0].orderParcelSeq],
        })
      ).status,
      200,
    );
    after = await storedOrder(order.orderSeq);
    assert.equal(after.status, 'notPaid');
    assert.equal(after.totalAmount, 0);
    assert.equal(after.paymentRequest, null);
  });

  test('admin edits reject fee overflow, finalized missing fees and a mismatching caller total atomically', async () => {
    const order = await readyOrder({ paymentMethodType: 'billing' });
    await pool.query("UPDATE orders SET status='PAID' WHERE order_seq=$1", [order.orderSeq]);
    const before = await storedOrder(order.orderSeq);
    for (const change of [
      { parcels: [{ orderParcelSeq: before.parcels[0].orderParcelSeq, notifiedPrice: null }] },
      { parcels: [{ notifiedPrice: 2147483647 }] },
      {
        totalAmount: 4000,
        parcels: [{ orderParcelSeq: before.parcels[0].orderParcelSeq, notifiedPrice: 5000 }],
      },
    ]) {
      await errorCode(
        await patchOrder(order.orderSeq, { expectedVersion: before.version, ...change }),
        422,
        'VALIDATION_FAILED',
      );
      assert.deepEqual(await storedOrder(order.orderSeq), before);
    }
    await errorCode(
      await patchOrder(order.orderSeq, {
        expectedVersion: before.version,
        paymentMethodType: 'credit',
      }),
      409,
      'INVALID_STATE',
    );
    assert.deepEqual(await storedOrder(order.orderSeq), before);
  });

  test('admin detail removals preserve same-order scope and rollback fees, details, requests and audit on failure', async () => {
    const order = await readyOrder({ paymentMethodType: 'billing' }),
      foreign = await storedOrder((await readyOrder()).orderSeq);
    const before = await storedOrder(order.orderSeq);
    for (const id of [foreign.parcels[0].orderParcelSeq, 2147483647]) {
      await errorCode(
        await patchOrder(order.orderSeq, {
          expectedVersion: before.version,
          parcels: [{ notifiedPrice: 7000 }],
          removeParcelSeqs: [id],
        }),
        404,
        'NOT_FOUND',
      );
      assert.deepEqual(await storedOrder(order.orderSeq), before);
    }
    const audit = apps[0].get(AuditService),
      original = audit.recordSuccess;
    audit.recordSuccess = async function (...args) {
      if (args[0].action === 'ORDER_UPDATED') throw Error('admin-edit-rollback');
      return original.apply(this, args);
    };
    const audits = (
      await pool.query(
        "SELECT count(*)::int AS n FROM audit_logs WHERE target_type='ORDER' AND target_seq=$1 AND result='SUCCESS'",
        [order.orderSeq],
      )
    ).rows[0].n;
    try {
      assert.equal(
        (
          await patchOrder(order.orderSeq, {
            expectedVersion: before.version,
            parcels: [{ notifiedPrice: 7000 }],
            removeParcelSeqs: [before.parcels[0].orderParcelSeq],
          })
        ).status,
        500,
      );
    } finally {
      audit.recordSuccess = original;
    }
    assert.deepEqual(await storedOrder(order.orderSeq), before);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM audit_logs WHERE target_type='ORDER' AND target_seq=$1 AND result='SUCCESS'",
          [order.orderSeq],
        )
      ).rows[0].n,
      audits,
    );
  });

  test('AI cannot use admin removals and admin database permission never survives its transaction', async () => {
    const order = await readyOrder({ paymentMethodType: 'billing' }),
      before = await storedOrder(order.orderSeq),
      callId = await call('01000000003');
    await errorCode(
      await patchOrder(
        order.orderSeq,
        { expectedVersion: before.version, removeParcelSeqs: [before.parcels[0].orderParcelSeq] },
        aiReadHeaders(callId),
      ),
      403,
      'FORBIDDEN',
    );
    assert.deepEqual(await storedOrder(order.orderSeq), before);
    await pool.query("UPDATE orders SET status='PAID' WHERE order_seq=$1", [order.orderSeq]);
    let detail = await storedOrder(order.orderSeq);
    const sql = 'UPDATE order_parcels SET client_comment=$2 WHERE order_parcel_seq=$1';
    await assert.rejects(
      () => pool.query(sql, [detail.parcels[0].orderParcelSeq, 'raw write forbidden']),
      { code: '23514' },
    );
    assert.equal(
      (
        await patchOrder(order.orderSeq, {
          expectedVersion: detail.version,
          parcels: [
            { orderParcelSeq: detail.parcels[0].orderParcelSeq, clientComment: 'admin saved' },
          ],
        })
      ).status,
      200,
    );
    await assert.rejects(
      () => pool.query(sql, [detail.parcels[0].orderParcelSeq, 'raw write still forbidden']),
      { code: '23514' },
    );
    detail = await storedOrder(order.orderSeq);
    assert.equal(detail.parcels[0].clientComment, 'admin saved');
  });

  test('concurrent admin edits of a finalized order have one winner and retain amount consistency', async () => {
    const order = await readyOrder({ paymentMethodType: 'billing' });
    await pool.query("UPDATE orders SET status='PAID' WHERE order_seq=$1", [order.orderSeq]);
    const before = await storedOrder(order.orderSeq);
    const responses = await Promise.all(
      [0, 1].map((index) =>
        patchOrder(
          order.orderSeq,
          {
            expectedVersion: before.version,
            parcels: [
              {
                orderParcelSeq: before.parcels[0].orderParcelSeq,
                notifiedPrice: 4000 + index * 1000,
              },
            ],
          },
          {},
          index,
        ),
      ),
    );
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
    const after = await storedOrder(order.orderSeq);
    assert.equal(after.totalAmount, after.parcels[0].notifiedPrice);
    assert.equal(after.status, 'PAID');
  });
};
