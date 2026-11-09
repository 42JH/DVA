import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { configuration } from '../config.mjs';
import { PaymentStore } from '../store.mjs';
import { TossTestClient, MattermostSender } from '../clients.mjs';
import { PaymentTestService } from '../service.mjs';
import { paymentServer } from '../server.mjs';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
async function fixture(t, { timeout = 1000 } = {}) {
  const temporaryRoot = process.env.PAYMENT_TEST_TMP_ROOT || tmpdir();
  const directory = await mkdtemp(join(temporaryRoot, 'dva-payment-test-'));
  const calls = [];
  let behavior = 'ok',
    failPaidWrite = false;
  const payments = new Map();
  const upstream = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    calls.push({ method: req.method, url: req.url, headers: req.headers, body });
    if (req.url === '/hooks/test') {
      if (behavior === 'message-timeout') return;
      res.writeHead(behavior === 'message-rejected' ? 403 : 200);
      return res.end(behavior === 'message-rejected' ? 'denied' : 'ok');
    }
    assert.equal(
      req.headers.authorization,
      'Basic ' + Buffer.from('test_gsk_fixture:').toString('base64'),
    );
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST') {
      assert.match(req.headers['idempotency-key'], /^[a-f0-9-]{36}$/);
      assert.deepEqual(Object.keys(body).sort(), ['amount', 'orderId', 'paymentKey']);
      const payment = {
        paymentKey: body.paymentKey,
        orderId: body.orderId,
        totalAmount: body.amount,
        currency: 'KRW',
        status: 'DONE',
        approvedAt: '2026-10-30T01:00:00+09:00',
      };
      payments.set(body.paymentKey, payment);
      if (behavior === 'timeout') return;
      if (behavior === 'reject') {
        res.statusCode = 403;
        return res.end('{"code":"REJECT_CARD_PAYMENT"}');
      }
      if (behavior === 'processing') {
        res.statusCode = 400;
        return res.end('{"code":"ALREADY_PROCESSING_PAYMENT"}');
      }
      if (behavior === 'already') {
        res.statusCode = 400;
        return res.end('{"code":"ALREADY_PROCESSED_PAYMENT"}');
      }
      if (behavior === 'html') {
        res.statusCode = 500;
        return res.end('<html>upstream failed</html>');
      }
      if (behavior === 'huge') return res.end('x'.repeat(70000));
      if (behavior === 'wrong-amount') payment.totalAmount++;
      if (behavior === 'wrong-order') payment.orderId = 'other';
      if (behavior === 'wrong-key') payment.paymentKey = 'other';
      if (behavior === 'wrong-currency') payment.currency = 'USD';
      if (behavior === 'not-done') payment.status = 'IN_PROGRESS';
      if (behavior === 'bad-date') payment.approvedAt = 'yesterday';
      return res.end(JSON.stringify(payment));
    }
    const payment = payments.get(decodeURIComponent(req.url.split('/').at(-1)));
    res.statusCode = payment ? 200 : 404;
    res.end(JSON.stringify(payment || { code: 'NOT_FOUND_PAYMENT' }));
  });
  const external = await listen(upstream);
  const env = {
    NODE_ENV: 'test',
    PAYMENT_TEST_ENABLED: 'true',
    PAYMENT_TEST_PUBLIC_URL: 'http://127.0.0.1/payment-test',
    TOSS_TEST_CLIENT_KEY: 'test_gck_fixture',
    TOSS_TEST_SECRET_KEY: 'test_gsk_fixture',
    PAYMENT_TEST_OPERATOR_TOKEN: 'a'.repeat(32),
    MATTERMOST_WEBHOOK_URL: external + '/hooks/test',
    PAYMENT_TEST_TOSS_BASE_URL: external,
    PAYMENT_TEST_DATA_DIR: directory,
    PORT: '0',
  };
  const config = configuration(env);
  const store = new PaymentStore(directory, {
    beforeWrite: async (records) => {
      if (failPaidWrite && Object.values(records).some((r) => r.status === 'PAID')) {
        failPaidWrite = false;
        throw new Error('Simulated disk failure');
      }
    },
  });
  await store.initialize();
  const service = new PaymentTestService(
    config,
    store,
    new TossTestClient(config, { timeout }),
    new MattermostSender(config, { timeout }),
  );
  const server = await paymentServer(config, service);
  const address = await listen(server);
  t.after(async () => {
    for (const s of [server, upstream]) {
      s.closeAllConnections();
      await new Promise((r) => s.close(r));
    }
    const target = resolve(directory);
    assert.equal(
      target.startsWith(resolve(temporaryRoot) + '\\dva-payment-test-') ||
        target.startsWith(resolve(temporaryRoot) + '/dva-payment-test-'),
      true,
    );
    await rm(target, { recursive: true });
  });
  const send = async (path, { operator = false, origin = true, ...options } = {}) => {
    const response = await fetch(address + path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(origin ? { Origin: new URL(config.publicUrl).origin } : {}),
        ...(operator ? { Authorization: 'Bearer ' + config.operatorToken } : {}),
        ...options.headers,
      },
    });
    return { response, data: await response.json() };
  };
  const sample = () => service.createSample();
  const input = (r) => ({
    amount: r.amount,
    orderId: r.orderId,
    paymentKey: 'fixture_' + r.orderId,
  });
  return {
    env,
    config,
    directory,
    calls,
    store,
    service,
    server,
    address,
    send,
    sample,
    input,
    behavior: (value) => {
      behavior = value;
    },
    failPaid: () => {
      failPaidWrite = true;
    },
  };
}

test('configuration is opt-in, rejects live keys, credentials in URLs and nonlocal mock providers', async (t) => {
  const f = await fixture(t);
  for (const [key, value] of Object.entries({
    PAYMENT_TEST_ENABLED: 'false',
    TOSS_TEST_CLIENT_KEY: 'live_gck_x',
    TOSS_TEST_SECRET_KEY: 'live_gsk_x',
    PAYMENT_TEST_PUBLIC_URL: 'https://user:pass@example.com/payment-test',
    PAYMENT_TEST_TOSS_BASE_URL: 'https://untrusted.example',
    PAYMENT_TEST_OPERATOR_TOKEN: 'short',
  })) {
    assert.throws(() => configuration({ ...f.env, [key]: value }), new RegExp(key));
  }
});
test('operator routes require authentication and public callbacks never claim success on GET', async (t) => {
  const f = await fixture(t);
  const route = '/internal/payment-test/requests';
  assert.equal((await f.send(route, { method: 'POST', body: '{}' })).response.status, 401);
  const created = await f.send(route, { method: 'POST', body: '{}', operator: true });
  assert.equal(created.response.status, 201);
  const r = created.data;
  assert.equal(
    (
      await f.send(`/payment-test/api/requests/${r.token}/confirm`, {
        method: 'POST',
        origin: false,
        body: '{}',
      })
    ).response.status,
    403,
  );
  for (const page of ['p', 'success', 'fail']) {
    const response = await fetch(
      `${f.address}/payment-test/${page}/${r.token}?paymentKey=do-not-reflect&message=untrusted`,
    );
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.match(html, /실제 금액은 청구되지 않습니다/);
    for (const forbidden of [
      'test_gsk_fixture',
      f.config.operatorToken,
      'do-not-reflect',
      'untrusted',
      '/hooks/test',
    ])
      assert.equal(html.includes(forbidden), false);
  }
  assert.equal((await f.service.read(r.token)).status, 'PENDING');
  assert.equal(f.calls.length, 0);
});
test('message uses the approved template and sending the same fixture twice is blocked', async (t) => {
  const f = await fixture(t),
    r = await f.sample();
  assert.deepEqual(await f.service.notify(r.token), { notificationStatus: 'SENT' });
  await assert.rejects(f.service.notify(r.token), { code: 'MESSAGE_ALREADY_ATTEMPTED' });
  assert.equal(f.calls.length, 1);
  const text = f.calls[0].body.text;
  assert.match(text, /안녕하세요! DVA입니다/);
  assert.match(text, /결제금액: 1,000원/);
  assert.ok(text.includes(`[결제하기](${r.paymentUrl})`));
  assert.equal(text.includes('실제 금액'), false);
  assert.equal(/\p{Extended_Pictographic}/u.test(text), false);
});
test('concurrent approval and reload send one POST and store only minimal payment results', async (t) => {
  const f = await fixture(t),
    r = await f.sample(),
    input = f.input(r);
  const path = `/payment-test/api/requests/${r.token}/confirm`;
  const results = await Promise.all(
    Array.from({ length: 6 }, () => f.send(path, { method: 'POST', body: JSON.stringify(input) })),
  );
  assert.ok(results.every((x) => x.response.status === 200 && x.data.status === 'PAID'));
  assert.equal((await f.service.confirm(r.token, input)).status, 'PAID');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, '/v1/payments/confirm');
  const disk = JSON.parse(await readFile(f.store.file, 'utf8'))[r.token];
  assert.equal(disk.status, 'PAID');
  assert.equal(disk.approvedAt, '2026-10-29T16:00:00.000Z');
  assert.equal('card' in disk, false);
});
test('mismatched amount/order and malformed inputs never reach Toss', async (t) => {
  const f = await fixture(t),
    r = await f.sample(),
    input = f.input(r);
  for (const bad of [
    { ...input, amount: 1 },
    { ...input, orderId: 'other' },
    { ...input, amount: '1000' },
    { ...input, paymentKey: '\n' },
    { ...input, extra: true },
  ])
    await assert.rejects(f.service.confirm(r.token, bad));
  assert.equal(f.calls.length, 0);
});
for (const mode of [
  'wrong-amount',
  'wrong-order',
  'wrong-key',
  'wrong-currency',
  'not-done',
  'bad-date',
  'html',
  'huge',
  'processing',
]) {
  test(`invalid or ambiguous provider result (${mode}) is never marked paid`, async (t) => {
    const f = await fixture(t),
      r = await f.sample();
    f.behavior(mode);
    await assert.rejects(f.service.confirm(r.token, f.input(r)), {
      code: 'PAYMENT_RESULT_UNKNOWN',
    });
    assert.equal((await f.service.read(r.token)).status, 'REVIEW_REQUIRED');
    assert.equal(f.calls.length, 1);
  });
}
test('timeout after upstream approval is recovered by GET, including after restart', async (t) => {
  const f = await fixture(t, { timeout: 80 }),
    r = await f.sample();
  f.behavior('timeout');
  await assert.rejects(f.service.confirm(r.token, f.input(r)), { code: 'PAYMENT_RESULT_UNKNOWN' });
  const recovered = new PaymentStore(f.directory);
  await recovered.initialize();
  const service = new PaymentTestService(
    f.config,
    recovered,
    new TossTestClient(f.config),
    new MattermostSender(f.config),
  );
  assert.equal((await service.reconcile(r.token)).status, 'PAID');
  assert.deepEqual(
    f.calls.map((x) => x.method),
    ['POST', 'GET'],
  );
});
test('disk failure after approval leaves a durable in-flight marker and retry only queries', async (t) => {
  const f = await fixture(t),
    r = await f.sample();
  f.failPaid();
  await assert.rejects(f.service.confirm(r.token, f.input(r)), /disk failure/);
  assert.equal((await f.store.find(r.token)).status, 'CONFIRMING');
  const recovered = new PaymentStore(f.directory);
  await recovered.initialize();
  assert.equal((await recovered.find(r.token)).status, 'REVIEW_REQUIRED');
  assert.equal((await f.service.reconcile(r.token)).status, 'PAID');
  assert.deepEqual(
    f.calls.map((x) => x.method),
    ['POST', 'GET'],
  );
});
test('already processed response is resolved by inquiry; a different key cannot replace the original', async (t) => {
  const f = await fixture(t),
    r = await f.sample();
  f.behavior('already');
  assert.equal((await f.service.confirm(r.token, f.input(r))).status, 'PAID');
  await assert.rejects(f.service.confirm(r.token, { ...f.input(r), paymentKey: 'other' }), {
    code: 'PAYMENT_KEY_MISMATCH',
  });
  assert.deepEqual(
    f.calls.map((x) => x.method),
    ['POST', 'GET'],
  );
});
test('definite rejection is terminal and expired links cannot approve', async (t) => {
  const f = await fixture(t),
    r = await f.sample();
  f.behavior('reject');
  await assert.rejects(f.service.confirm(r.token, f.input(r)), { code: 'PAYMENT_FAILED' });
  await assert.rejects(f.service.confirm(r.token, f.input(r)), { code: 'PAYMENT_FAILED' });
  const expired = await f.sample();
  await f.store.change((records) => {
    records[expired.token].expiresAt = '2000-01-01T00:00:00Z';
  });
  await assert.rejects(f.service.confirm(expired.token, f.input(expired)), {
    code: 'PAYMENT_EXPIRED',
  });
  assert.equal(f.calls.length, 1);
});
for (const mode of ['message-timeout', 'message-rejected']) {
  test(`unacknowledged notification (${mode}) is not automatically resent`, async (t) => {
    const f = await fixture(t, { timeout: 80 }),
      r = await f.sample();
    f.behavior(mode);
    const result = await f.service.notify(r.token);
    assert.equal(result.notificationStatus, mode === 'message-timeout' ? 'UNKNOWN' : 'FAILED');
    await assert.rejects(f.service.notify(r.token), { code: 'MESSAGE_ALREADY_ATTEMPTED' });
    assert.equal(f.calls.length, 1);
  });
}
test('restart marks unacknowledged messages unknown and corrupt stores fail closed', async (t) => {
  const f = await fixture(t),
    r = await f.sample();
  await f.store.change((records) => {
    records[r.token].notificationStatus = 'SENDING';
  });
  const store = new PaymentStore(f.directory);
  await store.initialize();
  assert.equal((await store.find(r.token)).notificationStatus, 'UNKNOWN');
  await writeFile(f.store.file, '{broken');
  await assert.rejects(new PaymentStore(f.directory).initialize(), /unreadable/);
});
