require('reflect-metadata');
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { NestFactory } = require('@nestjs/core');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.DB_NAME, 'dva_webhook_test');
assert.ok(['db', '127.0.0.1'].includes(process.env.DB_HOST));
process.env.SWAGGER_ENABLED = 'true';
const { AppModule } = require('../dist/app.module');
const { configureApplication } = require('../dist/configure-application');
const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});
let app, host;
before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  configureApplication(app, { log: () => {} });
  await app.listen(0, '127.0.0.1');
  host = await app.getUrl();
});
after(async () => {
  await app?.close();
  await pool.end();
});
const post = (path, body) =>
  fetch(host + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
const counts = async () =>
  (
    await pool.query(
      'SELECT (SELECT count(*) FROM orders) AS orders, (SELECT count(*) FROM order_parcels) AS parcels, (SELECT count(*) FROM customers) AS customers',
    )
  ).rows[0];
const address = {
  name: '발송 고객',
  phoneNumber: '01012345678',
  roadAddress: '검증로 1',
  jibunAddress: '검증동 1',
  dongName: '검증동',
  postalCode: '00001',
  latitude: 0,
  longitude: 0,
};

test('AI validates one complete payload without administrator credentials or database writes', async () => {
  const before = await counts();
  const response = await post('/api/orders/validation', {
    paymentMethodType: 'credit',
    pickupRequestedAt: new Date(Date.now() + 86400000).toISOString(),
    parcels: [{ origin: address, destination: address, smallBoxCount: 1, itemPrice: 0 }],
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.data, { valid: true });
  assert.match(body.meta.requestId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(await counts(), before);
});

test('AI receives complete missing-field details and invalid shapes never create drafts', async () => {
  const before = await counts();
  const response = await post('/api/orders/validation', {});
  assert.equal(response.status, 422);
  const body = await response.json();
  assert.equal(body.error.code, 'VALIDATION_FAILED');
  assert.deepEqual(
    body.error.details.map((x) => x.field),
    ['paymentMethodType', 'pickupRequestedAt', 'parcels'],
  );
  assert.equal((await post('/api/orders/validation', { parcels: [{ origin: [] }] })).status, 400);
  assert.equal((await post('/api/orders', {})).status, 404);
  assert.deepEqual(await counts(), before);
});

test('MVP AI exception stays on explicit methods and Swagger no longer advertises manual order creation', async () => {
  assert.equal((await fetch(host + '/api/companies')).status, 401);
  assert.equal((await fetch(host + '/api/audit-logs')).status, 401);
  assert.equal(
    (await post('/api/auth/login', { loginId: 'admin', password: 'fake-test' })).status,
    403,
  );
  const spec = await (await fetch(host + '/api/docs-json')).json();
  assert.ok(!spec.paths['/api/orders']);
  assert.equal(spec.paths['/api/orders/validation'].post.security, undefined);
  assert.ok(spec.paths['/api/orders/validation'].post.responses['422']);
});
