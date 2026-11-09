require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { paymentEnvironment } = require('../dist/payments/payment-config');
const {
  paymentMessage,
  paymentCompletionMessage,
  pickupNotice,
} = require('../dist/payments/payment-message');
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
      parcels: [
        {
          senderName: '@channel\n[click](https://evil.invalid)',
          recipientName: '수령인',
          originAddress: '서울 출발로 1 101호',
          destinationAddress: '서울 도착로 2 202호',
        },
      ],
    },
    'https://example.com/api/payments',
  );
  assert.ok(message.includes('12,800원'));
  assert.ok(message.includes('결제 완료 후 1시간 뒤'));
  assert.ok(message.includes('출발지 주소: 서울 출발로 1 101호'));
  assert.ok(message.includes('도착지 주소: 서울 도착로 2 202호'));
  assert.ok(!message.includes('배송 건수'));
  assert.ok(!message.includes('\n[click]'));
  assert.ok(!message.includes('@channel'));
  assert.ok(!message.includes('https://evil.invalid'));
  assert.ok(!message.includes('테스트 결제'));
  assert.ok(message.includes('[결제하기](https://example.com/api/payments/p/fixture)'));
});

test('completion notices use verified amounts and Korean times without claiming Dver acceptance', () => {
  const message = paymentCompletionMessage(
    {
      orderSeq: 1,
      token: 'fixture',
      senderName: '@channel\n[click](https://evil.invalid)',
      recipientSummary: '수령인',
      parcelCount: 1,
      amount: 3500,
      approvedAt: '2026-10-30T08:24:25Z',
      pickupRequestedAt: '2026-10-30T09:24:25Z',
      orderStatus: 'SUBMISSION_FAILED',
      parcels: [
        {
          senderName: '@channel\n[click](https://evil.invalid)',
          recipientName: '수령인',
          originAddress: '서울 출발로 1 101호',
          destinationAddress: '서울 도착로 2 202호',
        },
      ],
    },
    'https://example.com/api/payments',
  );
  assert.ok(message.includes('결제 완료 안내'));
  assert.ok(message.includes('3,500원'));
  assert.ok(message.includes('17:24'));
  assert.ok(message.includes('18:24'));
  for (const unwanted of [
    '@channel',
    'https://evil.invalid',
    '\n[click]',
    '[결제하기]',
    '접수가 완료',
    '실제 금액',
    '(한국 시간)',
    '배송 건수',
  ])
    assert.ok(!message.includes(unwanted));
  assert.ok(message.includes('[주문 확인](https://example.com/api/payments/p/fixture)'));
});

test('pickup notices show requested Korean time and explain late-payment adjustment only before payment', () => {
  const requested = { pickupRequestedAt: '2026-11-04T23:30:00+09:00', approvedAt: null };
  const pending = pickupNotice(requested);
  assert.ok(pending.includes('23:30'));
  assert.ok(pending.includes('해당 시각 이후 결제 시'));
  assert.ok(pending.includes('다음날 09:00'));
  assert.ok(pending.includes('09:00 이전은 당일 09:00'));
  const paid = pickupNotice({ ...requested, approvedAt: '2026-11-04T16:30:00+09:00' });
  assert.ok(paid.includes('23:30'));
  assert.ok(!paid.includes('결제 시'));
  const missing = pickupNotice({ pickupRequestedAt: null, approvedAt: null });
  assert.ok(missing.includes('결제 완료 후 1시간 뒤'));
  assert.ok(missing.includes('17:00 초과는 다음날 09:00'));
});

test('both notices list every parcel and escape injected address content', () => {
  const view = {
    orderSeq: 1,
    token: 'fixture',
    amount: 5500,
    approvedAt: null,
    pickupRequestedAt: null,
    parcels: [
      {
        senderName: '발송인 A',
        recipientName: '수령인 A',
        originAddress: '출발로 1',
        destinationAddress: '도착로 1\n@channel https://evil.invalid',
      },
      {
        senderName: '발송인 B',
        recipientName: '수령인 B',
        originAddress: '출발로 2',
        destinationAddress: '도착로 2 202호',
      },
    ],
  };
  for (const render of [paymentMessage, paymentCompletionMessage]) {
    const message = render(view, 'https://example.com/api/payments');
    assert.ok(message.includes('[배송 1]'));
    assert.ok(message.includes('[배송 2]'));
    assert.ok(message.includes('출발지 주소: 출발로 1'));
    assert.ok(message.includes('출발지 주소: 출발로 2'));
    assert.ok(message.includes('도착지 주소: 도착로 2 202호'));
    for (const unwanted of ['@channel', 'https://evil.invalid', '배송 건수', '(한국 시간)'])
      assert.ok(!message.includes(unwanted));
  }
});
