require('reflect-metadata');
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { NestFactory } = require('@nestjs/core');
const { migrate } = require('./helpers/migrations.cjs');
const { configureApplication } = require('../dist/configure-application');
const { hashPassword } = require('../dist/auth/password');

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
let app, base, cookie, customerId, callId;
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
