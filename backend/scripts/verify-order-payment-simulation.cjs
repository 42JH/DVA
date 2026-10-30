// Use only with a disposable PostgreSQL and the local Postman simulation.
require('reflect-metadata');
const assert = require('node:assert/strict');
const { randomUUID, randomInt } = require('node:crypto');
const { Pool } = require('pg');
const { NestFactory } = require('@nestjs/core');
const { ConfigService } = require('@nestjs/config');
const { migrate } = require('../test/helpers/migrations.cjs');
const { hashPassword } = require('../dist/auth/password');
const { configureApplication } = require('../dist/configure-application');
const { PaymentsWorker } = require('../dist/payments/payments.worker');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.DB_NAME, 'dva_webhook_test');
assert.ok(['127.0.0.1', 'db'].includes(process.env.DB_HOST));
const simulation = process.env.PAYMENT_TEST_SIMULATION_URL || 'http://127.0.0.1:4598';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(simulation).hostname));
const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});
let app, browser;
async function run() {
  await migrate(pool);
  const front = 'http://127.0.0.1:5173';
  Object.assign(process.env, {
    ORDER_PAYMENTS_ENABLED: 'true',
    PAYMENT_PUBLIC_URL: front + '/api/payments',
    CORS_ORIGINS: front,
    TOSS_TEST_CLIENT_KEY: 'test_gck_fixture',
    TOSS_TEST_SECRET_KEY: 'test_gsk_fixture',
    PAYMENT_TOSS_BASE_URL: simulation + '/toss',
    PAYMENT_MATTERMOST_WEBHOOK_URL: simulation + '/mattermost/hooks/test',
    DVER_API_URL: simulation + '/dver/parcel',
    DVER_API_KEY: 'dver-fixture',
  });
  const loginId = 'sim' + randomUUID().replace(/-/g, '').slice(0, 12),
    password = 'simulation-fixture-only',
    phone = '010' + randomInt(10000000, 100000000);
  await pool.query(
    "INSERT INTO admin_users(login_id,name,password_hash,role,status) VALUES($1,'시뮬레이션',$2,'SYSTEM_ADMIN','ACTIVE')",
    [loginId, await hashPassword(password)],
  );
  const customer = (
    await pool.query(
      "INSERT INTO customers(name,phone_number,status) VALUES('시뮬레이션',$1,'ACTIVE') RETURNING customer_seq",
      [phone],
    )
  ).rows[0].customer_seq;
  const { AppModule } = require('../dist/app.module');
  app = await NestFactory.create(AppModule, { logger: false });
  configureApplication(app, { log: () => {} });
  await app.listen(0, '127.0.0.1');
  const origin = await app.getUrl(),
    base = origin + '/api';
  app.get(ConfigService).set('PAYMENT_PUBLIC_URL', base + '/payments');
  app.get(ConfigService).set('CORS_ORIGINS', [origin, front]);
  const login = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: front },
    body: JSON.stringify({ loginId, password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const post = async (path, body, admin = false, extra = {}) => {
    const r = await fetch(base + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        ...(admin ? { Cookie: cookie } : {}),
        ...extra,
      },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  const address = {
    name: '시뮬레이션 수령인',
    phoneNumber: phone,
    roadAddress: '검증로 21',
    jibunAddress: '검증동 21',
    detailAddress: '',
    dongName: '검증동',
    postalCode: '00021',
    latitude: 37.5,
    longitude: 127,
  };
  const create = async (comment = '') => {
    const r = await post(
      '/admin/orders',
      {
        customerSeq: customer,
        paymentMethodType: 'billing',
        totalAmount: 3500,
        parcels: [
          {
            origin: address,
            destination: address,
            smallBoxCount: 1,
            itemPrice: 0,
            notifiedPrice: 3500,
            clientComment: comment,
          },
        ],
      },
      true,
      { 'Idempotency-Key': randomUUID() },
    );
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.data;
  };
  for (const mode of ['ok', 'uncertain', 'dver-reject']) {
    const r = await create(mode === 'dver-reject' ? 'reject' : ''),
      id = r.paymentRequest.paymentRequestId;
    await app.get(PaymentsWorker).run();
    const input = {
      orderId: id,
      amount: 3500,
      paymentKey: (mode === 'uncertain' ? 'uncertain_' : 'ok_') + id,
    };
    const first = await post(`/payments/requests/${id}/confirm`, input);
    if (mode === 'uncertain') {
      assert.equal(first.status, 502);
      assert.equal((await post(`/payments/requests/${id}/reconcile`, {})).status, 200);
    } else assert.equal(first.status, 200);
    const o = (
      await pool.query('SELECT status,paid_at,pickup_requested_at FROM orders WHERE order_seq=$1', [
        r.orderSeq,
      ])
    ).rows[0];
    assert.equal(o.status, mode === 'dver-reject' ? 'SUBMISSION_FAILED' : 'ACCEPTED');
    assert.equal(o.pickup_requested_at.getTime() - o.paid_at.getTime(), 3600000);
    console.log('Verified real order with Postman simulation: ' + mode);
  }
  if (process.env.PAYMENT_TEST_PLAYWRIGHT_MODULE) {
    const { chromium } = require(process.env.PAYMENT_TEST_PLAYWRIGHT_MODULE);
    browser = await chromium.launch({
      headless: true,
      ...(process.env.PAYMENT_TEST_CHROME_PATH
        ? { executablePath: process.env.PAYMENT_TEST_CHROME_PATH }
        : {}),
    });
    const page = await browser.newPage({ viewport: { width: 375, height: 950 } }),
      errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('https://js.tosspayments.com/v2/standard', (route) =>
      route.fulfill({
        contentType: 'text/javascript',
        body: `
   window.TossPayments=function(){return {widgets(){return {async setAmount(a){if(a.value!==3500)throw Error('Wrong amount');},async renderPaymentMethods({selector}){document.querySelector(selector).textContent='모형 결제수단';},async renderAgreement({selector}){document.querySelector(selector).textContent='모형 이용약관';},async requestPayment(p){const u=new URL(p.successUrl);u.search=new URLSearchParams({orderId:p.orderId,amount:'3500',paymentKey:'ok_'+p.orderId});location.assign(u.href);}}}}};TossPayments.ANONYMOUS='ANONYMOUS';`,
      }),
    );
    const r = await create(),
      id = r.paymentRequest.paymentRequestId;
    await page.goto(base + '/payments/p/' + id);
    await page.waitForFunction(() => !document.querySelector('#pay').disabled);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    assert.ok((await page.locator('.card').textContent()).includes('결제 완료 후 1시간 뒤'));
    await page.locator('#pay').click();
    await page.waitForFunction(() =>
      document.querySelector('#status').textContent.includes('택배 접수가 완료'),
    );
    assert.equal(new URL(page.url()).search, '');
    await page.reload();
    await page.waitForFunction(() =>
      document.querySelector('#status').textContent.includes('택배 접수가 완료'),
    );
    assert.deepEqual(errors, []);
    console.log(
      'Browser real-order checkout, callback, Dver status, reload and mobile layout passed',
    );
  }
}
run()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (browser) await browser.close();
    if (app) await app.close();
    await pool.end();
  });
