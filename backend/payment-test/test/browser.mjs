// Optional browser verification: an installed Playwright module and local Postman simulation are required.
// Only the Toss browser SDK is replaced; our page, HTTP endpoints and approval client run unchanged.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { configuration } from '../config.mjs';
import { PaymentStore } from '../store.mjs';
import { PaymentTestService } from '../service.mjs';
import { TossTestClient, MattermostSender } from '../clients.mjs';
import { paymentServer } from '../server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PAYMENT_TEST_PLAYWRIGHT_MODULE || 'playwright');
const temporaryRoot = process.env.PAYMENT_TEST_TMP_ROOT || tmpdir();
const directory = await mkdtemp(join(temporaryRoot, 'dva-payment-browser-'));
const port = Number(process.env.PAYMENT_TEST_BROWSER_PORT || 4599);
const origin = `http://127.0.0.1:${port}`;
let browser, server;
try {
  const simulation = process.env.PAYMENT_TEST_SIMULATION_URL || 'http://127.0.0.1:4598';
  const config = configuration({
    NODE_ENV: 'test',
    PAYMENT_TEST_ENABLED: 'true',
    PORT: String(port),
    PAYMENT_TEST_DATA_DIR: directory,
    PAYMENT_TEST_PUBLIC_URL: origin + '/payment-test',
    TOSS_TEST_CLIENT_KEY: 'test_gck_fixture',
    TOSS_TEST_SECRET_KEY: 'test_gsk_fixture',
    PAYMENT_TEST_OPERATOR_TOKEN: 'a'.repeat(32),
    MATTERMOST_WEBHOOK_URL: simulation + '/mattermost/hooks/test',
    PAYMENT_TEST_TOSS_BASE_URL: simulation + '/toss',
  });
  const store = new PaymentStore(directory);
  await store.initialize();
  const service = new PaymentTestService(
    config,
    store,
    new TossTestClient(config),
    new MattermostSender(config),
  );
  server = await paymentServer(config, service);
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PAYMENT_TEST_CHROME_PATH
      ? { executablePath: process.env.PAYMENT_TEST_CHROME_PATH }
      : {}),
  });
  const page = await browser.newPage({ viewport: { width: 375, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('https://js.tosspayments.com/v2/standard', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `
      window.TossPayments = function(clientKey) {
        if (clientKey !== 'test_gck_fixture') throw Error('Unexpected client key');
        return { widgets(options) {
          if (options.customerKey !== 'ANONYMOUS') throw Error('Unexpected customer');
          return {
            async setAmount(amount) { if(amount.currency!=='KRW'||amount.value!==1000) throw Error('Wrong amount'); },
            async renderPaymentMethods({selector}) { document.querySelector(selector).textContent = '모형 결제수단'; },
            async renderAgreement({selector}) { document.querySelector(selector).textContent = '모형 이용약관'; },
            async requestPayment(input) {
              const url = new URL(input.successUrl);
              url.search = new URLSearchParams({orderId:input.orderId,paymentKey:'ok_'+input.orderId,amount:'1000'});
              location.assign(url.href);
            }
          };
        }};
      }; window.TossPayments.ANONYMOUS = 'ANONYMOUS';`,
    }),
  );
  const r = await service.createSample();
  await page.goto(r.paymentUrl);
  await page.waitForFunction(() => !document.querySelector('#pay').disabled);
  assert.equal(await page.locator('#back').isVisible(), false);
  assert.equal(await page.locator('#reconcile').isVisible(), false);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (process.env.PAYMENT_TEST_SCREENSHOT)
    await page.screenshot({ path: process.env.PAYMENT_TEST_SCREENSHOT, fullPage: true });
  await page.locator('#pay').click();
  await page.waitForFunction(() =>
    document.querySelector('#status').textContent.includes('완료됐어요'),
  );
  assert.equal(new URL(page.url()).search, '');
  assert.equal((await service.read(r.token)).status, 'PAID');
  assert.equal(await page.locator('#pay').isVisible(), false);
  await page.reload();
  await page.waitForFunction(() =>
    document.querySelector('#status').textContent.includes('완료됐어요'),
  );
  console.log(
    'Browser: checkout, SDK arguments, callback confirmation, reload and 375px layout passed',
  );

  const canceled = await service.createSample();
  await page.goto(
    `${origin}/payment-test/fail/${canceled.token}?code=PAY_PROCESS_CANCELED&message=untrusted`,
  );
  await page.waitForFunction(() =>
    document.querySelector('#status').textContent.includes('중단했어요'),
  );
  assert.equal(await page.locator('#pay').isVisible(), false);
  assert.equal(await page.locator('#back').isVisible(), true);
  assert.equal((await service.read(canceled.token)).status, 'PENDING');
  await page.locator('#back').click();
  await page.waitForFunction(() => !document.querySelector('#pay').disabled);
  console.log('Browser: cancellation preserves the fixture and offers return to checkout');

  const uncertain = await service.createSample();
  const query = new URLSearchParams({
    orderId: uncertain.orderId,
    amount: '1000',
    paymentKey: 'uncertain_' + uncertain.orderId,
  });
  await page.goto(`${origin}/payment-test/success/${uncertain.token}?${query}`);
  await page.waitForFunction(() => !document.querySelector('#reconcile').hidden);
  assert.equal((await service.read(uncertain.token)).status, 'REVIEW_REQUIRED');
  await page.locator('#reconcile').click();
  await page.waitForFunction(() =>
    document.querySelector('#status').textContent.includes('완료됐어요'),
  );
  assert.equal((await service.read(uncertain.token)).status, 'PAID');
  assert.deepEqual(errors, []);
  console.log(
    'Browser: uncertain approval recovers through the result inquiry button; no page errors',
  );
} finally {
  if (browser) await browser.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  assert.ok(resolve(directory).startsWith(resolve(temporaryRoot) + sep + 'dva-payment-browser-'));
  await rm(directory, { recursive: true });
}
