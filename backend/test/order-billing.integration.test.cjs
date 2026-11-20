const { seedTestCard, configureTestCardPayments } = require('./helpers/payment-cards.cjs');
const { legacyOrderIntake } = require('./helpers/legacy-order-intake.cjs');
const customerAddress = require('./helpers/customer-address.cjs');
require('reflect-metadata');
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createTestSession, createTestPool, businessHeaders } = require('./helpers/application.cjs');
const { NestFactory } = require('@nestjs/core');
const { migrate } = require('./helpers/migrations.cjs');
const { configureApplication } = require('../dist/configure-application');

const { DverClient } = require('../dist/orders/dver.client');
const { OrderPaymentsService } = require('../dist/orders/order-payments.service');
const {
  OrganizationBillingService,
} = require('../dist/organizations/organization-billing.service');
const { OrderMaintenanceWorker } = require('../dist/orders/order-maintenance.worker');
const { AuditService } = require('../dist/audit/audit.service');
const { DatabaseService } = require('../dist/database/database.service');

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.DB_NAME, 'dva_webhook_test');
assert.ok(['127.0.0.1', 'db'].includes(process.env.DB_HOST));
process.env.CORS_ORIGINS = 'http://localhost:5173';
const { AppModule } = require('../dist/app.module');
const pool = createTestPool();
let app, base, cookie, customerId, callId, payments, billing, maintenance;
let dverRequests = [];
let dverReply = 'ACCEPTED';
const origin = 'http://localhost:5173';
async function request(path, body, ai = false, method = 'POST') {
  const response = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(ai
        ? { ...businessHeaders(), call_session_seq: String(callId) }
        : { Cookie: cookie, Origin: origin }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
}
before(async () => {
  await migrate(pool);
  const admin = await pool.query(
    "INSERT INTO admin_users(login_id,name,password_hash,role,status) VALUES('billing138','결제 운영자',$1,'SYSTEM_ADMIN','ACTIVE') ON CONFLICT(login_id) WHERE deleted_at IS NULL DO UPDATE SET password_hash=EXCLUDED.password_hash RETURNING admin_user_seq",
    ['not-for-login'],
  );
  customerId = (
    await pool.query(
      "INSERT INTO customers(name,phone_number,status) VALUES('결제 검증','01000138001','ACTIVE') ON CONFLICT(phone_number) WHERE deleted_at IS NULL DO UPDATE SET status='ACTIVE' RETURNING customer_seq",
    )
  ).rows[0].customer_seq;
  callId = (
    await pool.query(
      "INSERT INTO call_sessions(provider_call_id,caller_phone_number,order_intake_enabled) VALUES($1,'01000138001',false) RETURNING call_session_seq",
      [randomUUID()],
    )
  ).rows[0].call_session_seq;
  app = legacyOrderIntake(await NestFactory.create(AppModule, { logger: false }));
  configureTestCardPayments(app);
  payments = app.get(OrderPaymentsService);
  billing = app.get(OrganizationBillingService);
  maintenance = app.get(OrderMaintenanceWorker);
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
  cookie = await createTestSession(pool, admin.rows[0].admin_user_seq);
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
      itemPrice: 1,
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
      ...(ai ? businessHeaders() : { Cookie: cookie, Origin: origin }),
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
    () =>
      payments.claimApproval(original.paymentRequestId, 12000, 'test-' + original.paymentRequestId),
    (e) => e.getStatus() === 409,
  );
  await assert.rejects(
    () =>
      payments.claimApproval(detail.paymentRequest.paymentRequestId, 12000, 'test-invalid-amount'),
    (e) => e.getStatus() === 409,
  );
  const current = detail.paymentRequest.paymentRequestId;
  await payments.claimApproval(current, 7000, 'test-' + current);
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
  const company = (
    await request('/companies', { name: '결제 자격 기업', monthlyBillingEnabled: false })
  ).body.data.organizationSeq;
  const department = (await request(`/companies/${company}/departments`, { name: '정산팀' })).body
    .data.departmentSeq;
  const phone = '010' + String(Math.floor(Math.random() * 90000000) + 10000000);
  const customer = (
    await request('/customers', {
      address: customerAddress(),
      name: '정산 구성원',
      phoneNumber: phone,
    })
  ).body.data.customerSeq;
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
  await groupPolicy(company, customer, true);
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
  assert.equal(failed.body.data.status, 'SUBMITTING_FAILED');
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
    payments.claimApproval(order.paymentRequest.paymentRequestId, 12000, 'test-racing-approval'),
    request(`/orders/${order.orderSeq}/cancel`, undefined, true),
  ]);
  if (approval.status === 'fulfilled') {
    assert.equal(cancel.value.status, 409);
    await payments.releaseClaim(
      order.paymentRequest.paymentRequestId,
      approval.value.claimId,
      true,
    );
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
  const company = (
    await request('/companies', { name: '부서 결제 검증', monthlyBillingEnabled: false })
  ).body.data.organizationSeq;
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
  const customer = (
    await request('/customers', {
      address: customerAddress(),
      name: '기업 고객',
      phoneNumber: phone,
    })
  ).body.data.customerSeq;
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
  assert.equal((await groupPolicy(company, customer, true)).status, 204);
  context = (await request('/customers/context', { phoneNumber: phone }, true)).body.data;
  assert.deepEqual(context.availablePaymentMethods, ['billing', 'credit', 'groupBilling']);
  assert.equal((await groupPolicy(company, customer, false)).status, 204);
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
        {
          address: customerAddress(),
          name: '임의 자격 상승',
          phoneNumber: '01000138003',
          monthlyBillingEnabled: true,
        },
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

test('corporate totals count at payment completion once, retain previous months, and roll over at midnight KST', async () => {
  const company = (
    await request('/companies', { name: '월별 집계 검증', monthlyBillingEnabled: true })
  ).body.data.organizationSeq;
  const department = (
    await request(`/companies/${company}/departments`, {
      name: '월별 검증팀',
      groupBillingEnabled: true,
    })
  ).body.data.departmentSeq;
  const phone = '010' + String(Math.floor(Math.random() * 90000000) + 10000000);
  const customer = (
    await request('/customers', {
      address: customerAddress(),
      name: '월별 구성원',
      phoneNumber: phone,
    })
  ).body.data.customerSeq;
  await request(`/companies/${company}/members`, {
    customerSeq: customer,
    employeeNo: 'MONTH138',
    role: 'MEMBER',
    departmentSeq: department,
  });
  await groupPolicy(company, customer, true);
  const [monthly, group] = await Promise.all([
    createFinal(finalBody({ customerSeq: customer, paymentMethodType: 'credit' })),
    createFinal(finalBody({ customerSeq: customer, paymentMethodType: 'groupBilling' })),
  ]);
  assert.equal(monthly.body.data.status, 'ACCEPTED');
  assert.equal(group.body.data.status, 'ACCEPTED');
  let totals = (await request(`/companies/${company}/billing`, undefined, false, 'GET')).body.data;
  assert.equal(totals.monthlyAmount, 12000);
  assert.equal(totals.groupBillingAmount, 12000);
  await request(`/admin/orders/${group.body.data.orderSeq}/retry`, {});
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::int AS n FROM order_billing_charges WHERE organization_seq=$1',
        [company],
      )
    ).rows[0].n,
    2,
  );
  const oldMonth = totals.month;
  const [year, month] = oldMonth.split('-').map(Number);
  const nextBoundary = new Date(Date.UTC(year, month, 1) - 9 * 3600000);
  await billing.rollover(new Date(nextBoundary.getTime() - 1));
  assert.equal(
    (await request(`/companies/${company}/billing?month=${oldMonth}`, undefined, false, 'GET')).body
      .data.monthlyAmount,
    12000,
  );
  await billing.rollover(nextBoundary);
  await billing.rollover(nextBoundary);
  const newMonth = new Date(nextBoundary.getTime() + 9 * 3600000).toISOString().slice(0, 7);
  const fresh = (
    await request(`/companies/${company}/billing?month=${newMonth}`, undefined, false, 'GET')
  ).body.data;
  assert.equal(fresh.monthlyAmount, 0);
  assert.equal(fresh.groupBillingAmount, 0);
  assert.equal(
    (await request(`/companies/${company}/billing?month=${oldMonth}`, undefined, false, 'GET')).body
      .data.groupBillingAmount,
    12000,
  );
  const logs = await pool.query(
    "SELECT actor_type,metadata FROM audit_logs WHERE target_type='ORGANIZATION' AND target_seq=$1 AND action='BILLING_MONTH_INITIALIZED' AND metadata->>'billingMonth'=$2",
    [company, newMonth],
  );
  assert.equal(logs.rowCount, 2);
  assert.ok(
    logs.rows.every(
      (l) =>
        l.actor_type === 'SYSTEM' &&
        l.metadata.amountBefore === 12000 &&
        l.metadata.amountAfter === 0,
    ),
  );
  const before = (await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n;
  const audit = app.get(AuditService),
    record = audit.recordSuccess;
  audit.recordSuccess = function (event, client) {
    if (event.action === 'BILLING_AMOUNT_INCREASED') throw new Error('billing audit failure probe');
    return record.call(this, event, client);
  };
  try {
    assert.equal(
      (await createFinal(finalBody({ customerSeq: customer, paymentMethodType: 'credit' }))).status,
      500,
    );
  } finally {
    audit.recordSuccess = record;
  }
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n, before);
  totals = (
    await request(`/companies/${company}/billing?month=${oldMonth}`, undefined, false, 'GET')
  ).body.data;
  assert.equal(totals.monthlyAmount, 12000);
});

test('expiry preserves consultation and recordings, closes the payment request, and records SYSTEM once', async () => {
  const order = (await createFinal(finalBody(), true)).body.data;
  await pool.query('INSERT INTO recordings(call_session_seq,object_key) VALUES($1,$2)', [
    order.callSessionSeq,
    'test/expiry-' + randomUUID() + '.webm',
  ]);
  const future = new Date(Date.now() + 25 * 3600000);
  await maintenance.run(future);
  await maintenance.run(future);
  const detail = (await request(`/orders/${order.orderSeq}`, undefined, true, 'GET')).body.data;
  assert.equal(detail.status, 'CANCELLED');
  assert.equal(detail.totalAmount, 0);
  assert.equal(detail.paymentRequest, null);
  assert.ok(detail.parcels.every((p) => p.status === 'CANCELLED'));
  assert.equal(
    (
      await pool.query('SELECT count(*)::int AS n FROM recordings WHERE call_session_seq=$1', [
        order.callSessionSeq,
      ])
    ).rows[0].n,
    1,
  );
  const calls = (
    await request(
      `/calls?orderSeq=${order.orderSeq}&orderStatus=CANCELLED`,
      undefined,
      false,
      'GET',
    )
  ).body.data;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].orderStatus, 'CANCELLED');
  assert.equal(calls[0].orderTotalAmount, 0);
  const logs = (
    await request(
      `/audit-logs?actorType=SYSTEM&targetType=ORDER&targetSeq=${order.orderSeq}&action=ORDER_CANCELLED`,
      undefined,
      false,
      'GET',
    )
  ).body.data;
  assert.equal(logs.length, 1);
  assert.equal(logs[0].actorLabel, 'SYSTEM');
  assert.equal(logs[0].metadata.reason, 'PAYMENT_EXPIRED');
  await assert.rejects(
    () => payments.claimApproval(order.paymentRequest.paymentRequestId, 12000, 'test-expired'),
    (e) => e.getStatus() === 409,
  );
  const inFlight = (await createFinal()).body.data;
  const approval = await payments.claimApproval(
    inFlight.paymentRequest.paymentRequestId,
    12000,
    'test-in-flight',
  );
  await maintenance.run(future);
  assert.equal(
    (await request(`/orders/${inFlight.orderSeq}`, undefined, true, 'GET')).body.data.status,
    'notPaid',
  );
  await payments.releaseClaim(inFlight.paymentRequest.paymentRequestId, approval.claimId, true);
  await maintenance.run(future);
  assert.equal(
    (await request(`/orders/${inFlight.orderSeq}`, undefined, true, 'GET')).body.data.status,
    'CANCELLED',
  );
  const actor = (
    await pool.query("SELECT admin_user_seq FROM admin_users WHERE login_id='billing138'")
  ).rows[0].admin_user_seq;
  const operators = (
    await request(
      `/audit-logs?actorType=ADMIN&actorSeq=${actor}&limit=100`,
      undefined,
      false,
      'GET',
    )
  ).body.data;
  assert.ok(
    operators.length > 0 &&
      operators.every(
        (l) => l.actorLabel === '운영자' && l.actorSeq !== null && l.actorName === '결제 운영자',
      ),
  );
});

test('expiry commits ten independent orders before a later batch failure and retries the remainder atomically', async () => {
  const orders = [];
  for (let index = 0; index < 25; index++) {
    const response = await createFinal();
    assert.equal(response.status, 201);
    orders.push(response.body.data.orderSeq);
  }
  await pool.query("UPDATE orders SET payment_due_at='2000-01-01' WHERE order_seq=ANY($1::int[])", [
    orders,
  ]);
  const audit = app.get(AuditService),
    record = audit.recordSuccess;
  let attempts = 0;
  audit.recordSuccess = async function (event, ...args) {
    if (event.action === 'ORDER_CANCELLED' && orders.includes(event.targetId) && ++attempts === 11)
      throw Error('maintenance-batch-rollback');
    return record.call(this, event, ...args);
  };
  try {
    await assert.rejects(maintenance.run(), /maintenance-batch-rollback/);
  } finally {
    audit.recordSuccess = record;
  }
  const states = (
    await pool.query(
      'SELECT status,count(*)::int AS n FROM orders WHERE order_seq=ANY($1::int[]) GROUP BY status ORDER BY status',
      [orders],
    )
  ).rows;
  assert.deepEqual(states, [
    { status: 'CANCELLED', n: 10 },
    { status: 'notPaid', n: 15 },
  ]);
  await maintenance.run();
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM orders WHERE order_seq=ANY($1::int[]) AND status='CANCELLED' AND total_amount=0",
        [orders],
      )
    ).rows[0].n,
    25,
  );
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::int AS n FROM order_payment_requests WHERE order_seq=ANY($1::int[]) AND invalidated_at IS NULL AND completed_at IS NULL',
        [orders],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM audit_logs WHERE action='ORDER_CANCELLED' AND result='SUCCESS' AND target_seq=ANY($1::int[])",
        [orders],
      )
    ).rows[0].n,
    25,
  );
});

test('monthly initialization commits at most ten records per transaction and preserves all companies and audit pairs', async () => {
  const companies = (
    await pool.query(
      "INSERT INTO organizations(name,status) SELECT '월 배치 검증 '||n,'ACTIVE' FROM generate_series(1,25) n RETURNING organization_seq",
    )
  ).rows.map((row) => row.organization_seq);
  const database = app.get(DatabaseService),
    transaction = database.transaction,
    batches = [];
  database.transaction = (work) =>
    transaction.call(database, async (client) => {
      const query = client.query;
      let inserted = 0;
      client.query = async function (sql, ...args) {
        const result = await query.call(this, sql, ...args);
        if (/^\s*INSERT INTO organization_billing_months\b/.test(sql)) inserted += result.rowCount;
        return result;
      };
      try {
        return await work(client);
      } finally {
        client.query = query;
        batches.push(inserted);
      }
    });
  try {
    await billing.rollover();
  } finally {
    database.transaction = transaction;
  }
  assert.ok(batches.filter((count) => count > 0).length >= 3);
  assert.ok(batches.every((count) => count <= 10));
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::int AS n FROM organization_billing_months WHERE organization_seq=ANY($1::int[])',
        [companies],
      )
    ).rows[0].n,
    25,
  );
  await billing.rollover();
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM audit_logs WHERE action='BILLING_MONTH_INITIALIZED' AND target_seq=ANY($1::int[]) AND result='SUCCESS'",
        [companies],
      )
    ).rows[0].n,
    50,
  );
});

test('customer billing keeps the original personal charge across retries, edits and company enrollment', async () => {
  const customer = await request('/customers', {
    address: customerAddress(),
    name: '개인 월결제 검증',
    phoneNumber: '018' + String(Math.floor(Math.random() * 90000000) + 10000000),
    monthlyBillingEnabled: true,
  });
  assert.equal(customer.status, 201);
  const id = customer.body.data.customerSeq;
  const path = `/customers/${id}/billing`;
  const read = (suffix = '', ai = false) => request(path + suffix, undefined, ai, 'GET');
  const initial = await read();
  assert.equal(initial.status, 200);
  assert.equal(initial.body.data.monthlyAmount, 0);
  assert.equal((await read('?month=2026-13')).status, 400);
  assert.equal((await read('', true)).status, 401);

  const credit = finalBody({ customerSeq: id, paymentMethodType: 'credit' });
  const key = randomUUID();
  const personal = await createFinal(credit, false, key);
  assert.equal(personal.body.data.status, 'ACCEPTED', JSON.stringify(personal.body));
  const orderId = personal.body.data.orderSeq;
  assert.equal((await createFinal(credit, false, key)).body.data.orderSeq, orderId);
  const paidMonth = (
    await pool.query(
      "SELECT to_char(paid_at AT TIME ZONE 'Asia/Seoul','YYYY-MM') AS month FROM orders WHERE order_seq=$1",
      [orderId],
    )
  ).rows[0].month;
  const pending = await createFinal(finalBody({ customerSeq: id }));
  assert.equal(pending.body.data.status, 'notPaid');
  assert.equal((await request(`/orders/${pending.body.data.orderSeq}/cancel`, {})).status, 204);
  await pool.query('UPDATE orders SET total_amount=10000 WHERE order_seq=$1', [orderId]);

  const company = (
    await request('/companies', { name: '개인 청구 분리 검증', monthlyBillingEnabled: true })
  ).body.data.organizationSeq;
  const department = (
    await request(`/companies/${company}/departments`, {
      name: '그룹결제 검증',
      groupBillingEnabled: true,
    })
  ).body.data.departmentSeq;
  assert.equal(
    (
      await request(`/companies/${company}/members`, {
        customerSeq: id,
        employeeNo: 'PERSONAL-BILLING',
        role: 'MEMBER',
        departmentSeq: department,
      })
    ).status,
    204,
  );
  await groupPolicy(company, id, true);
  assert.equal((await createFinal(credit)).body.data.status, 'ACCEPTED');
  assert.equal(
    (await createFinal({ ...credit, paymentMethodType: 'groupBilling' })).body.data.status,
    'ACCEPTED',
  );
  const expected = { customerSeq: id, month: paidMonth, monthlyAmount: 12000 };
  assert.deepEqual((await read(`?month=${paidMonth}`)).body.data, expected);
  assert.deepEqual((await read()).body.data, expected);
  assert.equal((await read('?month=2099-01')).body.data.monthlyAmount, 0);
  const corporate = (
    await request(`/companies/${company}/billing?month=${paidMonth}`, undefined, false, 'GET')
  ).body.data;
  assert.equal(corporate.monthlyAmount, 12000);
  assert.equal(corporate.groupBillingAmount, 12000);
});

test('employees without departments retain corporate credit and cannot use group billing', async () => {
  const company = (
    await request('/companies', { name: '부서 없는 월결제 기업', monthlyBillingEnabled: true })
  ).body.data.organizationSeq;
  const phone = '017' + String(Math.floor(Math.random() * 90000000) + 10000000);
  const customer = (
    await request('/customers', {
      address: customerAddress(),
      name: '부서 없는 직원',
      phoneNumber: phone,
    })
  ).body.data.customerSeq;
  assert.equal(
    (
      await request(`/companies/${company}/members`, {
        customerSeq: customer,
        employeeNo: 'NO-DEPT',
        role: 'MEMBER',
      })
    ).status,
    204,
  );
  const context = (await request('/customers/context', { phoneNumber: phone })).body.data;
  assert.equal(context.membership.departmentSeq, null);
  assert.equal(context.department, null);
  assert.deepEqual(context.availablePaymentMethods, ['billing', 'credit']);
  const monthly = await createFinal(
    finalBody({ customerSeq: customer, paymentMethodType: 'credit' }),
  );
  assert.equal(monthly.status, 201, JSON.stringify(monthly.body));
  assert.equal(monthly.body.data.status, 'ACCEPTED');
  const saved = (
    await pool.query(
      'SELECT billing_organization_seq,billing_department_seq FROM orders WHERE order_seq=$1',
      [monthly.body.data.orderSeq],
    )
  ).rows[0];
  assert.deepEqual(saved, { billing_organization_seq: company, billing_department_seq: null });
  assert.equal(
    (await createFinal(finalBody({ customerSeq: customer, paymentMethodType: 'groupBilling' })))
      .status,
    403,
  );
  assert.equal(
    (await request(`/companies/${company}`, { monthlyBillingEnabled: false }, false, 'PATCH'))
      .status,
    204,
  );
  assert.equal(
    (await createFinal(finalBody({ customerSeq: customer, paymentMethodType: 'credit' }))).status,
    403,
  );
});

test('company credit charges keep ledger scope, parcel order and filtered totals across pages', async () => {
  const company = (
    await request('/companies', { name: '청구 내역 검증 기업', monthlyBillingEnabled: true })
  ).body.data.organizationSeq;
  const department = (
    await request(`/companies/${company}/departments`, {
      name: '청구 내역 발송팀',
      groupBillingEnabled: true,
    })
  ).body.data.departmentSeq;
  const makeCustomer = async (name, phoneNumber) => {
    const created = await request('/customers', { name, phoneNumber, address: customerAddress() });
    assert.equal(created.status, 201);
    return created.body.data.customerSeq;
  };
  const customer = await makeCustomer('청구 내역 회사 고객', '01000138988');
  assert.equal(
    (
      await request(`/companies/${company}/members`, {
        customerSeq: customer,
        employeeNo: 'CHARGE-DETAILS',
        role: 'MEMBER',
        departmentSeq: department,
      })
    ).status,
    204,
  );
  await groupPolicy(company, customer, true);

  const credit = finalBody({ customerSeq: customer, paymentMethodType: 'credit' });
  credit.parcels[0].origin = {
    ...credit.parcels[0].origin,
    name: '원장 발송인',
    roadAddress: '발송로 12',
    detailAddress: '3층',
  };
  credit.parcels[1].destination = {
    ...credit.parcels[1].destination,
    name: '두번째 수령인',
    roadAddress: '수령로 34',
    detailAddress: '502호',
  };
  credit.parcels[1].otherItemDescription = '별도 물품';
  const first = (await createFinal(credit)).body.data;
  const second = (
    await createFinal(
      finalBody({
        customerSeq: customer,
        paymentMethodType: 'credit',
      }),
    )
  ).body.data;
  const group = (
    await createFinal(
      finalBody({
        customerSeq: customer,
        paymentMethodType: 'groupBilling',
      }),
    )
  ).body.data;
  const individual = await makeCustomer('청구 내역 개인 고객', '01000138989');
  assert.equal(
    (await request(`/customers/${individual}`, { monthlyBillingEnabled: true }, false, 'PATCH'))
      .status,
    204,
  );
  const personal = (
    await createFinal(
      finalBody({
        customerSeq: individual,
        paymentMethodType: 'credit',
      }),
    )
  ).body.data;
  for (const order of [first, second, group, personal]) assert.equal(order.status, 'ACCEPTED');

  const ledger = (
    await pool.query(
      "SELECT to_char(billing_month,'YYYY-MM') AS month,occurred_at FROM order_billing_charges WHERE order_seq=$1",
      [first.orderSeq],
    )
  ).rows[0];
  await pool.query(
    'UPDATE order_billing_charges SET occurred_at=(SELECT occurred_at FROM order_billing_charges WHERE order_seq=$2) WHERE order_seq=$1',
    [second.orderSeq, first.orderSeq],
  );
  const path = `/companies/${company}/billing/charges`;
  const readCharges = async (params = {}) => {
    const response = await request(
      path + '?' + new URLSearchParams({ month: ledger.month, ...params }),
      undefined,
      false,
      'GET',
    );
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.match(response.body.meta.requestId, /^[0-9a-f-]{36}$/i);
    return response.body;
  };

  const summary = (
    await request(`/companies/${company}/billing?month=${ledger.month}`, undefined, false, 'GET')
  ).body.data;
  const all = await readCharges({ q: '' });
  assert.deepEqual(
    all.data.map((row) => row.orderSeq),
    [second.orderSeq, first.orderSeq],
  );
  assert.equal(all.total_count, 2);
  assert.equal(all.total_amount, summary.monthlyAmount);
  assert.equal(all.total_amount, 24000);
  assert.equal(all.hasNext, false);
  const page = await readCharges({ limit: '1' });
  assert.deepEqual(
    page.data.map((row) => row.orderSeq),
    [second.orderSeq],
  );
  assert.equal(page.hasNext, true);
  assert.equal(page.total_count, 2);
  assert.equal(page.total_amount, all.total_amount);
  const tail = await readCharges({ limit: '1', offset: '1' });
  assert.equal(tail.hasNext, false);
  const [line] = tail.data;
  assert.equal(line.orderSeq, first.orderSeq);
  assert.equal(line.paidAt, ledger.occurred_at.toISOString());
  assert.equal(line.amount, 12000);
  assert.equal(line.orderCancelled, false);
  assert.deepEqual(line.sender, {
    name: '원장 발송인',
    phoneNumber: '01000138001',
    departmentName: '청구 내역 발송팀',
    address: '발송로 12 3층',
  });
  assert.deepEqual(
    line.parcels.map((parcel) => parcel.recipient.name),
    ['결제 고객', '두번째 수령인', '결제 고객'],
  );
  assert.equal(line.parcels[0].items.other, null);
  assert.deepEqual(line.parcels[1], {
    cancelled: false,
    recipient: { name: '두번째 수령인', phoneNumber: '01000138001', address: '수령로 34 502호' },
    items: { document: 0, small: 1, medium: 0, big: 0, other: '별도 물품' },
  });
  const beyond = await readCharges({ offset: '10' });
  assert.deepEqual(beyond.data, []);
  assert.equal(beyond.total_count, 2);
  assert.equal(beyond.total_amount, 24000);
  for (const q of [
    '발송인',
    '두번째',
    String(first.orderSeq),
    'dv-' + String(first.orderSeq).padStart(5, '0'),
  ]) {
    const filtered = await readCharges({ q });
    assert.deepEqual(
      filtered.data.map((row) => row.orderSeq),
      [first.orderSeq],
      q,
    );
    assert.equal(filtered.total_count, 1, q);
    assert.equal(filtered.total_amount, 12000, q);
  }
  for (const params of [{ month: '2099-02' }, { q: '%' }]) {
    const empty = await readCharges(params);
    assert.deepEqual(empty.data, []);
    assert.equal(empty.hasNext, false);
    assert.equal(empty.total_count, 0);
    assert.equal(empty.total_amount, 0);
  }

  const transferred = (
    await request('/companies', { name: '청구 내역 이직 기업', monthlyBillingEnabled: true })
  ).body.data.organizationSeq;
  await pool.query(
    'UPDATE memberships SET deleted_at=clock_timestamp() WHERE organization_seq=$1 AND customer_seq=$2',
    [company, customer],
  );
  assert.equal(
    (
      await request(`/companies/${transferred}/members`, {
        customerSeq: customer,
        employeeNo: 'CHARGE-TRANSFER',
        role: 'MEMBER',
      })
    ).status,
    204,
  );
  assert.deepEqual((await readCharges()).data, all.data);
  const destination = (
    await request(
      `/companies/${transferred}/billing/charges?month=${ledger.month}`,
      undefined,
      false,
      'GET',
    )
  ).body;
  assert.deepEqual(destination.data, []);
  assert.equal(destination.total_count, 0);
  await pool.query(
    'UPDATE memberships SET deleted_at=clock_timestamp() WHERE organization_seq=$1 AND customer_seq=$2',
    [transferred, customer],
  );
  assert.deepEqual((await readCharges()).data, all.data);
});

test('company charges require a session, a valid month and supported pagination filters', async () => {
  const company = (await request('/companies', { name: '청구 요청 검증 기업' })).body.data
    .organizationSeq;
  const path = `/companies/${company}/billing/charges`;
  const month = '?month=2026-11';
  assert.equal((await fetch(base + path + month)).status, 401);
  assert.equal((await request(path + month, undefined, true, 'GET')).status, 401);
  const missing = await request(
    '/companies/2147483647/billing/charges' + month,
    undefined,
    false,
    'GET',
  );
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'NOT_FOUND');
  assert.equal(missing.body.error.message, '기업을 찾을 수 없습니다.');
  for (const suffix of [
    '',
    '?month=2026-13',
    '?month=0000-11',
    month + '&limit=0',
    month + '&limit=101',
    month + '&offset=-1',
    month + '&unknown=1',
    month + '&q=%00',
    month + '&q=' + 'x'.repeat(201),
  ]) {
    const invalid = await request(path + suffix, undefined, false, 'GET');
    assert.equal(invalid.status, 400, suffix);
    assert.equal(invalid.body.error.code, 'INVALID_REQUEST', suffix);
  }
  const { SwaggerModule, DocumentBuilder } = require('@nestjs/swagger');
  const spec = SwaggerModule.createDocument(app, new DocumentBuilder().build());
  const route = spec.paths['/api/companies/{id}/billing/charges'].get;
  assert.deepEqual(route.security, [{ adminSession: [] }]);
  assert.equal(route.parameters.find((param) => param.name === 'month').required, true);
  assert.equal(route.parameters.find((param) => param.name === 'limit').schema.default, 50);
});

async function groupPolicy(company, customer, enabled) {
  if (enabled) await seedTestCard(pool, 'ORGANIZATION', company);
  const member = (
    await pool.query(
      'SELECT membership_seq FROM memberships WHERE customer_seq=$1 AND organization_seq=$2 AND deleted_at IS NULL',
      [customer, company],
    )
  ).rows[0].membership_seq;
  return request('/members/' + member, { groupBillingEnabled: enabled }, false, 'PATCH');
}
