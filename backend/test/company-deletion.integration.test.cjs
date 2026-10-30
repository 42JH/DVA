require('reflect-metadata');
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomInt } = require('node:crypto');
const { Pool } = require('pg');
const { NestFactory } = require('@nestjs/core');
const { migrate } = require('./helpers/migrations.cjs');
const { configureApplication } = require('../dist/configure-application');
const { hashPassword } = require('../dist/auth/password');
const { DverClient } = require('../dist/orders/dver.client');
const { OrderPaymentsService } = require('../dist/orders/order-payments.service');
const {
  OrganizationBillingService,
} = require('../dist/organizations/organization-billing.service');
const { AuditService } = require('../dist/audit/audit.service');

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.DB_NAME, 'dva_webhook_test');
assert.ok(['127.0.0.1', 'db'].includes(process.env.DB_HOST));
process.env.CORS_ORIGINS = 'http://localhost:5173';
const { AppModule } = require('../dist/app.module');
const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});
const origin = 'http://localhost:5173';
let app,
  base,
  cookie,
  adminId,
  reply = 'ACCEPTED',
  dverHook;
let phoneSequence = randomInt(10000000, 80000000);
const address = {
  name: '배송 담당',
  phoneNumber: '01000103001',
  roadAddress: '보존로 1',
  jibunAddress: '보존동 1',
  detailAddress: '',
  dongName: '보존동',
  postalCode: '01030',
  latitude: 37.5,
  longitude: 127,
};
async function request(method, path, body, headers = {}) {
  const response = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: origin, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
}
before(async () => {
  await migrate(pool);
  adminId = (
    await pool.query(
      "INSERT INTO admin_users(login_id,name,password_hash,role,status) VALUES('deletion1030','삭제 운영자',$1,'SYSTEM_ADMIN','ACTIVE') ON CONFLICT(login_id) DO UPDATE SET password_hash=EXCLUDED.password_hash RETURNING admin_user_seq",
      [await hashPassword('deletion-test-only')],
    )
  ).rows[0].admin_user_seq;
  app = await NestFactory.create(AppModule, { logger: false });
  const dver = app.get(DverClient);
  dver.ensureConfigured = () => {};
  dver.submit = async () => {
    await dverHook?.();
    return reply === 'ACCEPTED'
      ? { status: 'ACCEPTED', parcelNo: 'MOCK1030', receivedAt: new Date().toISOString() }
      : { status: 'SUBMISSION_FAILED' };
  };
  configureApplication(app, { log: () => {} });
  await app.listen(0, '127.0.0.1');
  base = (await app.getUrl()) + '/api';
  const login = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ loginId: 'deletion1030', password: 'deletion-test-only' }),
  });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];
});
after(async () => {
  await app?.close();
  await pool.end();
});

async function fixture() {
  const company = (
    await request('POST', '/companies', { name: '기록 보존 기업', monthlyBillingEnabled: true })
  ).body.data.organizationSeq;
  const department = (
    await request('POST', `/companies/${company}/departments`, {
      name: '개발팀',
      groupBillingEnabled: true,
    })
  ).body.data.departmentSeq;
  const phone = '010' + phoneSequence++;
  const customer = (await request('POST', '/customers', { name: '소속 개인', phoneNumber: phone }))
    .body.data.customerSeq;
  assert.equal(
    (
      await request('POST', `/companies/${company}/members`, {
        customerSeq: customer,
        employeeNo: 'EMP-1',
        role: 'MEMBER',
        departmentSeq: department,
      })
    ).status,
    204,
  );
  const member = (
    await pool.query('SELECT membership_seq FROM memberships WHERE customer_seq=$1', [customer])
  ).rows[0].membership_seq;
  return { company, department, customer, member, phone };
}
async function companyPin(f, fields = {}) {
  const result = await request('POST', `/companies/${f.company}/pins`, {
    addressData: address,
    ...fields,
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body.data.companyPinSeq;
}
async function order(f, method = 'credit', fields = {}) {
  const result = await request(
    'POST',
    '/admin/orders',
    {
      customerSeq: f.customer,
      paymentMethodType: method,
      pickupRequestedAt: new Date(Date.now() + 86400000).toISOString(),
      totalAmount: 5000,
      parcels: [
        {
          origin: address,
          destination: address,
          smallBoxCount: 1,
          notifiedPrice: 5000,
          itemPrice: 0,
        },
      ],
      ...fields,
    },
    { 'Idempotency-Key': randomUUID() },
  );
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body.data;
}
async function detail(id) {
  return (await request('GET', `/orders/${id}`)).body.data;
}

test('PIN department identity survives rename, supports legacy names and rejects cross-company assignment', async () => {
  const f = await fixture(),
    other = await fixture();
  const pin = await companyPin(f, { departmentSeq: f.department });
  assert.equal(
    (
      await request('POST', `/companies/${f.company}/pins`, {
        departmentSeq: other.department,
        addressData: address,
      })
    ).status,
    422,
  );
  assert.equal(
    (await request('PATCH', `/departments/${f.department}`, { name: '플랫폼팀' })).status,
    204,
  );
  let pins = (await request('GET', `/companies/${f.company}/pins`)).body.data;
  assert.equal(pins[0].departmentSeq, f.department);
  assert.equal(pins[0].departmentName, '플랫폼팀');
  assert.equal(pins[0].version, 2);
  await companyPin(f, {
    departmentName: '  플랫폼팀 ',
    addressData: { ...address, roadAddress: '보존로 2' },
  });
  pins = (await request('GET', `/companies/${f.company}/pins`)).body.data;
  assert.equal(pins[1].departmentSeq, f.department);
  assert.equal(
    (await request('PATCH', `/company-pins/${pin}`, { departmentSeq: null })).status,
    200,
  );
  pins = (await request('GET', `/companies/${f.company}/pins`)).body.data;
  assert.equal(pins[0].departmentSeq, null);
  assert.equal(pins[0].departmentName, null);
});

test('settled company and department names are snapshots independent of subsequent renames', async () => {
  const f = await fixture();
  const created = await order(f, 'groupBilling');
  const before = await detail(created.orderSeq);
  assert.equal(before.billingOrganizationSeq, f.company);
  assert.equal(before.billingDepartmentSeq, f.department);
  assert.equal(before.billingOrganizationName, '기록 보존 기업');
  assert.equal(before.billingDepartmentName, '개발팀');
  await request('PATCH', `/companies/${f.company}`, { name: '변경된 회사' });
  await request('PATCH', `/departments/${f.department}`, { name: '변경된 팀' });
  assert.deepEqual(await detail(created.orderSeq), before);
  assert.equal(
    (await request('GET', `/companies/${f.company}/billing`)).body.data.organizationName,
    '기록 보존 기업',
  );
});
