require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { orderDraft } = require('../dist/orders/order-draft');
const { assertOrderSubmissionReady } = require('../dist/orders/order-submission.validation');
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
  orderDraft({
    customerSeq: 31,
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
test('an unspecified payment method stays undecided until final submission', () => {
  const draft = complete();
  const undecided = orderDraft({ customerSeq: 31, parcels: [] });
  assert.equal(undecided.paymentMethodType, null);
  for (const method of ['billing', 'credit', 'groupBilling'])
    assert.equal(
      orderDraft({ customerSeq: 31, paymentMethodType: method }).paymentMethodType,
      method,
    );
  draft.paymentMethodType = null;
  assert.throws(
    () => assertOrderSubmissionReady(draft, now),
    (error) =>
      error.getStatus() === 422 &&
      error
        .getResponse()
        .details.some(
          (detail) => detail.field === 'paymentMethodType' && detail.reason === 'required',
        ),
  );
});
test('the same stored order can be checked for final submission without changing it', () => {
  const draft = complete(),
    before = structuredClone(draft);
  assert.doesNotThrow(() => assertOrderSubmissionReady(draft, now));
  assert.deepEqual(draft, before);
  const partial = orderDraft({ customerSeq: 31, parcels: [{}] });
  assert.throws(
    () => assertOrderSubmissionReady(partial, now),
    (error) => {
      assert.equal(error.getStatus(), 422);
      const fields = error.getResponse().details.map((x) => x.field);
      for (const field of [
        'pickupRequestedAt',
        'parcels.0.origin.name',
        'parcels.0.destination.phoneNumber',
        'parcels.0.items',
        'parcels.0.itemPrice',
      ])
        assert.ok(fields.includes(field));
      return true;
    },
  );
});
test('cancelled snapshots are skipped and remaining errors keep original detail indexes', () => {
  const value = complete();
  value.parcels.unshift({
    ...structuredClone(value.parcels[0]),
    status: 'CANCELLED',
    origin: { name: null },
  });
  assert.doesNotThrow(() => assertOrderSubmissionReady(value, now));
  value.parcels[1].origin.name = null;
  assert.throws(
    () => assertOrderSubmissionReady(value, now),
    (error) => {
      assert.deepEqual(error.getResponse().details, [
        { field: 'parcels.1.origin.name', reason: 'required' },
      ]);
      return true;
    },
  );
  value.parcels[1].status = 'CANCELLED';
  assert.throws(
    () => assertOrderSubmissionReady(value, now),
    (error) => {
      assert.deepEqual(error.getResponse().details, [{ field: 'parcels', reason: 'required' }]);
      return true;
    },
  );
});

test('final validation rejects expired pickup, invalid address, quantities and prices', () => {
  const value = complete();
  value.paymentMethodType = 'invalid';
  value.pickupRequestedAt = '2026-10-26T00:00:00Z';
  Object.assign(value.parcels[0].origin, {
    phoneNumber: '010-1234',
    postalCode: 'bad',
    latitude: 91,
    longitude: 181,
  });
  Object.assign(value.parcels[0], {
    smallBoxCount: -1,
    documentCount: 2147483648,
    itemPrice: Number.MAX_SAFE_INTEGER + 1,
    notifiedPrice: 0,
  });
  assert.throws(
    () => assertOrderSubmissionReady(value, now),
    (error) => {
      const reasons = error.getResponse().details.map((x) => x.reason);
      for (const reason of [
        'unsupported',
        'mustBeFuture',
        'digitsOnly',
        'postalCode',
        'latitudeRange',
        'longitudeRange',
        'quantityRange',
        'priceRange',
        'deliveryFeeRange',
      ])
        assert.ok(reasons.includes(reason), reason);
      return true;
    },
  );
});
test('creation normalizes equivalent dates and rejects ISO strings JavaScript cannot parse', () => {
  const a = orderDraft({
    customerSeq: 31,
    paymentMethodType: 'billing',
    pickupRequestedAt: '2026-10-28T10:00:00+09:00',
  });
  const b = orderDraft({
    parcels: [],
    pickupRequestedAt: '2026-10-28T01:00:00Z',
    paymentMethodType: 'billing',
    customerSeq: 31,
  });
  assert.deepEqual(a, b);
  for (const date of [
    '2026-W44-3T10:00:00Z',
    '2026-301T10:00:00Z',
    '2026-02-30T10:00:00Z',
    '2026-10-28T10:00:00',
  ])
    assert.throws(
      () => orderDraft({ customerSeq: 31, pickupRequestedAt: date }),
      (error) => error.getStatus() === 400,
    );
});

test('legacy cat orders remain readable but cannot be submitted', () => {
  const draft = complete();
  draft.paymentMethodType = 'cat';
  assert.throws(
    () => assertOrderSubmissionReady(draft, now),
    (error) =>
      error.getStatus() === 422 &&
      error
        .getResponse()
        .details.some((x) => x.field === 'paymentMethodType' && x.reason === 'unsupported'),
  );
});
