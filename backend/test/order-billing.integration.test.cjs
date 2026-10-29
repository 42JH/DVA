require('reflect-metadata');
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { NestFactory } = require('@nestjs/core');
const { migrate } = require('./helpers/migrations.cjs');
const { configureApplication } = require('../dist/configure-application');
const { hashPassword } = require('../dist/auth/password');
const { DverClient } = require('../dist/orders/dver.client');
const { OrderPaymentsService } = require('../dist/orders/order-payments.service');

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.DB_NAME, 'dva_webhook_test');
assert.equal(process.env.DB_HOST, '127.0.0.1');
process.env.CORS_ORIGINS = 'http://localhost:5173';
const { AppModule } = require('../dist/app.module');
const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});
let app, base, cookie, customerId, callId, payments;
let dverRequests = [];
let dverReply = 'ACCEPTED';
const origin = 'http://localhost:5173';
async function request(path, body, ai = false, method = 'POST') {
  const response = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(ai ? { call_session_seq: String(callId) } : { Cookie: cookie, Origin: origin }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
}
before(async () => {
  await migrate(pool);
  await pool.query(
    "INSERT INTO admin_users(login_id,name,password_hash,role,status) VALUES('billing138','결제 운영자',$1,'SYSTEM_ADMIN','ACTIVE') ON CONFLICT(login_id) DO UPDATE SET password_hash=EXCLUDED.password_hash",
    [await hashPassword('billing-test-only')],
  );
  customerId = (
    await pool.query(
      "INSERT INTO customers(name,phone_number,status) VALUES('결제 검증','01000138001','ACTIVE') ON CONFLICT(phone_number) DO UPDATE SET status='ACTIVE' RETURNING customer_seq",
    )
  ).rows[0].customer_seq;
  callId = (
    await pool.query(
      "INSERT INTO call_sessions(provider_call_id,caller_phone_number) VALUES($1,'01000138001') RETURNING call_session_seq",
      [randomUUID()],
    )
  ).rows[0].call_session_seq;
  app = await NestFactory.create(AppModule, { logger: false });
  payments = app.get(OrderPaymentsService);
  const dver = app.get(DverClient);
  dver.ensureConfigured = () => {};
  dver.submit = async (payload) => {
    dverRequests.push(structuredClone(payload));
    return dverReply === 'ACCEPTED'
      ? { status: 'ACCEPTED', parcelNo: 'MOCK0138', receivedAt: new Date().toISOString() }
      : { status: 'SUBMISSION_FAILED' };
  };
  configureApplication(app, { log: () => {} });
  await app.listen(0, '127.0.0.1');
  base = (await app.getUrl()) + '/api';
  const login = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ loginId: 'billing138', password: 'billing-test-only' }),
  });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];
});

function finalBody(overrides = {}) {
  const address = {
    name: '결제 고객',
    phoneNumber: '01000138001',
    roadAddress: '검증로 1',
    jibunAddress: '검증동 1',
    detailAddress: '',
    dongName: '검증동',
    postalCode: '00138',
    latitude: 37.5,
    longitude: 127,
  };
  return {
    customerSeq: customerId,
    paymentMethodType: 'billing',
    pickupRequestedAt: new Date(Date.now() + 86400000).toISOString(),
    totalAmount: 12000,
    parcels: [3000, 5000, 4000].map((notifiedPrice) => ({
      origin: { ...address },
      destination: { ...address },
      smallBoxCount: 1,
      itemPrice: 0,
      notifiedPrice,
    })),
    ...overrides,
  };
}
async function createFinal(body = finalBody(), ai = false, key = randomUUID()) {
  const response = await fetch(base + (ai ? '/orders' : '/admin/orders'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
      ...(ai ? {} : { Cookie: cookie, Origin: origin }),
    },
    body: JSON.stringify(
      ai
        ? {
            ...body,
            outcome: 'COMPLETE',
            call: {
              providerCallId: randomUUID(),
              callerPhoneNumber: '01000138001',
              incomingAt: new Date().toISOString(),
            },
          }
        : body,
    ),
  });
  return { status: response.status, body: await response.json() };
}

test('personal card waits, partial cancellation replaces the request, and only the remaining amount can complete', async () => {
  const count = dverRequests.length;
  const created = await createFinal(finalBody(), true);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const order = created.body.data;
  assert.equal(order.status, 'notPaid');
  assert.equal(order.totalAmount, 12000);
  assert.equal(dverRequests.length, count);
  const original = order.paymentRequest;
  let detail = (await request(`/orders/${order.orderSeq}`, undefined, true, 'GET')).body.data;
  assert.equal(
    (
      await request(
        `/orders/${order.orderSeq}`,
        {
          expectedVersion: detail.version,
          parcels: [{ orderParcelSeq: detail.parcels[0].orderParcelSeq, clientComment: '변경' }],
        },
        true,
        'PATCH',
      )
    ).status,
    409,
  );
  const parcel = detail.parcels[1].orderParcelSeq;
  assert.equal(
    (await request(`/orders/${order.orderSeq}/parcels/cancel`, { orderParcelSeqs: [parcel] }, true))
      .status,
    204,
  );
  detail = (await request(`/orders/${order.orderSeq}`, undefined, true, 'GET')).body.data;
  assert.equal(detail.totalAmount, 7000);
  assert.equal(detail.paymentRequest.amount, 7000);
  assert.notEqual(detail.paymentRequest.paymentRequestId, original.paymentRequestId);
  assert.equal(detail.paymentRequest.expiresAt, original.expiresAt);
  await assert.rejects(
    () => payments.beginPayment(original.paymentRequestId, 12000),
    (e) => e.getStatus() === 409,
  );
  await assert.rejects(
    () => payments.beginPayment(detail.paymentRequest.paymentRequestId, 12000),
    (e) => e.getStatus() === 409,
  );
  const current = detail.paymentRequest.paymentRequestId;
  await payments.beginPayment(current, 7000);
  assert.equal((await request(`/orders/${order.orderSeq}/cancel`, undefined, true)).status, 409);
  await assert.rejects(
    () => payments.confirmPayment(current, 12000, 'test-' + current, randomUUID()),
    (e) => e.getStatus() === 409,
  );
  const result = await payments.confirmPayment(current, 7000, 'test-' + current, randomUUID());
  assert.equal(result.status, 'ACCEPTED');
  assert.equal(dverRequests.length, count + 1);
  assert.deepEqual(
    dverRequests.at(-1).outboundParcels.map((p) => p.notifiedPrice),
    [3000, 4000],
  );
  assert.equal(
    (await payments.confirmPayment(current, 7000, 'test-' + current, randomUUID())).status,
    'ACCEPTED',
  );
  assert.equal(dverRequests.length, count + 1);
  assert.equal((await request(`/orders/${order.orderSeq}/cancel`, undefined, true)).status, 409);
  const rows = await pool.query(
    "SELECT actor_type FROM audit_logs WHERE target_seq=$1 AND action='ORDER_PAYMENT_COMPLETED'",
    [order.orderSeq],
  );
  assert.deepEqual(rows.rows, [{ actor_type: 'SYSTEM' }]);
  const shipments = await pool.query(
    'SELECT s.status FROM shipments s JOIN order_parcels p USING(order_parcel_seq) WHERE p.order_seq=$1',
    [order.orderSeq],
  );
  assert.deepEqual(shipments.rows, [{ status: 'paid' }, { status: 'paid' }]);
});

test('monthly and group settlement require their own eligibility while corporate personal card remains allowed', async () => {
  const company = (await request('/companies', { name: '결제 자격 기업' })).body.data
    .organizationSeq;
  const department = (await request(`/companies/${company}/departments`, { name: '정산팀' })).body
    .data.departmentSeq;
  const phone = '010' + String(Math.floor(Math.random() * 90000000) + 10000000);
  const customer = (await request('/customers', { name: '정산 구성원', phoneNumber: phone })).body
    .data.customerSeq;
  assert.equal(
    (
      await request(`/companies/${company}/members`, {
        customerSeq: customer,
        employeeNo: 'B138',
        role: 'MEMBER',
        departmentSeq: department,
      })
    ).status,
    204,
  );
  assert.equal(
    (await createFinal(finalBody({ customerSeq: customer, paymentMethodType: 'credit' }))).status,
    403,
  );
  assert.equal(
    (await createFinal(finalBody({ customerSeq: customer, paymentMethodType: 'groupBilling' })))
      .status,
    403,
  );
  assert.equal(
    (await createFinal(finalBody({ customerSeq: customer }))).body.data.status,
    'notPaid',
  );
  await request(`/companies/${company}`, { monthlyBillingEnabled: true }, false, 'PATCH');
  const monthly = await createFinal(
    finalBody({ customerSeq: customer, paymentMethodType: 'credit' }),
  );
  assert.equal(monthly.body.data.status, 'ACCEPTED', JSON.stringify(monthly.body));
  assert.equal(monthly.body.data.paymentRequest, null);
  await request(`/departments/${department}`, { groupBillingEnabled: true }, false, 'PATCH');
  assert.equal(
    (await createFinal(finalBody({ customerSeq: customer, paymentMethodType: 'groupBilling' })))
      .body.data.status,
    'ACCEPTED',
  );
  assert.equal((await createFinal(finalBody({ paymentMethodType: 'groupBilling' }))).status, 403);
});

test('submission failure is retried on the same paid order without repeating payment or completed submissions', async () => {
  await request(`/customers/${customerId}`, { monthlyBillingEnabled: true }, false, 'PATCH');
  dverReply = 'SUBMISSION_FAILED';
  const failed = await createFinal(finalBody({ paymentMethodType: 'credit' }));
  assert.equal(failed.body.data.status, 'SUBMISSION_FAILED');
  const id = failed.body.data.orderSeq;
  const count = dverRequests.length;
  dverReply = 'ACCEPTED';
  assert.equal((await request(`/admin/orders/${id}/retry`, {})).body.data.status, 'ACCEPTED');
  assert.equal(dverRequests.length, count + 1);
  assert.equal((await request(`/admin/orders/${id}/retry`, {})).body.data.status, 'ACCEPTED');
  assert.equal(dverRequests.length, count + 1);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM audit_logs WHERE action='ORDER_PAYMENT_COMPLETED' AND target_seq=$1",
        [id],
      )
    ).rows[0].n,
    1,
  );
  await request(`/customers/${customerId}`, { monthlyBillingEnabled: false }, false, 'PATCH');
});

test('cancellation and payment approval serialize and invalid sums never create a finalized order', async () => {
  const invalid = finalBody({ totalAmount: 13000 });
  assert.equal((await createFinal(invalid)).status, 422);
  const missing = finalBody();
  delete missing.parcels[0].notifiedPrice;
  assert.equal((await createFinal(missing)).status, 422);
  const order = (await createFinal()).body.data;
  const [approval, cancel] = await Promise.allSettled([
    payments.beginPayment(order.paymentRequest.paymentRequestId, 12000),
    request(`/orders/${order.orderSeq}/cancel`, undefined, true),
  ]);
  if (approval.status === 'fulfilled') {
    assert.equal(cancel.value.status, 409);
    await payments.releaseDeclinedPayment(order.paymentRequest.paymentRequestId);
    assert.equal((await request(`/orders/${order.orderSeq}/cancel`, undefined, true)).status, 204);
  } else {
    assert.equal(approval.reason.getStatus(), 409);
    assert.equal(cancel.value.status, 204);
  }
});
after(async () => {
  await app?.close();
  await pool.end();
});

test('partial cancellation preserves parcel prices, recalculates the remainder and attributes AI work', async () => {
  const created = await fetch(base + '/orders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      Cookie: cookie,
      'Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify({
      customerSeq: customerId,
      totalAmount: 12000,
      parcels: [{ notifiedPrice: 3000 }, { notifiedPrice: 5000 }, { notifiedPrice: 4000 }],
    }),
  });
  assert.equal(created.status, 201);
  const id = (await created.json()).data.orderSeq;
  let detail = (await request('/orders/' + id, undefined, false, 'GET')).body.data;
  const parcel = detail.parcels[1].orderParcelSeq;
  assert.equal(
    (await request(`/orders/${id}/parcels/cancel`, { orderParcelSeqs: [parcel] }, true)).status,
    204,
  );
  detail = (await request('/orders/' + id, undefined, false, 'GET')).body.data;
  assert.equal(detail.totalAmount, 7000);
  assert.equal(detail.status, 'COLLECTING');
  assert.deepEqual(
    detail.parcels.map((p) => p.status),
    ['ACTIVE', 'CANCELLED', 'ACTIVE'],
  );
  assert.deepEqual(
    detail.parcels.map((p) => p.notifiedPrice),
    [3000, 5000, 4000],
  );
  const logs = await pool.query(
    "SELECT actor_type,metadata FROM audit_logs WHERE target_seq=$1 AND action='ORDER_AMOUNT_CHANGED'",
    [id],
  );
  assert.equal(logs.rowCount, 1);
  assert.equal(logs.rows[0].actor_type, 'AI');
  assert.deepEqual(logs.rows[0].metadata, {
    amountBefore: 12000,
    amountAfter: 7000,
    orderParcelSeqs: [parcel],
  });
  assert.equal(
    (await request(`/orders/${id}/parcels/cancel`, { orderParcelSeqs: [parcel] }, true)).status,
    204,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM audit_logs WHERE target_seq=$1 AND action='ORDER_AMOUNT_CHANGED'",
        [id],
      )
    ).rows[0].n,
    1,
  );
  assert.equal((await request(`/orders/${id}/cancel`, {}, true)).status, 204);
  detail = (await request('/orders/' + id, undefined, false, 'GET')).body.data;
  assert.equal(detail.status, 'CANCELLED');
  assert.equal(detail.totalAmount, 0);
  assert.ok(detail.parcels.every((p) => p.status === 'CANCELLED'));
});

test('department membership scopes monthly and group eligibility and only admins can change policy', async () => {
  const company = (await request('/companies', { name: '부서 결제 검증' })).body.data
    .organizationSeq;
  const other = (await request('/companies', { name: '다른 기업' })).body.data.organizationSeq;
  const first = await request(`/companies/${company}/departments`, { name: '개발팀' });
  assert.equal(first.status, 201);
  const department = first.body.data.departmentSeq;
  assert.equal(
    (await request(`/companies/${company}/departments`, undefined, false, 'GET')).body.data[0]
      .groupBillingEnabled,
    false,
  );
  const wrongDepartment = (await request(`/companies/${other}/departments`, { name: '외부팀' }))
    .body.data.departmentSeq;
  const phone = '010' + String(Math.floor(Math.random() * 90000000) + 10000000);
  const customer = (await request('/customers', { name: '기업 고객', phoneNumber: phone })).body
    .data.customerSeq;
  const member = {
    customerSeq: customer,
    employeeNo: '001',
    role: 'MEMBER',
    departmentSeq: wrongDepartment,
  };
  assert.equal((await request(`/companies/${company}/members`, member)).status, 422);
  member.departmentSeq = department;
  assert.equal((await request(`/companies/${company}/members`, member)).status, 204);
  let context = (await request('/customers/context', { phoneNumber: phone }, true)).body.data;
  assert.equal(context.membership.departmentSeq, department);
  assert.deepEqual(context.availablePaymentMethods, ['billing']);
  assert.equal(
    (await request(`/companies/${company}`, { monthlyBillingEnabled: true }, false, 'PATCH'))
      .status,
    204,
  );
  assert.equal(
    (await request(`/departments/${department}`, { groupBillingEnabled: true }, false, 'PATCH'))
      .status,
    204,
  );
  context = (await request('/customers/context', { phoneNumber: phone }, true)).body.data;
  assert.deepEqual(context.availablePaymentMethods, ['billing', 'credit', 'groupBilling']);
  assert.equal(
    (await request(`/departments/${department}`, { groupBillingEnabled: false }, false, 'PATCH'))
      .status,
    204,
  );
  context = (await request('/customers/context', { phoneNumber: phone }, true)).body.data;
  assert.deepEqual(context.availablePaymentMethods, ['billing', 'credit']);
  assert.equal(
    (await request(`/customers/${customer}`, { monthlyBillingEnabled: true }, true, 'PATCH'))
      .status,
    403,
  );
  assert.equal(
    (
      await request(
        '/customers',
        { name: '임의 자격 상승', phoneNumber: phone + '1', monthlyBillingEnabled: true },
        true,
      )
    ).status,
    403,
  );
  assert.equal(
    (await request(`/customers/${customerId}`, { monthlyBillingEnabled: true }, false, 'PATCH'))
      .status,
    204,
  );
  assert.deepEqual(
    (await request('/customers/context', { phoneNumber: '01000138001' }, true)).body.data
      .availablePaymentMethods,
    ['billing', 'credit'],
  );
  await request(`/customers/${customerId}`, { monthlyBillingEnabled: false }, false, 'PATCH');
});
