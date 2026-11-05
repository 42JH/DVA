require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const { PaymentsService } = require('../dist/payments/payments.service');

test('only confirmed rejection can clear a payment key, never an absent lookup result', async (t) => {
  const cases = [
    [false, 404, 'NOT_FOUND_PAYMENT', 422],
    [false, 404, 'NOT_FOUND_PAYMENT_SESSION', 422],
    [false, 403, 'REJECT_CARD_PAYMENT', 422],
    [true, 404, 'NOT_FOUND_PAYMENT', 502],
    [true, 404, 'NOT_FOUND_PAYMENT_SESSION', 502],
    [false, 500, 'NOT_FOUND_PAYMENT_SESSION', 502],
    [false, 200, 'NOT_FOUND_PAYMENT', 502],
    [false, 404, 'NOT_FOUND', 502],
    [false, 401, 'UNAUTHORIZED_KEY', 502],
    [false, 400, 'PROVIDER_ERROR', 502],
    [false, 403, 'FORBIDDEN_REQUEST', 502],
    [false, 404, 'NOT_FOUND_PAYMENT_SESSION', 502, false],
    [false, 404, ['NOT_FOUND_PAYMENT'], 502],
    [false, 404, { toString: 'NOT_FOUND_PAYMENT' }, 502],
  ];
  for (const [lookupOnly, status, code, expected, canRelease = true] of cases) {
    await t.test(
      `${lookupOnly ? 'lookup' : 'confirm'} ${status} ${JSON.stringify(code)} release=${canRelease}`,
      async () => {
        const released = [];
        const service = new PaymentsService(
          { get: () => true },
          {},
          { toss: async () => ({ status, data: { code } }) },
          {
            claimApproval: async () => ({ key: 'key', claimId: 'claim', lookupOnly }),
            releaseClaim: async (_id, _claim, declined = false) => {
              released.push(declined);
              return canRelease;
            },
          },
        );
        await assert.rejects(service.confirm('order', 'order', 3500, 'key', 'request'), (e) => {
          assert.equal(e.getStatus(), expected);
          assert.equal(
            e.getResponse().code,
            expected === 422 ? 'PAYMENT_FAILED' : 'PAYMENT_RESULT_UNKNOWN',
          );
          return true;
        });
        assert.deepEqual(released, expected === 422 || !canRelease ? [true, false] : [false]);
      },
    );
  }
  for (const code of ['NOT_FOUND_PAYMENT', 'NOT_FOUND_PAYMENT_SESSION', 'REJECT_CARD_PAYMENT']) {
    await t.test(`already processed then lookup ${code} retains the original attempt`, async () => {
      const modes = [],
        released = [];
      const service = new PaymentsService(
        { get: () => true },
        {},
        {
          toss: async (_id, _amount, _key, lookup) => {
            modes.push(lookup);
            return lookup
              ? { status: code === 'REJECT_CARD_PAYMENT' ? 403 : 404, data: { code } }
              : { status: 400, data: { code: 'ALREADY_PROCESSED_PAYMENT' } };
          },
        },
        {
          claimApproval: async () => ({ key: 'key', claimId: 'claim', lookupOnly: false }),
          releaseClaim: async (_id, _claim, declined = false) => {
            released.push(declined);
            return true;
          },
        },
      );
      await assert.rejects(
        service.confirm('order', 'order', 3500, 'key', 'request'),
        (e) => e.getStatus() === 502,
      );
      assert.deepEqual(modes, [false, true]);
      assert.deepEqual(released, [false]);
    });
  }
});

test('an array instead of a terminal provider status cannot release an uncertain payment', async () => {
  const released = [];
  const service = new PaymentsService(
    { get: () => true },
    {},
    {
      toss: async () => ({
        status: 200,
        data: {
          status: ['ABORTED'],
          orderId: 'order',
          paymentKey: 'key',
          totalAmount: 3500,
          currency: 'KRW',
        },
      }),
    },
    {
      claimApproval: async () => ({ key: 'key', claimId: 'claim', lookupOnly: true }),
      releaseClaim: async (_id, _claim, declined = false) => {
        released.push(declined);
        return true;
      },
    },
  );
  await assert.rejects(
    service.confirm('order', 'order', 3500, 'key', 'request'),
    (e) => e.getStatus() === 502,
  );
  assert.deepEqual(released, [false]);
});

const checkout = readFileSync(join(__dirname, '../dist/payments/assets/checkout.js'), 'utf8');
async function page(mode, responses) {
  const nodes = Object.fromEntries(
    ['payment-data', 'status', 'pay', 'reconcile', 'back', 'pickup-time'].map((id) => [
      id,
      {
        hidden: ['reconcile', 'back'].includes(id),
        disabled: id === 'pay',
        textContent: '',
        handlers: {},
        addEventListener(event, handler) {
          this.handlers[event] = handler;
        },
      },
    ]),
  );
  const data = {
    mode,
    apiUrl: 'https://example.test/api/payments/requests/token',
    publicUrl: 'https://example.test/api/payments',
    clientKey: 'test_gck_fixture',
    token: 'token',
  };
  nodes['payment-data'].textContent = JSON.stringify(data);
  const calls = [],
    widgets = [],
    history = [];
  await runInNewContext(checkout, {
    document: { getElementById: (id) => nodes[id] },
    location: { search: '?paymentKey=sensitive', pathname: '/api/payments/p/token' },
    history: { replaceState: (...args) => history.push(args) },
    URLSearchParams,
    AbortSignal,
    fetch: async (url, options) => {
      calls.push({ url, options });
      assert.ok(responses.length, 'unexpected request');
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return { ok: next.ok !== false, json: async () => next };
    },
    TossPayments: () => ({
      widgets: () => ({
        setAmount: async (value) => widgets.push(['amount', value]),
        renderPaymentMethods: async () => {},
        renderAgreement: async () => {},
        requestPayment: async (value) => widgets.push(['payment', value]),
      }),
    }),
  });
  return { nodes, calls, widgets, history, data };
}
const review = { data: { status: 'REVIEW_REQUIRED' } };
const pending = { data: { status: 'PENDING', amount: 3500, orderId: 'token', orderName: '택배' } };
for (const mode of ['checkout', 'success']) {
  test(`${mode} can return to the same checkout after reconcile rejects a payment`, async () => {
    const p = await page(mode, [review, { ok: false, error: { code: 'PAYMENT_FAILED' } }, pending]);
    await p.nodes.reconcile.handlers.click();
    assert.equal(p.nodes.back.hidden, false);
    assert.equal(p.nodes.pay.hidden, true);
    assert.equal(p.nodes.reconcile.hidden, true);
    assert.match(p.nodes.status.textContent, /다시 진행/);
    assert.equal(p.widgets.length, 0);
    assert.deepEqual(
      p.calls.map((c) => c.url),
      [p.data.apiUrl, p.data.apiUrl + '/reconcile', p.data.apiUrl],
    );
    assert.equal(p.calls[1].options.body, '{}');
    assert.equal(p.history[0][2], '/api/payments/p/token');
  });
}
test('unknown or unavailable reconciliation never offers a new charge', async () => {
  for (const result of [review, new Error('unavailable')]) {
    const p = await page('checkout', [
      review,
      { ok: false, error: { code: 'PAYMENT_RESULT_UNKNOWN' } },
      result,
    ]);
    await p.nodes.reconcile.handlers.click();
    assert.equal(p.nodes.back.hidden, true);
    assert.equal(p.nodes.pay.hidden, true);
    assert.equal(p.nodes.reconcile.disabled, false);
    assert.equal(p.nodes.reconcile.hidden, false);
    assert.equal(p.widgets.length, 0);
  }
});
test('a recovered approval waits for Dver without offering a second payment', async () => {
  const p = await page('checkout', [
    review,
    { data: { status: 'PAID', orderStatus: 'SUBMISSION_FAILED' } },
  ]);
  await p.nodes.reconcile.handlers.click();
  assert.equal(p.nodes.pay.hidden, true);
  assert.equal(p.nodes.reconcile.hidden, true);
  assert.match(p.nodes.status.textContent, /택배 접수 결과를 확인/);
  assert.equal(p.widgets.length, 0);
});
test('the normal checkout still initializes the widgets and uses the existing callback URLs', async () => {
  const p = await page('checkout', [pending, pending]);
  assert.equal(p.nodes.pay.disabled, false);
  await p.nodes.pay.handlers.click();
  assert.equal(p.widgets[1][0], 'payment');
  assert.equal(p.widgets[1][1].orderId, 'token');
  assert.equal(p.widgets[1][1].successUrl, p.data.publicUrl + '/success/token');
  assert.equal(p.widgets[1][1].failUrl, p.data.publicUrl + '/fail/token');
});
