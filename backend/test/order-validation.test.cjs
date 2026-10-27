require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { orderDraft } = require('../dist/orders/order-draft');
const { assertOrderSubmissionReady } = require('../dist/orders/order-submission.validation');
const address = {
  name: '비공개 이름',
  phoneNumber: '01012345678',
  roadAddress: '도로명 1',
  jibunAddress: '지번 1',
  dongName: '동명',
  postalCode: '00001',
  latitude: 0,
  longitude: 0,
};
const complete = () =>
  orderDraft({
    customerSeq: 31,
    pickupRequestedAt: '2026-10-28T10:00:00+09:00',
    parcels: [{ origin: address, destination: address, smallBoxCount: 1, itemPrice: 0 }],
  });
const failure = (draft) => {
  let response;
  assert.throws(
    () => assertOrderSubmissionReady(draft),
    (error) => {
      assert.equal(error.getStatus(), 422);
      response = error.getResponse();
      assert.equal(response.code, 'VALIDATION_FAILED');
      assert.ok(response.details.length > 0);
      assert.ok(!JSON.stringify(response).includes(address.name));
      assert.ok(!JSON.stringify(response).includes(address.phoneNumber));
      return true;
    },
  );
  return response.details;
};

test('submission accepts complete parcels, zero coordinates/value and optional detailAddress without mutation', () => {
  const draft = complete(),
    before = structuredClone(draft);
  assert.doesNotThrow(() => assertOrderSubmissionReady(draft));
  assert.deepEqual(draft, before);
  for (const field of ['documentCount', 'smallBoxCount', 'mediumBoxCount', 'bigBoxCount']) {
    const input = complete();
    input.parcels[0].smallBoxCount = 0;
    input.parcels[0][field] = 1;
    assert.doesNotThrow(() => assertOrderSubmissionReady(input));
  }
  draft.parcels[0].smallBoxCount = 0;
  draft.parcels[0].otherItemDescription = '기타 물품';
  assert.doesNotThrow(() => assertOrderSubmissionReady(draft));
});

test('submission reports all missing paths while partial drafts remain unchanged', () => {
  const empty = orderDraft({ customerSeq: 31 });
  assert.deepEqual(failure(empty), [
    { field: 'pickupRequestedAt', reason: 'required' },
    { field: 'parcels', reason: 'atLeastOne' },
  ]);
  const draft = complete();
  draft.parcels.push(orderDraft({ customerSeq: 31, parcels: [{}] }).parcels[0]);
  const before = structuredClone(draft);
  const errors = failure(draft);
  assert.equal(errors.length, 18);
  assert.ok(errors.every(({ field }) => field.startsWith('parcels.1')));
  assert.ok(errors.some(({ field }) => field === 'parcels.1.origin.phoneNumber'));
  assert.ok(errors.some(({ field }) => field === 'parcels.1.destination.latitude'));
  assert.ok(errors.some(({ field }) => field === 'parcels.1.itemPrice'));
  assert.ok(!errors.some(({ field }) => field.endsWith('detailAddress')));
  assert.deepEqual(draft, before);
});

test('submission rejects blank required address fields and an empty item selection', () => {
  const draft = complete();
  draft.parcels[0].origin.name = ' \t\n';
  draft.parcels[0].destination.postalCode = '';
  draft.parcels[0].smallBoxCount = 0;
  draft.parcels[0].otherItemDescription = '  ';
  assert.deepEqual(failure(draft), [
    { field: 'parcels.0.origin.name', reason: 'required' },
    { field: 'parcels.0.destination.postalCode', reason: 'required' },
    { field: 'parcels.0', reason: 'itemRequired' },
  ]);
});

test('draft comparison ignores object key order, equivalent timestamps and explicit defaults but preserves content', () => {
  const first = {
    customerSeq: 31,
    pickupRequestedAt: '2026-10-28T10:00:00+09:00',
    parcels: [{ origin: address }],
  };
  const second = {
    parcels: [
      {
        origin: Object.fromEntries(Object.entries(address).reverse()),
        originPin: null,
        documentCount: 0,
        smallBoxCount: 0,
        mediumBoxCount: 0,
        bigBoxCount: 0,
        itemPrice: null,
        otherItemDescription: '',
        clientComment: '',
      },
    ],
    paymentMethodType: 'credit',
    pickupRequestedAt: '2026-10-28T01:00:00.000Z',
    customerSeq: 31,
  };
  assert.equal(JSON.stringify(orderDraft(first)), JSON.stringify(orderDraft(second)));
  second.parcels[0].origin.name += ' ';
  assert.notEqual(JSON.stringify(orderDraft(first)), JSON.stringify(orderDraft(second)));
});

test('customer identity is canonicalized without changing legacy customer-ID request fingerprints', () => {
  const { createHash } = require('node:crypto');
  const legacy = {
    customerSeq: 31,
    paymentMethodType: 'credit',
    pickupRequestedAt: null,
    parcels: [],
  };
  const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  assert.equal(hash(orderDraft({ customerSeq: 31 })), hash(legacy));
  const first = { customer: { name: '고객', phoneNumber: '01000550001' } };
  const reordered = {
    customer: { phoneNumber: '01000550001', name: '고객' },
    parcels: [],
    paymentMethodType: 'credit',
  };
  assert.equal(hash(orderDraft(first)), hash(orderDraft(reordered)));
  reordered.customer.phoneNumber = '01000550002';
  assert.notEqual(hash(orderDraft(first)), hash(orderDraft(reordered)));
});
