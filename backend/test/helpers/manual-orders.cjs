const { legacyOrderIntake } = require('./legacy-order-intake.cjs');
const { testMembership } = require('./membership.cjs');
require('reflect-metadata');
const { before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomInt } = require('node:crypto');
const { createServer } = require('node:http');
const { createTestPool, createTestSession } = require('./application.cjs');
const { NestFactory } = require('@nestjs/core');
const { ConfigService } = require('@nestjs/config');

module.exports = function manualOrders() {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.DB_NAME, 'dva_webhook_test');
  assert.ok(['db', '127.0.0.1'].includes(process.env.DB_HOST));
  process.env.SWAGGER_ENABLED = 'true';
  process.env.CORS_ORIGINS = 'http://localhost:5173';
  const { AppModule } = require('../../dist/app.module');
  const { configureApplication } = require('../../dist/configure-application');
  const pool = createTestPool();
  const origin = 'http://localhost:5173';
  const f = { pool, origin, apps: [], cookies: [], adminIds: [], requests: [] };
  f.address = {
    name: '수기 접수 고객',
    phoneNumber: '01000690001',
    roadAddress: '검증로 69',
    jibunAddress: '검증동 69',
    detailAddress: '',
    dongName: '검증동',
    postalCode: '00069',
  };
  f.success = { ok: true, parcelNo: 'TEST0069', receivedAt: '2026-10-28T10:00:00+09:00' };
  f.phone = () => '010' + randomInt(10000000, 100000000);
  f.body = () => ({
    customerSeq: f.customerId,
    paymentMethodType: 'credit',
    totalAmount: 3500,
    pickupRequestedAt: new Date(Date.now() + 86400000).toISOString(),
    parcels: [
      {
        origin: { ...f.address },
        destination: { ...f.address },
        smallBoxCount: 2,
        itemPrice: 10000,
        notifiedPrice: 3500,
      },
    ],
  });
  f.start = async () => {
    const app = legacyOrderIntake(await NestFactory.create(AppModule, { logger: false }));
    f.apps.push(app);
    configureApplication(app, { log: () => {} });
    app.get(ConfigService).set('DVER_API_URL', f.dverUrl);
    app.get(ConfigService).set('DVER_API_KEY', 'manual-test-only-key');
    await app.listen(0, '127.0.0.1');
    return app;
  };
  f.post = (path, body, key = randomUUID(), actor = 0, headers = {}, host = f.host) =>
    fetch(host + path, {
      method: 'POST',
      headers: Object.fromEntries(
        Object.entries({
          Origin: origin,
          Cookie: f.cookies[actor],
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
          ...headers,
        }).filter(([, value]) => value !== undefined),
      ),
      body: JSON.stringify(body),
    });
  f.send = (body = f.body(), key = randomUUID(), actor = 0, headers = {}, host = f.host) =>
    f.post('/api/admin/orders', body, key, actor, headers, host);
  f.get = (path, actor = 0) => fetch(f.host + path, { headers: { Cookie: f.cookies[actor] } });
  f.counts = async () =>
    (
      await pool.query(`SELECT
    (SELECT count(*) FROM orders)::int AS orders,
    (SELECT count(*) FROM order_parcels)::int AS parcels,
    (SELECT count(*) FROM customers)::int AS customers,
    (SELECT count(*) FROM call_sessions)::int AS calls,
    (SELECT count(*) FROM shipments)::int AS shipments`)
    ).rows[0];
  f.error = async (response, status, code) => {
    assert.equal(response.status, status);
    const body = await response.json();
    assert.equal(body.error.code, code);
    assert.ok(body.meta.requestId);
    return body;
  };
  before(async () => {
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='creation_source'",
        )
      ).rows[0].n,
      1,
      'Apply migrations through 012 before these tests',
    );
    f.server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      f.requests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: JSON.parse(body),
      });
      f.respond(request, response);
    });
    await new Promise((resolve) => f.server.listen(0, '127.0.0.1', resolve));
    f.dverUrl = `http://127.0.0.1:${f.server.address().port}/parcel`;
    f.app = await f.start();
    f.host = await f.app.getUrl();
    for (const role of ['OPERATOR', 'SUPERVISOR', 'SYSTEM_ADMIN']) {
      const loginId = 'manual' + randomUUID().replaceAll('-', '').slice(0, 14);
      f.adminIds.push(
        (
          await pool.query(
            "INSERT INTO admin_users(login_id,name,password_hash,role,status) VALUES($1,'수기 검증','not-for-login',$2,'ACTIVE') RETURNING admin_user_seq",
            [loginId, role],
          )
        ).rows[0].admin_user_seq,
      );
      f.cookies.push(await createTestSession(pool, f.adminIds.at(-1)));
    }
    f.customerId = (
      await pool.query(
        "INSERT INTO customers(name,phone_number,status) VALUES('수기 검증',$1,'ACTIVE') RETURNING customer_seq",
        [f.phone()],
      )
    ).rows[0].customer_seq;
    f.otherId = (
      await pool.query(
        "INSERT INTO customers(name,phone_number,status) VALUES('다른 고객',$1,'ACTIVE') RETURNING customer_seq",
        [f.phone()],
      )
    ).rows[0].customer_seq;
    f.withdrawnId = (
      await pool.query(
        "INSERT INTO customers(name,phone_number,status) VALUES('탈퇴 고객',$1,'WITHDRAWN') RETURNING customer_seq",
        [f.phone()],
      )
    ).rows[0].customer_seq;
    f.organizationId = (
      await pool.query(
        "INSERT INTO organizations(name,status) VALUES('수기 기업','ACTIVE') RETURNING organization_seq",
      )
    ).rows[0].organization_seq;
    await testMembership(pool, {
      customerSeq: f.customerId,
      organizationSeq: f.organizationId,
      employeeNo: 'manual69',
      groupBillingEnabled: true,
    });
    await pool.query(
      'UPDATE customers SET monthly_billing_enabled=true WHERE customer_seq=ANY($1::int[])',
      [[f.customerId, f.otherId]],
    );
    await pool.query(
      'UPDATE organizations SET monthly_billing_enabled=true WHERE organization_seq=$1',
      [f.organizationId],
    );
    f.pinId = (
      await pool.query(
        'INSERT INTO personal_pins(customer_seq,address_data) VALUES($1,$2) RETURNING personal_pin_seq',
        [f.customerId, f.address],
      )
    ).rows[0].personal_pin_seq;
    f.otherPinId = (
      await pool.query(
        'INSERT INTO personal_pins(customer_seq,address_data) VALUES($1,$2) RETURNING personal_pin_seq',
        [f.otherId, f.address],
      )
    ).rows[0].personal_pin_seq;
  });
  beforeEach(() => {
    f.requests.length = 0;
    f.respond = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(f.success));
    };
  });
  after(async () => {
    for (const app of f.apps) await app.close();
    f.server?.closeAllConnections();
    if (f.server) await new Promise((resolve) => f.server.close(resolve));
    await pool.end();
  });
  return f;
};
