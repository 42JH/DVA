module.exports = function registerOrdersCallContext(suite) {
  const { businessHeaders } = require('./helpers/application.cjs');
  const {
    test,
    readCustomer,
    readOrder,
    counts,
    startCallContext,
    contextCall,
    assert,
    aiReadHeaders,
    readOrders,
    readDetail,
    hosts,
    pool,
    errorCode,
    address,
    resetDver,
    aiResult,
    randomUUID,
    aiCreate,
    origin,
    apps,
  } = suite;
  test('call context starts a session before AI reads and cancels an existing order', async () => {
    const { customer, phone } = await readCustomer();
    const orderId = await readOrder(customer, [{}]);
    const before = await counts();
    const response = await startCallContext(phone, contextCall());
    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.equal(data.customer.customerSeq, customer);
    assert.ok(Number.isInteger(data.callSessionSeq) && data.callSessionSeq > 0);
    assert.deepEqual(await counts(), before);
    const headers = aiReadHeaders(data.callSessionSeq);
    const list = await readOrders('', headers);
    assert.equal(list.status, 200);
    assert.deepEqual(
      (await list.json()).data.map((order) => order.orderSeq),
      [orderId],
    );
    const detail = await readDetail(orderId, headers);
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).data.customerSeq, customer);
    const cancelled = await fetch(hosts[0] + `/api/orders/${orderId}/cancel`, {
      method: 'POST',
      headers: { call_session_seq: String(data.callSessionSeq) },
    });
    assert.equal(cancelled.status, 204);
    assert.equal((await (await readDetail(orderId, headers)).json()).data.status, 'CANCELLED');
    const session = (
      await pool.query('SELECT order_seq FROM call_sessions WHERE call_session_seq=$1', [
        data.callSessionSeq,
      ])
    ).rows[0];
    assert.equal(session.order_seq, null);
  });

  test('call context reuses one session across retries and rejects changed caller or event time', async () => {
    const { phone } = await readCustomer();
    const identity = contextCall();
    const responses = await Promise.all(
      [0, 1, 2].map((index) => startCallContext(phone, identity, index)),
    );
    assert.ok(responses.every((response) => response.status === 200));
    const ids = await Promise.all(
      responses.map(async (response) => (await response.json()).data.callSessionSeq),
    );
    assert.equal(new Set(ids).size, 1);
    const starts = (
      await pool.query(
        "SELECT actor_type,actor_name FROM audit_logs WHERE target_type='CALL_SESSION' AND target_seq=$1 AND action='CALL_STARTED'",
        [ids[0]],
      )
    ).rows;
    assert.deepEqual(starts, [{ actor_type: 'AI', actor_name: 'AI' }]);
    const sameInstant = {
      ...identity,
      incomingAt: new Date(Date.parse(identity.incomingAt) + 9 * 3600000)
        .toISOString()
        .replace('Z', '+09:00'),
    };
    const repeated = await startCallContext(phone, sameInstant);
    assert.equal(repeated.status, 200);
    assert.equal((await repeated.json()).data.callSessionSeq, ids[0]);
    const international = await startCallContext('0082' + phone.slice(1), identity);
    assert.equal(international.status, 200);
    const internationalData = (await international.json()).data;
    assert.equal(internationalData.callSessionSeq, ids[0]);
    assert.equal(internationalData.customer.phoneNumber, phone);
    await errorCode(await startCallContext('01099990000', identity), 409, 'INVALID_STATE');
    await errorCode(
      await startCallContext(phone, {
        ...identity,
        incomingAt: new Date(Date.parse(identity.incomingAt) + 1000).toISOString(),
      }),
      409,
      'INVALID_STATE',
    );
    const stored = (
      await pool.query(
        'SELECT call_session_seq,caller_phone_number,incoming_at,order_seq FROM call_sessions WHERE provider_call_id=$1',
        [identity.providerCallId],
      )
    ).rows;
    assert.equal(stored.length, 1);
    assert.equal(stored[0].call_session_seq, ids[0]);
    assert.equal(stored[0].caller_phone_number, phone);
    assert.equal(stored[0].incoming_at.toISOString(), identity.incomingAt);
    assert.equal(stored[0].order_seq, null);
    const another = await startCallContext(phone, contextCall());
    assert.equal(another.status, 200);
    assert.notEqual((await another.json()).data.callSessionSeq, ids[0]);
  });

  test('call context preserves customer scope for orders and personal address changes', async () => {
    const { customer, phone } = await readCustomer();
    const other = await readCustomer();
    const otherOrder = await readOrder(other.customer);
    const response = await startCallContext(phone, contextCall());
    assert.equal(response.status, 200);
    const { callSessionSeq } = (await response.json()).data;
    const headers = {
      'Content-Type': 'application/json',
      call_session_seq: String(callSessionSeq),
    };
    await errorCode(await readDetail(otherOrder, aiReadHeaders(callSessionSeq)), 404, 'NOT_FOUND');
    await errorCode(
      await fetch(hosts[0] + `/api/orders/${otherOrder}/cancel`, { method: 'POST', headers }),
      404,
      'NOT_FOUND',
    );
    const pinResponse = await fetch(hosts[0] + `/api/customers/${customer}/pins`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ label: '통화 주소', addressData: address }),
    });
    assert.equal(pinResponse.status, 201);
    const pinId = (await pinResponse.json()).data.personalPinSeq;
    const changed = await fetch(hosts[0] + `/api/pins/${pinId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ label: '수정 주소' }),
    });
    assert.equal(changed.status, 200);
    const pins = await fetch(hosts[0] + `/api/customers/${customer}/pins`, { headers });
    assert.equal(pins.status, 200);
    assert.equal((await pins.json()).data[0].label, '수정 주소');
    await errorCode(
      await fetch(hosts[0] + `/api/customers/${other.customer}/pins`, { headers }),
      403,
      'FORBIDDEN',
    );
  });

  test('call context does not register unknown or withdrawn customers and supports registration later', async () => {
    const phone = '01099117733';
    const before = await counts();
    const response = await startCallContext(phone, contextCall());
    assert.equal(response.status, 200);
    const data = (await response.json()).data;
    assert.equal(data.lookupStatus, 'UNREGISTERED');
    assert.equal(data.customer, null);
    assert.ok(data.callSessionSeq > 0);
    assert.deepEqual(await counts(), before);
    await errorCode(await readOrders('', aiReadHeaders(data.callSessionSeq)), 403, 'FORBIDDEN');
    const registered = await fetch(hosts[0] + '/api/customers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...businessHeaders() },
      body: JSON.stringify({ name: '통화 중 등록', phoneNumber: phone }),
    });
    assert.equal(registered.status, 201);
    const list = await readOrders('', aiReadHeaders(data.callSessionSeq));
    assert.equal(list.status, 200);
    assert.deepEqual((await list.json()).data, []);
    const withdrawn = await startCallContext('01000000002', contextCall());
    assert.equal(withdrawn.status, 200);
    const withdrawnData = (await withdrawn.json()).data;
    assert.equal(withdrawnData.lookupStatus, 'WITHDRAWN');
    assert.equal(withdrawnData.customer, null);
    assert.ok(withdrawnData.callSessionSeq > 0);
    await errorCode(
      await readOrders('', aiReadHeaders(withdrawnData.callSessionSeq)),
      403,
      'FORBIDDEN',
    );
  });

  test('call context and every AI order outcome share the same session without changing the result contract', async () => {
    for (const outcome of ['COMPLETE', 'INCOMPLETE', 'CANCELLED']) {
      resetDver();
      const { customer, phone } = await readCustomer();
      const identity = contextCall();
      const initial = await startCallContext(phone, identity);
      assert.equal(initial.status, 200);
      const callSessionSeq = (await initial.json()).data.callSessionSeq;
      const input = aiResult(outcome, {
        customerSeq: customer,
        call: { ...identity, callerPhoneNumber: '+82' + phone.slice(1) },
      });
      const key = randomUUID();
      const result = await aiCreate(undefined, input, key);
      assert.equal(result.status, 201);
      const data = (await result.json()).data;
      assert.equal(data.callSessionSeq, callSessionSeq);
      assert.equal(
        data.status,
        { COMPLETE: 'ACCEPTED', INCOMPLETE: 'COLLECTING', CANCELLED: 'CANCELLED' }[outcome],
      );
      const retried = await aiCreate(undefined, input, key, 1);
      assert.deepEqual((await retried.json()).data, data);
      const contextAgain = await startCallContext(phone, identity, 1);
      assert.equal(contextAgain.status, 200);
      assert.equal((await contextAgain.json()).data.callSessionSeq, callSessionSeq);
      const sessions = (
        await pool.query(
          'SELECT call_session_seq,order_seq FROM call_sessions WHERE provider_call_id=$1',
          [identity.providerCallId],
        )
      ).rows;
      assert.deepEqual(sessions, [{ call_session_seq: callSessionSeq, order_seq: data.orderSeq }]);
      assert.equal(suite.dverRequests.length, outcome === 'COMPLETE' ? 1 : 0);
    }
  });

  test('call context rejects malformed identities and untrusted cookies without persisting a session', async () => {
    const before = (await pool.query('SELECT count(*) FROM call_sessions')).rows[0].count;
    const identity = contextCall();
    for (const invalid of [
      null,
      [],
      '',
      {},
      { providerCallId: identity.providerCallId },
      { incomingAt: identity.incomingAt },
      { ...identity, providerCallId: '' },
      { ...identity, providerCallId: 'x'.repeat(201) },
      { ...identity, providerCallId: 'call id' },
      { ...identity, providerCallId: 'call\u0000id' },
      { ...identity, incomingAt: '2026-02-30T01:00:00Z' },
      { ...identity, incomingAt: '2026-10-29T01:00:00' },
      { ...identity, incomingAt: null },
      { ...identity, callerPhoneNumber: '01099990000' },
      { ...identity, orderSeq: 1 },
    ])
      await errorCode(await startCallContext('01000000001', invalid), 400, 'INVALID_REQUEST');
    for (const phone of ['12', '0'.repeat(21)])
      await errorCode(await startCallContext(phone, identity), 400, 'INVALID_REQUEST');
    await errorCode(
      await startCallContext('01000000001', identity, 0, {
        Cookie: 'dva_session=expired',
        Origin: origin,
      }),
      401,
      'UNAUTHORIZED',
    );
    await errorCode(
      await startCallContext('01000000001', identity, 0, {
        Origin: 'https://untrusted.invalid',
      }),
      403,
      'FORBIDDEN',
    );
    assert.equal((await pool.query('SELECT count(*) FROM call_sessions')).rows[0].count, before);
  });

  test('call context rolls back a new session if the customer lookup fails', async () => {
    const { CustomersRepository } = require('../dist/customers/customers.repository');
    const customers = apps[0].get(CustomersRepository);
    const original = customers.context;
    const identity = contextCall();
    customers.context = async function (...args) {
      await original.apply(this, args);
      throw new Error('private-query-data');
    };
    try {
      const response = await startCallContext('01000000001', identity);
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.error.code, 'DEPENDENCY_UNAVAILABLE');
      assert.ok(!JSON.stringify(body).includes('private-query-data'));
      assert.equal(body.data, undefined);
    } finally {
      customers.context = original;
    }
    assert.equal(
      (
        await pool.query('SELECT count(*) FROM call_sessions WHERE provider_call_id=$1', [
          identity.providerCallId,
        ])
      ).rows[0].count,
      '0',
    );
  });
};
