require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { orderSnapshot } = require('../dist/orders/order-snapshot');
const {
  assertOrderSubmissionReady,
  inspectOrder,
} = require('../dist/orders/order-submission.validation');
const now = Date.parse('2026-10-27T00:00:00Z');
const address = {
  name: '검증 고객',
  phoneNumber: '01012345678',
  roadAddress: '검증로 1',
  jibunAddress: '검증동 1',
  dongName: '검증동',
  postalCode: '00001',
  latitude: 0,
  longitude: 0,
};
const complete = () =>
  orderSnapshot({
    paymentMethodType: 'credit',
    pickupRequestedAt: '2026-10-28T10:00:00+09:00',
    parcels: [
      {
        origin: address,
        destination: address,
        smallBoxCount: 1,
        itemPrice: 0,
        notifiedPrice: 3500,
      },
    ],
  });

test('full order validation requires no customer ID, accepts zeros and does not mutate input', () => {
  const input = complete(),
    before = structuredClone(input);
  assert.doesNotThrow(() => assertOrderSubmissionReady(input, now));
  assert.deepEqual(input, before);
  assert.ok(inspectOrder(input, now).collectedFields.includes('parcels.0.origin.latitude'));
  assert.ok(!inspectOrder(input, now).collectedFields.includes('parcels.0.documentCount'));
});

test('missing payment, pickup, parcels and nested fields are all reported without inventing defaults', () => {
  const empty = orderSnapshot({});
  assert.equal(empty.paymentMethodType, null);
  assert.deepEqual(inspectOrder(empty, now).missingFields, [
    'paymentMethodType',
    'pickupRequestedAt',
    'parcels',
  ]);
  const partial = orderSnapshot({ parcels: [{ origin: { name: '비공개 원문' } }] });
  assert.throws(
    () => assertOrderSubmissionReady(partial, now),
    (error) => {
      assert.equal(error.getStatus(), 422);
      const details = error.getResponse().details;
      assert.ok(details.some((x) => x.field === 'parcels.0.destination.phoneNumber'));
      assert.ok(details.some((x) => x.field === 'parcels.0.items'));
      assert.ok(!JSON.stringify(error.getResponse()).includes('비공개 원문'));
      return true;
    },
  );
});

test('final validation catches date, phone, postal code, coordinate, quantity, value and fixed fare errors', () => {
  const invalid = complete();
  invalid.paymentMethodType = 'unsupported';
  invalid.pickupRequestedAt = '2026-10-26T00:00:00Z';
  Object.assign(invalid.parcels[0].origin, {
    phoneNumber: '010-1234',
    postalCode: 'bad',
    latitude: 91,
    longitude: 181,
  });
  Object.assign(invalid.parcels[0], {
    smallBoxCount: -1,
    documentCount: 2147483648,
    itemPrice: Number.MAX_SAFE_INTEGER + 1,
    notifiedPrice: 1,
  });
  const { errors } = inspectOrder(invalid, now);
  for (const reason of [
    'unsupported',
    'mustBeFuture',
    'digitsOnly',
    'postalCode',
    'latitudeRange',
    'longitudeRange',
    'quantityRange',
    'priceRange',
    'fixedPrice3500',
  ])
    assert.ok(
      errors.some((x) => x.reason === reason),
      reason,
    );
  for (const value of ['2026-02-30T10:00:00Z', '2026-10-28T10:00:00', 'invalid']) {
    const input = complete();
    input.pickupRequestedAt = value;
    assert.ok(inspectOrder(input, now).errors.some((x) => x.reason === 'zonedDateTime'));
  }
});

test('canonical snapshot preserves key order and unknowns, normalizes equivalent instants', () => {
  const first = orderSnapshot({
    paymentMethodType: 'credit',
    pickupRequestedAt: '2026-10-28T10:00:00+09:00',
    parcels: [{ origin: { name: '고객', phoneNumber: '01012345678' } }],
  });
  const second = orderSnapshot({
    parcels: [{ origin: { phoneNumber: '01012345678', name: '고객' } }],
    pickupRequestedAt: '2026-10-28T01:00:00Z',
    paymentMethodType: 'credit',
  });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.parcels[0].smallBoxCount, null);
  assert.equal(first.parcels[0].notifiedPrice, null);
});
