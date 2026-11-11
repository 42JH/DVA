require('reflect-metadata');
const { after, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createServer } = require('node:http');
const { applicationFixture, businessHeaders } = require('./helpers/application.cjs');
const { DverClient } = require('../dist/orders/dver.client');
const { PaymentsWorker } = require('../dist/payments/payments.worker');
const { PaymentCardsService } = require('../dist/payments/payment-cards.service');
const { OrderCardPaymentsService } = require('../dist/orders/order-card-payments.service');

let server,
  approvalEntered,
  approvalGate,
  pgMode = 'success',
  registrationMode = 'success',
  dverCount = 0;
const charges = new Map(),
  pgRequests = [],
  messages = [];
process.env.ORDER_PAYMENTS_ENABLED = 'true';
process.env.PAYMENT_PUBLIC_URL = 'http://localhost:5173/api/payments';
process.env.TOSS_TEST_CLIENT_KEY = 'test_gck_cards';
process.env.TOSS_TEST_SECRET_KEY = 'test_gsk_cards';
process.env.TOSS_BILLING_SECRET_KEY = 'test_sk_cards';
process.env.PAYMENT_CARD_ENCRYPTION_KEY = 'ab'.repeat(32);
async function setupPg() {
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    pgRequests.push({
      method: req.method,
      path: req.url,
      body,
      key: req.headers['idempotency-key'],
    });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/hooks/cards') {
      messages.push(body.text);
      res.setHeader('Content-Type', 'text/plain');
      return res.end('ok');
    }
    if (req.url === '/v1/billing/authorizations/card') {
      if (registrationMode === 'decline') {
        res.statusCode = 400;
        return res.end(JSON.stringify({ code: 'INVALID_CARD_IDENTITY' }));
      }
      return res.end(
        JSON.stringify({
          billingKey: 'billing-' + body.customerKey,
          customerKey: body.customerKey,
          card: { issuerCode: '61' },
        }),
      );
    }
    if (req.method === 'DELETE') return res.end('{}');
    if (req.method === 'GET') {
      const orderId = req.url.split('/').at(-1);
      if (!charges.has(orderId)) {
        res.statusCode = 404;
        return res.end(JSON.stringify({ code: 'NOT_FOUND_PAYMENT' }));
      }
      return res.end(JSON.stringify(charges.get(orderId)));
    }
    if (pgMode === 'decline') {
      res.statusCode = 400;
      return res.end(JSON.stringify({ code: 'REJECT_CARD_PAYMENT' }));
    }
    if (pgMode === 'unauthorized') {
      res.statusCode = 401;
      return res.end(JSON.stringify({ code: 'UNAUTHORIZED_KEY' }));
    }
    if (pgMode === 'hold') {
      approvalEntered();
      await approvalGate;
    }
    const value = {
      orderId: body.orderId,
      totalAmount: body.amount,
      paymentKey: 'paid-' + body.orderId,
      currency: 'KRW',
      status: 'DONE',
      approvedAt: new Date().toISOString(),
    };
    charges.set(body.orderId, value);
    if (pgMode === 'lost') {
      req.socket.destroy();
      return;
    }
    res.end(JSON.stringify(value));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.PAYMENT_TOSS_BASE_URL = 'http://127.0.0.1:' + server.address().port;
  process.env.PAYMENT_MATTERMOST_WEBHOOK_URL = process.env.PAYMENT_TOSS_BASE_URL + '/hooks/cards';
}
const f = applicationFixture('카드 결제 검증');
const start = f.start;
f.start = async () => {
  if (!server) await setupPg();
  const app = await start();
  const dver = app.get(DverClient);
  dver.ensureConfigured = () => {};
  dver.submit = async () => {
    dverCount++;
    return {
      status: 'ACCEPTED',
      parcelNo: 'CARD' + String(dverCount).padStart(4, '0'),
      receivedAt: new Date().toISOString(),
    };
  };
  return app;
};
beforeEach(() => {
  pgMode = 'success';
  registrationMode = 'success';
});
after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});
const input = () => ({
  cardNumber: '4111111111111111',
  expirationYear: new Date().getUTCFullYear() + 2,
  expirationMonth: 12,
  customerIdentityNumber: '900101',
  cardPassword: '00',
});
async function customer() {
  const phone = '010' + String(Math.floor(Math.random() * 90000000) + 10000000);
  const id = (
    await f.pool.query(
      "INSERT INTO customers(name,phone_number,status) VALUES('카드 고객',$1,'ACTIVE') RETURNING customer_seq",
      [phone],
    )
  ).rows[0].customer_seq;
  return { id, phone };
}
async function json(response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return (await response.json()).data;
}
function register(kind, id, actor = 0, key = randomUUID(), body = input(), headers = {}) {
  return f.write(
    'PUT',
    '/api/' +
      (kind === 'CUSTOMER' ? 'customers/' + id + '/card' : 'companies/' + id + '/group-card'),
    body,
    actor,
    { 'Idempotency-Key': key, ...headers },
  );
}
function orderBody(id, method = 'billing') {
  const address = {
    name: '카드 테스트',
    phoneNumber: '01012345678',
    roadAddress: '검증로 1',
    jibunAddress: '검증동 1',
    dongName: '검증동',
    detailAddress: '',
    postalCode: '12345',
  };
  return {
    customerSeq: id,
    ...(method ? { paymentMethodType: method } : {}),
    totalAmount: 5000,
    pickupRequestedAt: new Date(Date.now() + 86400000).toISOString(),
    parcels: [
      {
        origin: address,
        destination: address,
        smallBoxCount: 1,
        itemPrice: 1000,
        notifiedPrice: 5000,
      },
    ],
  };
}
function createOrder(id, method = 'billing', key = randomUUID()) {
  return f.write('POST', '/api/admin/orders', orderBody(id, method), 0, { 'Idempotency-Key': key });
}
const approvals = () =>
  pgRequests.filter(
    (r) =>
      r.method === 'POST' &&
      r.path.startsWith('/v1/billing/') &&
      r.path !== '/v1/billing/authorizations/card',
  );

test('card registration accepts every existing administrator role and stores only encrypted payment credentials', async () => {
  for (let role = 0; role < 3; role++) {
    const owner = await customer(),
      key = randomUUID(),
      body = input();
    const before = pgRequests.length;
    const card = await json(await register('CUSTOMER', owner.id, role, key, body));
    assert.equal(card.active, true);
    assert.equal(card.maskedNumber, '************1111');
    assert.deepEqual(await json(await register('CUSTOMER', owner.id, role, key, body)), card);
    assert.equal(pgRequests.length, before + 1);
    const stored = (
      await f.pool.query('SELECT * FROM payment_cards WHERE payment_card_seq=$1', [
        card.paymentCardSeq,
      ])
    ).rows[0];
    assert.ok(stored.encrypted_billing_key);
    assert.ok(!stored.encrypted_billing_key.includes('billing-'));
    assert.ok(!JSON.stringify(stored).includes(body.cardNumber));
    assert.ok(!JSON.stringify(f.logs).includes(body.cardNumber));
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*)::int AS n FROM audit_logs WHERE target_type='PAYMENT_CARD' AND target_seq=$1 AND action='PAYMENT_CARD_REGISTERED'",
          [card.paymentCardSeq],
        )
      ).rows[0].n,
      1,
    );
    await f.error(
      await register('CUSTOMER', owner.id, role, key, { ...body, expirationMonth: 11 }),
      409,
      'EVENT_PAYLOAD_CONFLICT',
    );
  }
});

test('card Bearer access and administrator sessions coexist with caller scope and invalid-session precedence', async () => {
  const owner = await customer(),
    other = await customer();
  const call = (
    await f.pool.query(
      'INSERT INTO call_sessions(provider_call_id,customer_seq,caller_phone_number,incoming_at) VALUES($1,$2,$3,now()) RETURNING call_session_seq',
      [randomUUID(), owner.id, owner.phone],
    )
  ).rows[0].call_session_seq;
  const headers = { Cookie: undefined, ...businessHeaders(), call_session_seq: String(call) };
  await json(await register('CUSTOMER', owner.id, 0, randomUUID(), input(), headers));
  await f.error(
    await register('CUSTOMER', other.id, 0, randomUUID(), input(), headers),
    403,
    'FORBIDDEN',
  );
  await f.error(
    await register('CUSTOMER', owner.id, 0, randomUUID(), input(), {
      ...headers,
      call_session_seq: undefined,
    }),
    400,
    'INVALID_REQUEST',
  );
  await f.error(
    await register('CUSTOMER', owner.id, 0, randomUUID(), input(), {
      ...headers,
      Cookie: 'dva_session=invalid',
    }),
    401,
    'UNAUTHORIZED',
  );
  await f.error(
    await register('CUSTOMER', owner.id, 0, randomUUID(), input(), { Cookie: undefined }),
    401,
    'UNAUTHORIZED',
  );
  assert.ok((await json(await f.get('/api/customers/' + owner.id + '/card'))).maskedNumber);
});

test('billing without a card keeps its original link after a later registration and new billing orders use one automatic approval', async () => {
  const owner = await customer();
  const pending = await json(await createOrder(owner.id), 201);
  assert.equal(pending.status, 'notPaid');
  assert.equal(pending.paymentRequest.autoCharge, false);
  await f.app.get(PaymentsWorker).run();
  assert.ok(messages.some((m) => m.includes('/p/' + pending.paymentRequest.paymentRequestId)));
  await json(await register('CUSTOMER', owner.id));
  await f.app.get(PaymentsWorker).run();
  assert.equal(
    (await f.pool.query('SELECT status FROM orders WHERE order_seq=$1', [pending.orderSeq])).rows[0]
      .status,
    'notPaid',
  );
  const key = randomUUID(),
    before = approvals().length;
  const paid = await json(await createOrder(owner.id, 'billing', key), 201);
  assert.equal(paid.status, 'ACCEPTED');
  assert.equal(
    (await json(await createOrder(owner.id, 'billing', key), 201)).orderSeq,
    paid.orderSeq,
  );
  assert.equal(approvals().length, before + 1);
  assert.equal(
    (
      await f.pool.query(
        "SELECT count(*)::int AS n FROM audit_logs WHERE target_seq=$1 AND action='ORDER_PAYMENT_COMPLETED'",
        [paid.orderSeq],
      )
    ).rows[0].n,
    1,
  );
});

test('group selection requires a registered company card and employee permission while departments do not gate it', async () => {
  const owner = await customer();
  const company = await json(
    await f.write('POST', '/api/companies', {
      name: '등록 카드 기업',
      members: [
        {
          name: '카드 고객',
          phoneNumber: owner.phone,
          employeeNo: '001',
          groupBillingEnabled: true,
        },
      ],
    }),
    201,
  );
  const id = company.organizationSeq;
  assert.equal((await json(await f.get('/api/companies/' + id))).groupCardRegistered, false);
  await f.error(await createOrder(owner.id, 'groupBilling'), 403, 'FORBIDDEN');
  await json(await register('ORGANIZATION', id));
  assert.equal((await json(await f.get('/api/companies/' + id))).groupCardRegistered, true);
  const context = await json(
    await f.write('POST', '/api/customers/context', { phoneNumber: owner.phone }),
  );
  assert.ok(context.availablePaymentMethods.includes('groupBilling'));
  assert.equal(context.organization.groupCardRegistered, true);
  const group = await json(await createOrder(owner.id, 'groupBilling'), 201);
  assert.equal(group.status, 'ACCEPTED');
  const totals = await json(await f.get('/api/companies/' + id + '/billing'));
  assert.equal(totals.groupBillingAmount, 5000);
  assert.equal(totals.monthlyAmount, 0);
  const monthly = await json(await createOrder(owner.id, null), 201);
  assert.equal(monthly.status, 'ACCEPTED');
  assert.equal(
    (
      await f.pool.query('SELECT payment_method_type FROM orders WHERE order_seq=$1', [
        monthly.orderSeq,
      ])
    ).rows[0].payment_method_type,
    'credit',
  );
  const members = await f.get('/api/companies/' + id + '/members').then((r) => r.json());
  const member = members.data[0].membership;
  assert.equal(member.departmentSeq, null);
  await f.pool.query('UPDATE payment_cards SET expiration_year=2000 WHERE organization_seq=$1', [
    id,
  ]);
  assert.equal((await json(await f.get('/api/companies/' + id))).groupCardRegistered, false);
  await f.error(await createOrder(owner.id, 'groupBilling'), 403, 'FORBIDDEN');
  await f.pool.query('UPDATE payment_cards SET expiration_year=$2 WHERE organization_seq=$1', [
    id,
    input().expirationYear,
  ]);
  await f.write('PATCH', '/api/companies/' + id + '/members', {
    membershipSeqs: [member.membershipSeq],
    groupBillingEnabled: false,
    monthlyBillingEnabled: false,
  });
  await f.error(await createOrder(owner.id, 'groupBilling'), 403, 'FORBIDDEN');
  await f.error(await createOrder(owner.id, 'credit'), 403, 'FORBIDDEN');
  const restricted = await json(
    await f.write('POST', '/api/customers/context', { phoneNumber: owner.phone }),
  );
  assert.equal(restricted.organization.monthlyBillingEnabled, true);
  assert.equal(restricted.membership.monthlyBillingEnabled, false);
  assert.deepEqual(restricted.availablePaymentMethods, ['billing']);
  assert.equal((await f.write('DELETE', '/api/companies/' + id + '/group-card')).status, 204);
  assert.equal(await json(await f.get('/api/companies/' + id + '/group-card')), null);
  assert.equal((await json(await f.get('/api/companies/' + id))).groupCardRegistered, false);
});

test('separate application instances cannot approve the same registered card payment twice', async () => {
  const owner = await customer();
  await json(await register('CUSTOMER', owner.id));
  let release;
  const entered = new Promise((resolve) => {
    approvalEntered = resolve;
  });
  approvalGate = new Promise((resolve) => {
    release = resolve;
  });
  pgMode = 'hold';
  const before = approvals().length;
  const creating = createOrder(owner.id);
  try {
    await entered;
    const id = (
      await f.pool.query(
        'SELECT r.payment_request_id FROM order_payment_requests r JOIN orders o USING(order_seq) WHERE o.customer_seq=$1 AND r.completed_at IS NULL',
        [owner.id],
      )
    ).rows[0].payment_request_id;
    const peer = await f.start();
    await assert.rejects(
      peer.get(OrderCardPaymentsService).process(id, randomUUID()),
      (error) => error.status === 409,
    );
    assert.equal(approvals().length, before + 1);
  } finally {
    release();
  }
  const completed = await json(await creating, 201);
  assert.equal(completed.status, 'ACCEPTED');
  assert.equal(approvals().length, before + 1);
});

test('a lost card approval response is recovered by merchant order lookup without a second approval', async () => {
  const owner = await customer();
  await json(await register('CUSTOMER', owner.id));
  const before = approvals().length;
  pgMode = 'lost';
  const result = await json(await createOrder(owner.id), 201);
  assert.equal(result.status, 'notPaid');
  assert.equal(result.paymentRequest.autoCharge, true);
  const id = result.paymentRequest.paymentRequestId;
  const state = await json(
    await f.write('POST', '/api/payments/requests/' + id + '/reconcile', {}),
  );
  assert.equal(state.status, 'PAID');
  assert.equal(approvals().length, before + 1);
  assert.equal(
    (await f.pool.query('SELECT status FROM orders WHERE order_seq=$1', [result.orderSeq])).rows[0]
      .status,
    'ACCEPTED',
  );
  pgMode = 'unauthorized';
  const denied = await json(await createOrder(owner.id), 201);
  assert.equal(denied.paymentRequest.cardPaymentFailed, false);
  const attempted = approvals().length;
  await f.error(
    await f.write(
      'POST',
      '/api/payments/requests/' + denied.paymentRequest.paymentRequestId + '/reconcile',
      {},
    ),
    502,
    'PAYMENT_RESULT_UNKNOWN',
  );
  assert.equal(approvals().length, attempted);
});

test('a confirmed card decline leaves the order unpaid and retries only on an explicit request with a replacement card', async () => {
  const owner = await customer();
  await json(await register('CUSTOMER', owner.id));
  pgMode = 'decline';
  const result = await json(await createOrder(owner.id), 201);
  assert.equal(result.status, 'notPaid');
  assert.equal(result.paymentRequest.cardPaymentFailed, true);
  const before = approvals().length;
  await f.app.get(PaymentsWorker).run();
  assert.equal(approvals().length, before);
  await f.error(
    await f.write(
      'POST',
      '/api/payments/requests/' + result.paymentRequest.paymentRequestId + '/reconcile',
      {},
    ),
    409,
    'INVALID_STATE',
  );
  await json(
    await register('CUSTOMER', owner.id, 0, randomUUID(), {
      ...input(),
      cardNumber: '4000000000000002',
    }),
  );
  pgMode = 'success';
  const state = await json(
    await f.write(
      'POST',
      '/api/payments/requests/' + result.paymentRequest.paymentRequestId + '/reconcile',
      {},
    ),
  );
  assert.equal(state.status, 'PAID');
  assert.equal(approvals().length, before + 1);
});

test('replacement, registration failure and owner deletion preserve audit records and soft deletion', async () => {
  const owner = await customer();
  const old = await json(await register('CUSTOMER', owner.id));
  registrationMode = 'decline';
  await f.error(await register('CUSTOMER', owner.id), 422, 'VALIDATION_FAILED');
  assert.equal(
    (await json(await f.get('/api/customers/' + owner.id + '/card'))).paymentCardSeq,
    old.paymentCardSeq,
  );
  registrationMode = 'success';
  const current = await json(await register('CUSTOMER', owner.id));
  assert.notEqual(current.paymentCardSeq, old.paymentCardSeq);
  assert.ok(
    (
      await f.pool.query('SELECT deleted_at FROM payment_cards WHERE payment_card_seq=$1', [
        old.paymentCardSeq,
      ])
    ).rows[0].deleted_at,
  );
  assert.equal(
    (await f.write('DELETE', '/api/customers', { customerSeqs: [owner.id] })).status,
    204,
  );
  assert.ok(
    (
      await f.pool.query('SELECT deleted_at FROM payment_cards WHERE payment_card_seq=$1', [
        current.paymentCardSeq,
      ])
    ).rows[0].deleted_at,
  );
  await f.app.get(PaymentCardsService).revokeDeleted(randomUUID());
  assert.ok(
    (
      await f.pool.query(
        "SELECT count(*)::int AS n FROM audit_logs WHERE target_type='PAYMENT_CARD' AND action='PAYMENT_CARD_DELETED' AND target_seq=ANY($1::int[])",
        [[old.paymentCardSeq, current.paymentCardSeq]],
      )
    ).rows[0].n >= 2,
  );
});
