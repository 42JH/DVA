require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { paymentEnvironment } = require('../dist/payments/payment-config');
const { paymentMessage } = require('../dist/payments/payment-message');
test('order payments are opt-in and reject live/mismatched key types and untrusted upstream overrides', () => {
  const errors = [];
  assert.equal(paymentEnvironment({}, errors).ORDER_PAYMENTS_ENABLED, false);
  assert.deepEqual(errors, []);
  const valid = {
    NODE_ENV: 'test',
    ORDER_PAYMENTS_ENABLED: 'true',
    PAYMENT_PUBLIC_URL: 'http://127.0.0.1:5173/api/payments',
    CORS_ORIGINS: 'http://127.0.0.1:5173',
    TOSS_TEST_CLIENT_KEY: 'test_gck_fixture',
    TOSS_TEST_SECRET_KEY: 'test_gsk_fixture',
    PAYMENT_MATTERMOST_WEBHOOK_URL: 'http://127.0.0.1/hooks/test',
  };
  assert.equal(paymentEnvironment(valid, []).ORDER_PAYMENTS_ENABLED, true);
  for (const [field, value] of Object.entries({
    TOSS_TEST_CLIENT_KEY: 'live_gck_secret',
    TOSS_TEST_SECRET_KEY: 'test_sk_wrong',
    PAYMENT_PUBLIC_URL: 'https://unlisted.example/api/payments',
    PAYMENT_TOSS_BASE_URL: 'https://untrusted.example',
    PAYMENT_MATTERMOST_WEBHOOK_URL: 'http://external.invalid/hooks/test',
  })) {
    const e = [];
    paymentEnvironment({ ...valid, [field]: value }, e);
    assert.ok(e.includes(field));
  }
});
test('real order messages use actual amounts and a relative pickup without injected lines or links', () => {
  const message = paymentMessage(
    {
      orderSeq: 21,
      token: 'fixture',
      senderName: '@channel\n[click](https://evil.invalid)',
      recipientSummary: '수령인',
      parcelCount: 2,
      amount: 12800,
    },
    'https://example.com/api/payments',
  );
  assert.ok(message.includes('12,800원'));
  assert.ok(message.includes('결제 완료 후 1시간 뒤'));
  assert.ok(!message.includes('\n[click]'));
  assert.ok(!message.includes('@channel'));
  assert.ok(!message.includes('https://evil.invalid'));
  assert.ok(!message.includes('테스트 결제'));
  assert.ok(message.includes('[결제하기](https://example.com/api/payments/p/fixture)'));
});
