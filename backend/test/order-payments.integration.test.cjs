require('reflect-metadata');
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { createTestPool, startTestApp } = require('./helpers/application.cjs');
const { NestFactory } = require('@nestjs/core');
const { ConfigService } = require('@nestjs/config');
const { migrate } = require('./helpers/migrations.cjs');
const { hashPassword } = require('../dist/auth/password');
const { PaymentsService } = require('../dist/payments/payments.service');
const { PaymentsRepository } = require('../dist/payments/payments.repository');
const { PaymentsWorker } = require('../dist/payments/payments.worker');
const { PaymentClient } = require('../dist/payments/payment.client');
const { OrderPaymentsService } = require('../dist/orders/order-payments.service');
const { OrderPaymentsRepository } = require('../dist/orders/order-payments.repository');
const { OrderMaintenanceWorker } = require('../dist/orders/order-maintenance.worker');
const { AuditService } = require('../dist/audit/audit.service');
const { testMembership } = require('./helpers/membership.cjs');

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.DB_NAME, 'dva_webhook_test');
assert.ok(['127.0.0.1', 'db'].includes(process.env.DB_HOST));
const pool = createTestPool();
const apps = [];
let app, upstream, base, origin, cookie, customerId, worker, payments, client;
const calls = [],
  messages = [],
  parcels = [],
  providerPayments = new Map(),
  approvalResponses = new Map();
let rejectDver = false,
  messageMode = 'ok';
const adminOrigin = 'http://127.0.0.1:5173';
before(async () => {
  await migrate(pool);
  upstream = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const json = (code, value) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.url === '/hooks/payment') {
      messages.push(body.text);
      if (messageMode === 'timeout') return;
      res.writeHead(messageMode === 'reject' ? 403 : 200);
      return res.end(messageMode === 'reject' ? 'denied' : 'ok');
    }
    if (req.url === '/parcel') {
      assert.equal(req.headers['x-api-key'], 'dver-fixture');
      parcels.push(body);
      return json(
        rejectDver ? 400 : 200,
        rejectDver
          ? { ok: false }
          : { ok: true, parcelNo: 'PAY02101', receivedAt: new Date().toISOString() },
      );
    }
    assert.equal(
      req.headers.authorization,
      'Basic ' + Buffer.from('test_gsk_fixture:').toString('base64'),
    );
    calls.push({
      method: req.method,
      path: req.url,
      body,
      receipt: req.headers['idempotency-key'],
    });
    if (req.method === 'POST' && req.url === '/v1/payments/confirm') {
      const receipt = req.headers['idempotency-key'];
      assert.ok(typeof receipt === 'string' && receipt.length > 0 && receipt.length <= 300);
      if (approvalResponses.has(receipt)) {
        const cached = approvalResponses.get(receipt);
        return json(cached.status, cached.data);
      }
      const respond = (status, data) => {
        approvalResponses.set(receipt, { status, data });
        return json(status, data);
      };
      if (body.paymentKey.startsWith('reject_'))
        return respond(403, { code: 'REJECT_CARD_PAYMENT' });
      if (body.paymentKey.startsWith('missing_'))
        return respond(404, { code: 'NOT_FOUND_PAYMENT' });
      if (body.paymentKey.startsWith('expired_session_'))
        return respond(404, { code: 'NOT_FOUND_PAYMENT_SESSION' });
      if (body.paymentKey.startsWith('unknown_missing_'))
        return respond(500, { code: 'PROVIDER_ERROR' });
      if (body.paymentKey.startsWith('unauthorized_'))
        return respond(401, { code: 'UNAUTHORIZED_KEY' });
      const p = {
        orderId: body.orderId,
        paymentKey: body.paymentKey,
        totalAmount: body.amount,
        currency: 'KRW',
        status: body.paymentKey.startsWith('pending_') ? 'IN_PROGRESS' : 'DONE',
        approvedAt: body.paymentKey.startsWith('pending_')
          ? null
          : new Date(Date.now() - 5000).toISOString(),
      };
      providerPayments.set(body.paymentKey, p);
      if (body.paymentKey.startsWith('timeout_')) return;
      if (body.paymentKey.startsWith('uncertain_') || body.paymentKey.startsWith('pending_'))
        return respond(500, { code: 'PROVIDER_ERROR' });
      if (body.paymentKey.startsWith('wrong_')) p.totalAmount++;
      return respond(200, p);
    }
    if (req.method === 'GET' && req.url.startsWith('/v1/payments/')) {
      const key = decodeURIComponent(req.url.slice('/v1/payments/'.length));
      if (key.startsWith('unauthorized_')) return json(401, { code: 'UNAUTHORIZED_KEY' });
      const p = providerPayments.get(key);
      return json(p ? 200 : 404, p || { code: 'NOT_FOUND_PAYMENT' });
    }
    return json(501, { code: 'UNMODELED_ENDPOINT' });
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const external = `http://127.0.0.1:${upstream.address().port}`;
  Object.assign(process.env, {
    ORDER_PAYMENTS_ENABLED: 'true',
    PAYMENT_PUBLIC_URL: adminOrigin + '/api/payments',
    CORS_ORIGINS: adminOrigin,
    TOSS_TEST_CLIENT_KEY: 'test_gck_fixture',
    TOSS_TEST_SECRET_KEY: 'test_gsk_fixture',
    PAYMENT_MATTERMOST_WEBHOOK_URL: external + '/hooks/payment',
    PAYMENT_TOSS_BASE_URL: external,
    DVER_API_URL: external + '/parcel',
    DVER_API_KEY: 'dver-fixture',
  });
  await pool.query(
    "INSERT INTO admin_users(login_id,name,password_hash,role,status) VALUES('payment021','결제 운영자',$1,'SYSTEM_ADMIN','ACTIVE') ON CONFLICT(login_id) WHERE deleted_at IS NULL DO UPDATE SET password_hash=EXCLUDED.password_hash",
    [await hashPassword('payment-fixture-only')],
  );
  customerId = (
    await pool.query(
      "INSERT INTO customers(name,phone_number,status) VALUES('실주문 검증','01000210001','ACTIVE') ON CONFLICT(phone_number) WHERE deleted_at IS NULL DO UPDATE SET status='ACTIVE' RETURNING customer_seq",
    )
  ).rows[0].customer_seq;
  app = await startTestApp(apps);
  origin = await app.getUrl();
  base = origin + '/api';
  app.get(ConfigService).set('PAYMENT_PUBLIC_URL', base + '/payments');
  app.get(ConfigService).set('CORS_ORIGINS', [origin, adminOrigin]);
  worker = app.get(PaymentsWorker);
  payments = app.get(PaymentsService);
  client = app.get(PaymentClient);
  const login = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: adminOrigin },
    body: JSON.stringify({ loginId: 'payment021', password: 'payment-fixture-only' }),
  });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];
});
after(async () => {
  for (const application of apps) await application.close();
  if (upstream) {
    upstream.closeAllConnections();
    await new Promise((r) => upstream.close(r));
  }
  await pool.end();
});
function orderBody() {
  const address = {
    name: '테스트 발송인',
    phoneNumber: '01000210001',
    roadAddress: '검증로 21',
    jibunAddress: '검증동 21',
    detailAddress: '',
    dongName: '검증동',
    postalCode: '00021',
  };
  return {
    customerSeq: customerId,
    paymentMethodType: 'billing',
    totalAmount: 3500,
    parcels: [
      {
        origin: address,
        destination: { ...address, name: '테스트 수령인' },
        smallBoxCount: 1,
        itemPrice: 0,
        notifiedPrice: 3500,
      },
    ],
  };
}
async function request(path, body, admin = false, method = 'POST', withOrigin = true) {
  const response = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(withOrigin ? { Origin: admin ? adminOrigin : origin } : {}),
      ...(admin ? { Cookie: cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
}
async function create(body = orderBody(), key = randomUUID(), ai = false) {
  const response = await fetch(base + (ai ? '/orders' : '/admin/orders'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
      ...(ai ? {} : { Cookie: cookie, Origin: adminOrigin }),
    },
    body: JSON.stringify(
      ai
        ? {
            ...body,
            outcome: 'COMPLETE',
            call: {
              providerCallId: randomUUID(),
              callerPhoneNumber: '01000210001',
              incomingAt: new Date().toISOString(),
            },
          }
        : body,
    ),
  });
  const result = await response.json();
  assert.equal(response.status, 201, JSON.stringify(result));
  return result.data;
}
const confirm = (r, key = 'ok_' + r.paymentRequest.paymentRequestId, patch = {}) =>
  request(`/payments/requests/${r.paymentRequest.paymentRequestId}/confirm`, {
    orderId: r.paymentRequest.paymentRequestId,
    amount: r.totalAmount,
    paymentKey: key,
    ...patch,
  });
const lookup = (id) => request(`/payments/requests/${id}`, undefined, false, 'GET');
const stored = (id) =>
  pool.query('SELECT * FROM orders WHERE order_seq=$1', [id]).then((r) => r.rows[0]);
const storedPayment = (id) =>
  pool
    .query('SELECT * FROM order_payment_requests WHERE payment_request_id=$1', [id])
    .then((r) => r.rows[0]);
function assertCalculatedPickup(order) {
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(order.pickup_requested_at);
  assert.ok(time >= '09:00:00' && time <= '17:00:00', time);
  assert.ok(order.pickup_requested_at.getTime() >= order.paid_at.getTime() + 3600000);
}

test('pickup preserves requested times and calculates Korean 09:00-17:00 boundaries at payment', async (t) => {
  const cases = [
    [
      'before request',
      '2026-11-04T15:00:00+09:00',
      '2026-11-04T14:50:00+09:00',
      '2026-11-04T15:00:00+09:00',
    ],
    [
      'less than one hour before request',
      '2026-11-04T16:50:00+09:00',
      '2026-11-04T16:30:00+09:00',
      '2026-11-04T16:50:00+09:00',
    ],
    [
      'equal to request',
      '2026-11-04T15:00:00+09:00',
      '2026-11-04T15:00:00+09:00',
      '2026-11-04T15:00:00+09:00',
    ],
    [
      'AI time outside business hours',
      '2026-11-04T23:00:00+09:00',
      '2026-11-04T16:30:00+09:00',
      '2026-11-04T23:00:00+09:00',
    ],
    [
      'after request',
      '2026-11-04T15:00:00+09:00',
      '2026-11-04T15:01:00+09:00',
      '2026-11-04T16:01:00+09:00',
    ],
    [
      'exact closing time',
      '2026-11-04T15:00:00+09:00',
      '2026-11-04T16:00:00+09:00',
      '2026-11-04T17:00:00+09:00',
    ],
    [
      'one millisecond past closing',
      '2026-11-04T15:00:00+09:00',
      '2026-11-04T16:00:00.001+09:00',
      '2026-11-05T09:00:00+09:00',
    ],
    ['missing early request', null, '2026-11-04T07:15:00+09:00', '2026-11-04T09:00:00+09:00'],
    ['exact opening time', null, '2026-11-04T08:00:00+09:00', '2026-11-04T09:00:00+09:00'],
    ['missing daytime request', null, '2026-11-04T09:00:00+09:00', '2026-11-04T10:00:00+09:00'],
    [
      'year rollover after late payment',
      null,
      '2026-12-31T23:30:00+09:00',
      '2027-01-01T09:00:00+09:00',
    ],
    ['UTC input at Korean closing time', null, '2026-11-04T07:00:00Z', '2026-11-04T08:00:00Z'],
  ];
  const repository = app.get(OrderPaymentsRepository);
  for (const [name, requested, paid, expected] of cases)
    await t.test(name, async () => {
      const transaction = await pool.connect();
      try {
        await transaction.query('BEGIN');
        const id = (
          await transaction.query(
            "INSERT INTO orders(customer_seq,payment_method_type,total_amount,pickup_requested_at) VALUES($1,'billing',3500,$2) RETURNING order_seq",
            [customerId, requested],
          )
        ).rows[0].order_seq;
        await repository.waitForPayment(transaction, id);
        const waiting = (
          await transaction.query('SELECT pickup_requested_at FROM orders WHERE order_seq=$1', [id])
        ).rows[0];
        assert.equal(
          waiting.pickup_requested_at?.toISOString() ?? null,
          requested ? new Date(requested).toISOString() : null,
        );
        await repository.billed(transaction, id, null, null, randomUUID(), paid);
        const order = (
          await transaction.query(
            'SELECT paid_at,pickup_requested_at FROM orders WHERE order_seq=$1',
            [id],
          )
        ).rows[0];
        assert.equal(order.paid_at.toISOString(), new Date(paid).toISOString());
        assert.equal(order.pickup_requested_at.toISOString(), new Date(expected).toISOString());
      } finally {
        await transaction.query('ROLLBACK');
        transaction.release();
      }
    });
});

test('real AI/admin orders queue one message after commit; no upfront pickup or Dver call', async () => {
  const before = parcels.length,
    body = orderBody(),
    key = randomUUID();
  const r = await create(body, key);
  assert.equal(r.status, 'notPaid');
  assert.equal((await stored(r.orderSeq)).pickup_requested_at, null);
  const repeated = await create(body, key);
  assert.equal(repeated.orderSeq, r.orderSeq);
  const id = r.paymentRequest.paymentRequestId;
  const m = messages.length;
  await worker.run();
  await worker.run();
  assert.equal(messages.slice(m).filter((s) => s.includes(`/p/${id}`)).length, 1);
  const text = messages.find((s) => s.includes(`/p/${id}`));
  assert.ok(text.includes(`주문번호: ${r.orderSeq}`));
  assert.ok(text.includes('3,500원'));
  assert.ok(text.includes('수거 요청일시: 결제 완료 후 1시간 뒤'));
  assert.ok(!text.includes('실제 금액'));
  assert.equal(parcels.length, before);
  assert.equal((await lookup(id)).body.data.notificationStatus, 'SENT');
  const ai = await create(orderBody(), randomUUID(), true);
  assert.equal(ai.status, 'notPaid');
  await worker.run();
  assert.ok(messages.some((s) => s.includes(`/p/${ai.paymentRequest.paymentRequestId}`)));
});
test('AI pickup survives payment waiting, notices, approval and repeated requests without an hours restriction', async () => {
  const requested = new Date(Date.now() + 2 * 86400000);
  requested.setUTCHours(14, 30, 0, 0);
  const body = { ...orderBody(), pickupRequestedAt: requested.toISOString() };
  const result = await create(body, randomUUID(), true);
  const id = result.paymentRequest.paymentRequestId;
  assert.equal(
    (await stored(result.orderSeq)).pickup_requested_at.toISOString(),
    body.pickupRequestedAt,
  );
  assert.equal((await lookup(id)).body.data.pickupRequestedAt, body.pickupRequestedAt);
  await worker.run();
  const notice = messages.find((message) => message.includes(`/p/${id}`));
  assert.ok(notice.includes('23:30'));
  assert.ok(notice.includes('해당 시각 이후 결제 시'));
  const html = await (await fetch(`${base}/payments/p/${id}`)).text();
  assert.ok(html.includes('id="pickup-time"'));
  assert.ok(html.includes('23:30'));
  assert.ok(html.includes('다음날 09:00'));
  assert.equal((await confirm(result)).status, 200);
  assert.equal(
    (await stored(result.orderSeq)).pickup_requested_at.toISOString(),
    body.pickupRequestedAt,
  );
  assert.equal(Date.parse(parcels.at(-1).pickupRequestedAt), requested.getTime());
  assert.equal((await confirm(result)).status, 200);
  await payments.reconcile(id, randomUUID());
  assert.equal(
    (await stored(result.orderSeq)).pickup_requested_at.toISOString(),
    body.pickupRequestedAt,
  );
});

test('verified Toss approval updates the real order and posts Dver once with pickup inside Korean working hours', async () => {
  const r = await create(),
    id = r.paymentRequest.paymentRequestId,
    key = 'ok_' + id,
    start = parcels.length;
  const results = await Promise.all(Array.from({ length: 5 }, () => confirm(r, key)));
  for (const result of results) {
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.data.status, 'PAID');
  }
  const o = await stored(r.orderSeq),
    p = providerPayments.get(key);
  assert.equal(o.status, 'ACCEPTED');
  assert.equal(o.paid_at.toISOString(), p.approvedAt);
  assertCalculatedPickup(o);
  assert.equal(parcels.length - start, 1);
  assert.equal(Date.parse(parcels.at(-1).pickupRequestedAt), o.pickup_requested_at.getTime());
  assert.equal(calls.filter((c) => c.method === 'POST' && c.body.orderId === id).length, 1);
  await confirm(r, key);
  await payments.reconcile(id, randomUUID());
  assert.equal(calls.filter((c) => c.body.orderId === id).length, 1);
  assert.equal(parcels.length - start, 1);
  assert.equal((await confirm(r, 'different')).status, 409);
});
test('amount/order mismatch, expired/invalidated links and foreign origins cannot approve', async () => {
  const r = await create(),
    id = r.paymentRequest.paymentRequestId;
  assert.equal((await confirm(r, undefined, { amount: 1 })).status, 409);
  assert.equal((await confirm(r, undefined, { orderId: randomUUID() })).status, 400);
  assert.equal(
    (
      await request(
        `/payments/requests/${id}/confirm`,
        { orderId: id, amount: 3500, paymentKey: 'fixture' },
        false,
        'POST',
        false,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(`/payments/requests/${id}/confirm`, {
        orderId: id,
        amount: 3500,
        paymentKey: 'fixture',
        paid: true,
      })
    ).status,
    400,
  );
  await pool.query(
    "UPDATE order_payment_requests SET expires_at=clock_timestamp()-interval '1 second' WHERE payment_request_id=$1",
    [id],
  );
  assert.equal((await confirm(r)).status, 409);
  assert.equal(calls.filter((c) => c.body.orderId === id).length, 0);
});
test('partial cancellation invalidates the old link and sends a new link for the remaining amount', async () => {
  const body = orderBody();
  body.parcels.push({ ...body.parcels[0], notifiedPrice: 2000 });
  body.totalAmount = 5500;
  const r = await create(body),
    old = r.paymentRequest.paymentRequestId;
  const detail = (await request(`/orders/${r.orderSeq}`, undefined, true, 'GET')).body.data;
  assert.equal(
    (
      await request(
        `/orders/${r.orderSeq}/parcels/cancel`,
        { orderParcelSeqs: [detail.parcels[0].orderParcelSeq] },
        true,
      )
    ).status,
    204,
  );
  const next = (await request(`/orders/${r.orderSeq}`, undefined, true, 'GET')).body.data;
  assert.notEqual(next.paymentRequest.paymentRequestId, old);
  assert.equal(next.totalAmount, 2000);
  assert.equal((await lookup(old)).body.data.status, 'CANCELLED');
  assert.equal((await confirm(r)).status, 409);
  await worker.run();
  assert.ok(
    messages.some(
      (s) => s.includes(`/p/${next.paymentRequest.paymentRequestId}`) && s.includes('2,000원'),
    ),
  );
  assert.equal((await confirm(next)).status, 200);
  assert.equal(parcels.at(-1).outboundParcels.length, 1);
  assert.equal(parcels.at(-1).outboundParcels[0].notifiedPrice, 2000);
});
test('timeout after Toss success recovers after application restart using GET only', async () => {
  const r = await create(),
    id = r.paymentRequest.paymentRequestId,
    key = 'timeout_' + id;
  client.timeout = 80;
  try {
    assert.equal((await confirm(r, key)).status, 502);
  } finally {
    client.timeout = 10000;
  }
  assert.equal((await stored(r.orderSeq)).status, 'notPaid');
  assert.equal((await lookup(id)).body.data.status, 'REVIEW_REQUIRED');
  assert.equal((await request(`/orders/${r.orderSeq}/cancel`, undefined, true)).status, 409);
  await app.close();
  apps.splice(apps.indexOf(app), 1);
  app = await startTestApp(apps);
  origin = await app.getUrl();
  base = origin + '/api';
  app.get(ConfigService).set('PAYMENT_PUBLIC_URL', base + '/payments');
  app.get(ConfigService).set('CORS_ORIGINS', [origin, adminOrigin]);
  worker = app.get(PaymentsWorker);
  payments = app.get(PaymentsService);
  client = app.get(PaymentClient);
  await worker.run();
  assert.equal((await stored(r.orderSeq)).status, 'ACCEPTED');
  assert.equal(calls.filter((c) => c.method === 'POST' && c.body.orderId === id).length, 1);
  assert.equal(calls.filter((c) => c.method === 'GET' && c.path.endsWith(key)).length, 1);
});
test('approval followed by DB transaction failure is reconciled without charging again', async () => {
  const r = await create(),
    id = r.paymentRequest.paymentRequestId,
    key = 'ok_' + id;
  const audit = app.get(AuditService),
    original = audit.recordSuccess;
  audit.recordSuccess = async function (event, ...args) {
    if (event.action === 'ORDER_PAYMENT_COMPLETED')
      throw new Error('Simulated audit storage failure');
    return original.call(this, event, ...args);
  };
  try {
    assert.equal((await confirm(r, key)).status, 500);
  } finally {
    audit.recordSuccess = original;
  }
  assert.equal((await stored(r.orderSeq)).status, 'notPaid');
  assert.equal((await lookup(id)).body.data.completionNotificationStatus, 'WAITING');
  assert.equal((await request(`/payments/requests/${id}/reconcile`, {})).status, 200);
  assert.equal((await stored(r.orderSeq)).status, 'ACCEPTED');
  assert.equal(calls.filter((c) => c.method === 'POST' && c.body.orderId === id).length, 1);
});
test('Dver rejection preserves payment; admin retries only Dver and keeps the pickup time', async () => {
  const r = await create(),
    id = r.paymentRequest.paymentRequestId;
  rejectDver = true;
  try {
    assert.equal((await confirm(r)).status, 200);
  } finally {
    rejectDver = false;
  }
  const before = await stored(r.orderSeq);
  assert.equal(before.status, 'SUBMITTING_FAILED');
  assert.ok(before.paid_at);
  assert.equal((await request(`/admin/orders/${r.orderSeq}/retry`, {}, true)).status, 200);
  const after = await stored(r.orderSeq);
  assert.equal(after.status, 'ACCEPTED');
  assert.equal(after.pickup_requested_at.toISOString(), before.pickup_requested_at.toISOString());
  assert.equal(calls.filter((c) => c.method === 'POST' && c.body.orderId === id).length, 1);
});
test('wrong successful amount is not paid and a definite rejection releases the approval reservation', async () => {
  const r = await create(),
    id = r.paymentRequest.paymentRequestId;
  assert.equal((await confirm(r, 'wrong_' + id)).status, 502);
  assert.equal((await stored(r.orderSeq)).status, 'notPaid');
  const rejected = await create(),
    rid = rejected.paymentRequest.paymentRequestId;
  assert.equal((await confirm(rejected, 'reject_' + rid)).status, 422);
  assert.equal((await request(`/orders/${rejected.orderSeq}/cancel`, undefined, true)).status, 204);
});
test('message response loss is recorded UNKNOWN without automatic resend and leaves the order intact', async () => {
  const r = await create(),
    id = r.paymentRequest.paymentRequestId;
  messageMode = 'timeout';
  client.timeout = 80;
  try {
    await worker.run();
    await worker.run();
  } finally {
    messageMode = 'ok';
    client.timeout = 10000;
  }
  assert.equal((await lookup(id)).body.data.notificationStatus, 'UNKNOWN');
  assert.equal(messages.filter((s) => s.includes(`/p/${id}`)).length, 1);
  assert.equal((await stored(r.orderSeq)).status, 'notPaid');
});
test('public page/status expose no provider key or secrets and cannot accept self-reported success', async () => {
  const r = await create(),
    id = r.paymentRequest.paymentRequestId;
  for (const mode of ['p', 'success', 'fail']) {
    const response = await fetch(
      `${base}/payments/${mode}/${id}?paymentKey=do-not-reflect&message=untrusted`,
    );
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.ok(html.includes('결제 완료 후 1시간 뒤'));
    for (const secret of ['test_gsk_fixture', 'do-not-reflect', 'untrusted', '/hooks/payment'])
      assert.ok(!html.includes(secret));
  }
  assert.equal((await stored(r.orderSeq)).status, 'notPaid');
  const asset = await fetch(base + '/payments/assets/checkout.js');
  assert.equal(asset.status, 200);
  assert.ok((await asset.text()).includes('result.data'));
  assert.equal((await request(`/payments/requests/${id}/reconcile`, { paid: true })).status, 400);
});

test('monthly and group billing bypass Toss and notifications and preserve a future requested pickup', async () => {
  await worker.run();
  const count = messages.length,
    postCount = calls.filter((c) => c.method === 'POST').length;
  await pool.query('UPDATE customers SET monthly_billing_enabled=true WHERE customer_seq=$1', [
    customerId,
  ]);
  const requested = new Date(Date.now() + 86400000).toISOString();
  const monthly = await create({
    ...orderBody(),
    paymentMethodType: 'credit',
    pickupRequestedAt: requested,
  });
  assert.equal(monthly.status, 'ACCEPTED');
  assert.equal(monthly.paymentRequest, null);
  const org = (
    await pool.query(
      "INSERT INTO organizations(name,status) VALUES('결제 21 기업','ACTIVE') RETURNING organization_seq",
    )
  ).rows[0].organization_seq;
  await testMembership(pool, {
    customerSeq: customerId,
    organizationSeq: org,
    employeeNo: randomUUID(),
    groupBillingEnabled: true,
  });
  const group = await create({
    ...orderBody(),
    paymentMethodType: 'groupBilling',
    pickupRequestedAt: requested,
  });
  assert.equal(group.status, 'ACCEPTED');
  assert.equal(group.paymentRequest, null);
  for (const r of [monthly, group]) {
    const o = await stored(r.orderSeq);
    assert.equal(o.pickup_requested_at.toISOString(), requested);
  }
  await worker.run();
  assert.equal(messages.length, count);
  assert.equal(calls.filter((c) => c.method === 'POST').length, postCount);
});
test('only an authenticated administrator can explicitly retry a notification; retries are audited', async () => {
  const r = await create(),
    id = r.paymentRequest.paymentRequestId;
  messageMode = 'reject';
  try {
    await worker.run();
  } finally {
    messageMode = 'ok';
  }
  assert.equal((await lookup(id)).body.data.notificationStatus, 'FAILED');
  assert.equal((await request(`/payments/notifications/${id}/retry`, {})).status, 401);
  assert.equal((await request(`/payments/notifications/${id}/retry`, {}, true)).status, 200);
  assert.equal((await request(`/payments/notifications/${id}/retry`, {}, true)).status, 200);
  const before = messages.filter((s) => s.includes(`/p/${id}`)).length;
  await worker.run();
  assert.equal(messages.filter((s) => s.includes(`/p/${id}`)).length, before + 1);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM audit_logs WHERE target_seq=$1 AND action='ORDER_PAYMENT_NOTIFICATION_RETRIED' AND result='SUCCESS'",
        [r.orderSeq],
      )
    ).rows[0].n,
    1,
  );
});

test('separate application instances share one approval reservation and cannot charge twice', async () => {
  const r = await create(),
    id = r.paymentRequest.paymentRequestId,
    key = 'ok_' + id;
  const { AppModule } = require('../dist/app.module');
  const peer = await NestFactory.create(AppModule, { logger: false });
  try {
    const responses = await Promise.allSettled([
      payments.confirm(id, id, 3500, key, randomUUID()),
      peer.get(PaymentsService).confirm(id, id, 3500, key, randomUUID()),
    ]);
    assert.ok(responses.some((x) => x.status === 'fulfilled'));
    for (const x of responses) if (x.status === 'rejected') assert.equal(x.reason.getStatus(), 409);
    assert.equal((await stored(r.orderSeq)).status, 'ACCEPTED');
    assert.equal(calls.filter((c) => c.method === 'POST' && c.body.orderId === id).length, 1);
  } finally {
    await peer.close();
  }
});
test('a crashed approval owner is recovered after its lease expires with a GET and no new POST', async () => {
  const r = await create(),
    id = r.paymentRequest.paymentRequestId,
    key = 'crash_' + id;
  await app.get(OrderPaymentsService).claimApproval(id, 3500, key);
  providerPayments.set(key, {
    orderId: id,
    paymentKey: key,
    totalAmount: 3500,
    currency: 'KRW',
    status: 'DONE',
    approvedAt: new Date().toISOString(),
  });
  await worker.run();
  assert.equal((await stored(r.orderSeq)).status, 'notPaid');
  await pool.query(
    "UPDATE order_payment_requests SET approval_claimed_until=clock_timestamp()-interval '1 second' WHERE payment_request_id=$1",
    [id],
  );
  await worker.run();
  assert.equal((await stored(r.orderSeq)).status, 'ACCEPTED');
  assert.equal(calls.filter((c) => c.method === 'POST' && c.body.orderId === id).length, 0);
  assert.equal(calls.filter((c) => c.method === 'GET' && c.path.endsWith(key)).length, 1);
});
test('disabled payment integration exposes no order data and performs no external work', async () => {
  const r = await create(),
    id = r.paymentRequest.paymentRequestId,
    count = calls.length;
  const config = app.get(ConfigService);
  config.set('ORDER_PAYMENTS_ENABLED', false);
  try {
    assert.equal((await lookup(id)).status, 503);
    assert.equal((await confirm(r)).status, 503);
    await worker.run();
    assert.equal(calls.length, count);
  } finally {
    config.set('ORDER_PAYMENTS_ENABLED', true);
  }
});

const completionMessages = (id) =>
  messages.filter((s) => s.includes('결제 완료 안내') && s.includes(`/p/${id}`));

test('completion notices wait for committed approval and survive repeated confirm/reconcile calls', async () => {
  const r = await create(),
    id = r.paymentRequest.paymentRequestId;
  await worker.run();
  assert.equal((await lookup(id)).body.data.completionNotificationStatus, 'WAITING');
  assert.equal(completionMessages(id).length, 0);
  assert.equal((await confirm(r)).status, 200);
  assert.equal((await lookup(id)).body.data.completionNotificationStatus, 'PENDING');
  await Promise.all([worker.run(), worker.run()]);
  await confirm(r);
  await payments.reconcile(id, randomUUID());
  await worker.run();
  assert.equal(completionMessages(id).length, 1);
  assert.equal((await lookup(id)).body.data.completionNotificationStatus, 'SENT');
  assert.ok(completionMessages(id)[0].includes('3,500원'));
  assert.ok(!completionMessages(id)[0].includes('[결제하기]'));
});

test('payment completion notice is independent of missing Dver configuration and Dver rejection', async () => {
  const config = app.get(ConfigService),
    oldKey = config.get('DVER_API_KEY');
  const r = await create(),
    id = r.paymentRequest.paymentRequestId;
  config.set('DVER_API_KEY', '');
  try {
    assert.equal((await confirm(r)).status, 503);
    assert.equal((await stored(r.orderSeq)).status, 'PAID');
    await worker.run();
    assert.equal(completionMessages(id).length, 1);
    assert.equal((await lookup(id)).body.data.completionNotificationStatus, 'SENT');
  } finally {
    config.set('DVER_API_KEY', oldKey);
  }
  const failed = await create(),
    fid = failed.paymentRequest.paymentRequestId;
  rejectDver = true;
  try {
    assert.equal((await confirm(failed)).status, 200);
  } finally {
    rejectDver = false;
  }
  await worker.run();
  assert.equal((await stored(failed.orderSeq)).status, 'SUBMITTING_FAILED');
  assert.equal(completionMessages(fid).length, 1);
  assert.ok(!completionMessages(fid)[0].includes('접수가 완료'));
});

test('completion delivery timeout is UNKNOWN without automatic resend and admin retry is isolated/audited', async () => {
  const r = await create(),
    id = r.paymentRequest.paymentRequestId;
  await worker.run();
  await confirm(r);
  const providerCalls = () =>
    calls.filter((c) => c.body.orderId === id || c.path.endsWith('ok_' + id)).length;
  const providerCount = providerCalls(),
    parcelCount = parcels.length;
  messageMode = 'timeout';
  client.timeout = 80;
  try {
    await worker.run();
  } finally {
    messageMode = 'ok';
    client.timeout = 10000;
  }
  assert.equal((await lookup(id)).body.data.completionNotificationStatus, 'UNKNOWN');
  await worker.run();
  assert.equal(completionMessages(id).length, 1);
  const path = `/payments/notifications/${id}/completion/retry`;
  assert.equal((await request(path, {})).status, 401);
  assert.equal((await request(path, {}, true, 'POST', false)).status, 403);
  assert.equal((await request(path, {}, true)).status, 200);
  assert.equal((await request(path, {}, true)).status, 200);
  await worker.run();
  assert.equal(completionMessages(id).length, 2);
  const view = (await lookup(id)).body.data;
  assert.equal(view.completionNotificationStatus, 'SENT');
  assert.equal(view.notificationStatus, 'SENT');
  assert.equal(providerCalls(), providerCount);
  assert.equal(parcels.length, parcelCount);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM audit_logs WHERE target_seq=$1 AND action='ORDER_PAYMENT_COMPLETION_NOTIFICATION_RETRIED' AND result='SUCCESS'",
        [r.orderSeq],
      )
    ).rows[0].n,
    1,
  );
});

test('completion notices recover pending work after restart and two instances cannot both send it', async () => {
  await worker.run();
  const r = await create(),
    id = r.paymentRequest.paymentRequestId;
  await confirm(r);
  // Retain eligibility even after the original payment-link expiration.
  await pool.query(
    "UPDATE order_payment_requests SET expires_at=clock_timestamp()-interval '1 second' WHERE payment_request_id=$1",
    [id],
  );
  const { AppModule } = require('../dist/app.module');
  const peer = await NestFactory.create(AppModule, { logger: false });
  try {
    await Promise.all([
      payments.notifyCompletionOne(),
      peer.get(PaymentsService).notifyCompletionOne(),
    ]);
    assert.equal(completionMessages(id).length, 1);
    assert.equal((await lookup(id)).body.data.completionNotificationStatus, 'SENT');
  } finally {
    await peer.close();
  }
});

test('crashed completion sender becomes UNKNOWN; legacy completed requests can still be sent', async () => {
  const r = await create(),
    id = r.paymentRequest.paymentRequestId;
  await confirm(r);
  await pool.query(
    "UPDATE order_payment_requests SET completion_notification_status='SENDING',completion_notification_attempted_at=clock_timestamp()-interval '46 seconds' WHERE payment_request_id=$1",
    [id],
  );
  await worker.run();
  assert.equal((await lookup(id)).body.data.completionNotificationStatus, 'UNKNOWN');
  assert.equal(completionMessages(id).length, 0);
  const legacy = await create(),
    lid = legacy.paymentRequest.paymentRequestId;
  await confirm(legacy);
  await pool.query(
    "UPDATE order_payment_requests SET completion_notification_status='WAITING' WHERE payment_request_id=$1",
    [lid],
  );
  await worker.run();
  assert.equal(completionMessages(lid).length, 1);
  assert.equal((await lookup(lid)).body.data.completionNotificationStatus, 'SENT');
});

test('completion retries reject unpaid/in-flight work and roll back when audit storage fails', async () => {
  const r = await create(),
    id = r.paymentRequest.paymentRequestId;
  const path = `/payments/notifications/${id}/completion/retry`;
  assert.equal((await request(path, {}, true)).status, 409);
  await worker.run();
  await confirm(r);
  messageMode = 'reject';
  try {
    await worker.run();
  } finally {
    messageMode = 'ok';
  }
  assert.equal((await lookup(id)).body.data.completionNotificationStatus, 'FAILED');
  const audit = app.get(AuditService),
    original = audit.recordSuccess;
  audit.recordSuccess = async function (event, ...args) {
    if (event.action === 'ORDER_PAYMENT_COMPLETION_NOTIFICATION_RETRIED')
      throw Error('Audit failed');
    return original.call(this, event, ...args);
  };
  try {
    assert.equal((await request(path, {}, true)).status, 500);
  } finally {
    audit.recordSuccess = original;
  }
  assert.equal((await lookup(id)).body.data.completionNotificationStatus, 'FAILED');
  assert.equal((await request(path, {}, true)).status, 200);
  const repository = app.get(OrderPaymentsService);
  assert.equal(await repository.claimCompletionNotification(), id);
  assert.equal((await request(path, {}, true)).status, 409);
  await repository.finishCompletionNotification(id, 'FAILED');
});

test('notices include all active parcel addresses and remove cancelled addresses without exposing them publicly', async () => {
  const body = orderBody();
  body.parcels[0].origin = {
    ...body.parcels[0].origin,
    roadAddress: '출발검증로 101',
    detailAddress: '출발 101호',
  };
  body.parcels[0].destination = {
    ...body.parcels[0].destination,
    roadAddress: '도착검증로 201',
    detailAddress: '도착 201호',
  };
  body.parcels.push({
    ...body.parcels[0],
    notifiedPrice: 2000,
    origin: {
      ...body.parcels[0].origin,
      roadAddress: '출발검증로 102',
      detailAddress: '출발 102호',
    },
    destination: {
      ...body.parcels[0].destination,
      roadAddress: '도착검증로 202',
      detailAddress: '도착 202호',
    },
  });
  body.totalAmount = 5500;
  const r = await create(body),
    oldId = r.paymentRequest.paymentRequestId;
  await worker.run();
  const first = messages.find((s) => s.includes(`/p/${oldId}`));
  for (const address of [
    '출발검증로 101 출발 101호',
    '도착검증로 201 도착 201호',
    '출발검증로 102 출발 102호',
    '도착검증로 202 도착 202호',
  ])
    assert.ok(first.includes(address));
  assert.ok(!first.includes('배송 건수'));
  assert.equal(Object.hasOwn((await lookup(oldId)).body.data, 'parcels'), false);
  const page = await fetch(base + '/payments/p/' + oldId);
  assert.ok(!(await page.text()).includes('도착검증로 202'));
  const detail = (await request(`/orders/${r.orderSeq}`, undefined, true, 'GET')).body.data;
  assert.equal(
    (
      await request(
        `/orders/${r.orderSeq}/parcels/cancel`,
        { orderParcelSeqs: [detail.parcels[1].orderParcelSeq] },
        true,
      )
    ).status,
    204,
  );
  const remaining = (await request(`/orders/${r.orderSeq}`, undefined, true, 'GET')).body.data;
  const id = remaining.paymentRequest.paymentRequestId;
  await worker.run();
  const next = messages.find((s) => s.includes(`/p/${id}`));
  assert.ok(next.includes('도착검증로 201 도착 201호'));
  assert.ok(!next.includes('도착검증로 202'));
  assert.equal((await confirm(remaining)).status, 200);
  await worker.run();
  const completion = completionMessages(id)[0];
  assert.ok(completion.includes('출발검증로 101 출발 101호'));
  assert.ok(completion.includes('도착검증로 201 도착 201호'));
  for (const unwanted of ['도착검증로 202', '배송 건수', '(한국 시간)'])
    assert.ok(!completion.includes(unwanted));
});

test('confirmed rejection permits a new payment attempt without reusing the failed receipt', async () => {
  const order = await create(),
    id = order.paymentRequest.paymentRequestId,
    key = 'reject_' + id;
  assert.equal((await confirm(order, key)).status, 422);
  assert.equal((await confirm(order, key)).status, 422);
  assert.equal((await lookup(id)).body.data.status, 'PENDING');
  assert.equal((await confirm(order)).status, 200);
  const attempts = calls.filter((c) => c.method === 'POST' && c.body.orderId === id);
  assert.equal(attempts.length, 3);
  assert.equal(attempts[0].receipt, attempts[1].receipt);
  assert.notEqual(attempts[1].receipt, attempts[2].receipt);
  assert.equal((await stored(order.orderSeq)).status, 'ACCEPTED');
});

test('a direct missing-payment or expired-session rejection permits a fresh payment on the same link', async () => {
  for (const prefix of ['missing_', 'expired_session_']) {
    const order = await create(),
      id = order.paymentRequest.paymentRequestId,
      key = prefix + id;
    const before = await storedPayment(id);
    const failed = await confirm(order, key);
    assert.equal(failed.status, 422);
    assert.equal(failed.body.error.code, 'PAYMENT_FAILED');
    const after = await storedPayment(id);
    assert.equal(after.provider_payment_key, null);
    assert.equal(after.approval_started_at, null);
    assert.equal(after.expires_at.getTime(), before.expires_at.getTime());
    assert.equal((await lookup(id)).body.data.status, 'PENDING');
    assert.equal((await confirm(order, key)).status, 422);
    assert.equal((await confirm(order)).status, 200);
    const attempts = calls.filter((c) => c.method === 'POST' && c.body.orderId === id);
    assert.equal(attempts.length, 3);
    assert.equal(attempts[0].receipt, attempts[1].receipt);
    assert.notEqual(attempts[1].receipt, attempts[2].receipt);
    assert.equal((await stored(order.orderSeq)).status, 'ACCEPTED');
  }
});

test('an absent lookup, unauthorized and still-processing payments retain their keys and block a new charge', async () => {
  for (const prefix of ['unknown_missing_', 'unauthorized_', 'pending_']) {
    const order = await create(),
      id = order.paymentRequest.paymentRequestId,
      key = prefix + id;
    try {
      assert.equal((await confirm(order, key)).status, 502);
      assert.equal((await request(`/payments/requests/${id}/reconcile`, {})).status, 502);
      const row = await storedPayment(id);
      assert.equal(row.provider_payment_key, key);
      assert.ok(row.approval_started_at);
      assert.equal((await lookup(id)).body.data.status, 'REVIEW_REQUIRED');
      assert.equal((await confirm(order, 'different_' + id)).status, 409);
      assert.equal(
        (await request(`/orders/${order.orderSeq}/cancel`, undefined, true)).status,
        409,
      );
    } finally {
      await pool.query(
        'UPDATE order_payment_requests SET invalidated_at=clock_timestamp() WHERE payment_request_id=$1',
        [id],
      );
    }
  }
});

test('a rejected payment session no longer blocks order cancellation or deadline cleanup', async () => {
  const cancelled = await create();
  assert.equal((await confirm(cancelled, 'expired_session_' + cancelled.orderSeq)).status, 422);
  assert.equal(
    (await request(`/orders/${cancelled.orderSeq}/cancel`, undefined, true)).status,
    204,
  );
  assert.equal((await stored(cancelled.orderSeq)).status, 'CANCELLED');
  const expired = await create(),
    id = expired.paymentRequest.paymentRequestId;
  assert.equal((await confirm(expired, 'missing_' + id)).status, 422);
  await pool.query(
    "UPDATE orders SET payment_due_at=clock_timestamp()-interval '1 second' WHERE order_seq=$1",
    [expired.orderSeq],
  );
  await pool.query(
    "UPDATE order_payment_requests SET expires_at=clock_timestamp()-interval '1 second' WHERE payment_request_id=$1",
    [id],
  );
  assert.equal((await lookup(id)).body.data.status, 'EXPIRED');
  assert.equal((await confirm(expired)).status, 409);
  await app.get(OrderMaintenanceWorker).run();
  assert.equal((await stored(expired.orderSeq)).status, 'CANCELLED');
});

test('verified terminal failures permit a fresh payment while preserving the original deadline', async () => {
  for (const status of ['ABORTED', 'EXPIRED']) {
    const order = await create(),
      id = order.paymentRequest.paymentRequestId,
      key = 'pending_' + id;
    assert.equal((await confirm(order, key)).status, 502);
    const before = await storedPayment(id);
    providerPayments.get(key).status = status;
    assert.equal((await request(`/payments/requests/${id}/reconcile`, {})).status, 422);
    const after = await storedPayment(id);
    assert.equal(after.provider_payment_key, null);
    assert.equal(after.approval_started_at, null);
    assert.equal(after.expires_at.getTime(), before.expires_at.getTime());
    assert.equal((await confirm(order)).status, 200);
  }
});

test('a mismatched failure or recorded approval cannot be cleared by a terminal provider reply', async () => {
  const order = await create(),
    id = order.paymentRequest.paymentRequestId,
    key = 'pending_' + id;
  assert.equal((await confirm(order, key)).status, 502);
  const payment = providerPayments.get(key);
  payment.status = 'ABORTED';
  payment.currency = 'USD';
  assert.equal((await request(`/payments/requests/${id}/reconcile`, {})).status, 502);
  assert.equal((await storedPayment(id)).provider_payment_key, key);
  payment.currency = 'KRW';
  const approvedAt = new Date(Date.now() - 5000).toISOString();
  await app.get(OrderPaymentsService).recordApproval(id, key, approvedAt);
  assert.equal((await request(`/payments/requests/${id}/reconcile`, {})).status, 502);
  const retained = await storedPayment(id);
  assert.equal(retained.provider_payment_key, key);
  assert.equal(retained.provider_approved_at.toISOString(), approvedAt);
  payment.status = 'DONE';
  payment.approvedAt = approvedAt;
  assert.equal((await request(`/payments/requests/${id}/reconcile`, {})).status, 200);
});

test('a stale or expired approval claim cannot clear the current payment attempt', async () => {
  const order = await create(),
    id = order.paymentRequest.paymentRequestId,
    key = 'lease_' + id,
    orders = app.get(OrderPaymentsService);
  const first = await orders.claimApproval(id, order.totalAmount, key);
  const replacement = randomUUID();
  await pool.query(
    'UPDATE order_payment_requests SET approval_claim_id=$2 WHERE payment_request_id=$1',
    [id, replacement],
  );
  await orders.releaseClaim(id, first.claimId, true);
  assert.equal((await storedPayment(id)).approval_claim_id, replacement);
  await pool.query(
    "UPDATE order_payment_requests SET approval_claimed_until=clock_timestamp()-interval '1 second' WHERE payment_request_id=$1",
    [id],
  );
  await orders.releaseClaim(id, replacement, true);
  assert.equal((await storedPayment(id)).provider_payment_key, key);
  const current = await orders.claimApproval(id, order.totalAmount, key);
  assert.equal(await orders.releaseClaim(id, current.claimId, true), true);
  assert.equal((await storedPayment(id)).provider_payment_key, null);
  assert.equal((await confirm(order)).status, 200);
  assert.equal(await orders.releaseClaim(id, current.claimId, true), false);
  assert.ok((await storedPayment(id)).completed_at);
});

test('a confirmed failure does not reopen an expired merchant payment deadline', async () => {
  const order = await create(),
    id = order.paymentRequest.paymentRequestId,
    key = 'pending_' + id;
  assert.equal((await confirm(order, key)).status, 502);
  await pool.query(
    "UPDATE order_payment_requests SET expires_at=clock_timestamp()-interval '1 second' WHERE payment_request_id=$1",
    [id],
  );
  const before = await storedPayment(id);
  providerPayments.get(key).status = 'EXPIRED';
  assert.equal((await request(`/payments/requests/${id}/reconcile`, {})).status, 422);
  assert.equal((await lookup(id)).body.data.status, 'EXPIRED');
  assert.equal((await confirm(order)).status, 409);
  assert.equal((await storedPayment(id)).expires_at.getTime(), before.expires_at.getTime());
});

test('twenty unresolved approvals cannot starve a later success across worker restart', async () => {
  const staged = [];
  try {
    for (let i = 0; i < 21; i++) {
      const order = await create(),
        id = order.paymentRequest.paymentRequestId,
        key = 'missing_' + id;
      staged.push({ order, id, key });
      const claim = await app.get(OrderPaymentsService).claimApproval(id, order.totalAmount, key);
      await app.get(OrderPaymentsService).releaseClaim(id, claim.claimId);
      await pool.query(
        "UPDATE order_payment_requests SET approval_started_at='2000-01-01'::timestamptz+$2::integer*interval '1 second',notification_status='SENT' WHERE payment_request_id=$1",
        [id, i],
      );
    }
    const last = staged[20];
    providerPayments.set(last.key, {
      orderId: last.id,
      paymentKey: last.key,
      totalAmount: last.order.totalAmount,
      currency: 'KRW',
      status: 'DONE',
      approvedAt: new Date(Date.now() - 5000).toISOString(),
    });
    await worker.run();
    assert.equal((await stored(last.order.orderSeq)).status, 'notPaid');
    const firstKeys = new Set(staged.slice(0, 20).map((entry) => '/v1/payments/' + entry.key));
    assert.equal(calls.filter((c) => c.method === 'GET' && firstKeys.has(c.path)).length, 20);
    const restarted = await startTestApp(apps);
    await restarted.get(PaymentsWorker).run();
    assert.equal((await stored(last.order.orderSeq)).status, 'ACCEPTED');
    assert.equal(calls.filter((c) => c.method === 'GET' && firstKeys.has(c.path)).length, 20);
    assert.equal(calls.filter((c) => c.method === 'POST' && c.body.orderId === last.id).length, 0);
  } finally {
    await pool.query(
      'UPDATE order_payment_requests SET invalidated_at=clock_timestamp() WHERE payment_request_id=ANY($1::uuid[]) AND completed_at IS NULL',
      [staged.map((entry) => entry.id)],
    );
  }
});

test('automatic approval batches are disjoint and honor the persisted next lookup time', async () => {
  const ids = [];
  try {
    for (let i = 0; i < 21; i++) {
      const order = await create(),
        id = order.paymentRequest.paymentRequestId;
      ids.push(id);
      const claim = await app
        .get(OrderPaymentsService)
        .claimApproval(id, order.totalAmount, 'batch_' + id);
      await app.get(OrderPaymentsService).releaseClaim(id, claim.claimId);
      await pool.query(
        "UPDATE order_payment_requests SET approval_started_at='1900-01-01'::timestamptz+$2::integer*interval '1 second' WHERE payment_request_id=$1",
        [id, i],
      );
    }
    const repository = app.get(PaymentsRepository);
    const [first, second] = await Promise.all([
      repository.pendingApprovals(),
      repository.pendingApprovals(),
    ]);
    const firstIds = new Set(first.map((row) => row.id));
    assert.ok(second.every((row) => !firstIds.has(row.id)));
    assert.equal(
      new Set([...first, ...second].filter((row) => ids.includes(row.id)).map((row) => row.id))
        .size,
      21,
    );
    assert.ok((await repository.pendingApprovals()).every((row) => !ids.includes(row.id)));
    await pool.query(
      "UPDATE order_payment_requests SET approval_next_check_at=clock_timestamp()-interval '1 second' WHERE payment_request_id=$1",
      [ids[0]],
    );
    assert.ok((await repository.pendingApprovals()).some((row) => row.id === ids[0]));
  } finally {
    await pool.query(
      'UPDATE order_payment_requests SET invalidated_at=clock_timestamp() WHERE payment_request_id=ANY($1::uuid[])',
      [ids],
    );
  }
});

test('migration 051 preserves an existing key, approval evidence and lease during upgrade', async () => {
  const { readFileSync } = require('node:fs');
  const { join } = require('node:path');
  const order = await create(),
    id = order.paymentRequest.paymentRequestId;
  await app.get(OrderPaymentsService).claimApproval(id, order.totalAmount, 'upgrade_' + id);
  await app.get(OrderPaymentsService).recordApproval(id, 'upgrade_' + id, new Date().toISOString());
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const snapshot = async () =>
      (
        await client.query(
          "SELECT to_jsonb(r)-'approval_next_check_at' AS value FROM order_payment_requests r WHERE payment_request_id=$1",
          [id],
        )
      ).rows[0].value;
    const before = await snapshot();
    // Recreate only the pre-051 column/index shape inside this disposable transaction.
    await client.query('ALTER TABLE order_payment_requests DROP COLUMN approval_next_check_at');
    const original = readFileSync(
      join(__dirname, '../migrations/022-order-toss-payments.sql'),
      'utf8',
    );
    await client.query(original.match(/CREATE INDEX order_payment_reconcile_idx[\s\S]+?;/)[0]);
    await client.query(
      readFileSync(join(__dirname, '../migrations/051-payment-approval-recovery.sql'), 'utf8'),
    );
    assert.deepEqual(await snapshot(), before);
    const row = (
      await client.query(
        'SELECT approval_next_check_at FROM order_payment_requests WHERE payment_request_id=$1',
        [id],
      )
    ).rows[0];
    assert.equal(row.approval_next_check_at, null);
    assert.match(
      (
        await client.query(
          "SELECT pg_get_indexdef('order_payment_reconcile_idx'::regclass) AS definition",
        )
      ).rows[0].definition,
      /COALESCE\(approval_next_check_at, approval_started_at\).*payment_request_id/,
    );
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.query(
      'UPDATE order_payment_requests SET invalidated_at=clock_timestamp() WHERE payment_request_id=$1',
      [id],
    );
  }
});

test('a due retry gets its turn ahead of newer unchecked approvals', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'CREATE TEMP TABLE orders (LIKE public.orders INCLUDING ALL) ON COMMIT DROP',
    );
    await client.query(
      'INSERT INTO orders(order_seq) OVERRIDING SYSTEM VALUE SELECT generate_series(1,21)',
    );
    await client.query(
      'CREATE TEMP TABLE order_payment_requests (LIKE public.order_payment_requests INCLUDING ALL) ON COMMIT DROP',
    );
    const due = (
      await client.query(`INSERT INTO order_payment_requests
      (order_seq,amount,expires_at,approval_started_at,provider_payment_key,approval_next_check_at)
      VALUES(21,1,clock_timestamp()+interval '1 hour',clock_timestamp()-interval '2 minutes',
        'due-retry',clock_timestamp()-interval '1 second') RETURNING payment_request_id`)
    ).rows[0].payment_request_id;
    await client.query(`INSERT INTO order_payment_requests
      (order_seq,amount,expires_at,approval_started_at,provider_payment_key)
      SELECT n,1,clock_timestamp()+interval '1 hour',clock_timestamp(),'new-'||n
      FROM generate_series(1,20) n`);
    const repository = new PaymentsRepository({ pool: client });
    assert.ok((await repository.pendingApprovals()).some((row) => row.id === due));
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
