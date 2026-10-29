require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CreateOrderDto } = require('../dist/orders/dto/create-order.dto');
const { OrderQueryDto, OrderIdParamsDto } = require('../dist/orders/dto/order-query.dto');
const { createValidationPipe } = require('../dist/common/http/validation.pipe');
const { UpdateOrderDto } = require('../dist/orders/dto/update-order.dto');
const { CancelOrderParcelsDto } = require('../dist/orders/dto/cancel-order-parcels.dto');
const { assertOrderUpdate } = require('../dist/orders/order-update.validation');

const pipe = createValidationPipe();
const validate = (body) => pipe.transform(body, { type: 'body', metatype: CreateOrderDto });

test('parcel cancellation requires a nonempty unique array of database integers', async () => {
  const validateCancellation = (body) =>
    pipe.transform(body, { type: 'body', metatype: CancelOrderParcelsDto });
  for (const orderParcelSeqs of [[1], [3, 1, 2147483647]])
    assert.deepEqual(
      (await validateCancellation({ orderParcelSeqs })).orderParcelSeqs,
      orderParcelSeqs,
    );
  for (const body of [
    {},
    null,
    [],
    { orderParcelSeq: 1 },
    { orderParcelSeqs: [1], status: 'CANCELLED' },
    ...[
      null,
      [],
      1,
      '1',
      {},
      [1, 1],
      [0],
      [-1],
      [1.5],
      ['1'],
      [true],
      [null],
      [[1]],
      [2147483648],
    ].map((orderParcelSeqs) => ({ orderParcelSeqs })),
  ])
    await assert.rejects(
      () => validateCancellation(body),
      (error) => error.getStatus() === 400,
    );
});

const validateUpdate = async (body) => {
  const input = await pipe.transform(body, { type: 'body', metatype: UpdateOrderDto });
  assertOrderUpdate(input);
  return input;
};

test('clients cannot inject parcel cancellation state through creation or editing', async () => {
  await assert.rejects(
    () => validate({ customerSeq: 1, parcels: [{ status: 'CANCELLED' }] }),
    (error) => error.getStatus() === 400,
  );
  await assert.rejects(
    () =>
      validateUpdate({ expectedVersion: 1, parcels: [{ orderParcelSeq: 1, status: 'CANCELLED' }] }),
    (error) => error.getStatus() === 400,
  );
});

test('order updates preserve omitted fields, nullable clears, zero and empty text', async () => {
  const input = await validateUpdate({
    expectedVersion: 4,
    pickupRequestedAt: null,
    parcels: [
      { orderParcelSeq: 101, origin: { name: null, latitude: 0 }, clientComment: '' },
      { originPin: null, documentCount: 0, itemPrice: null },
    ],
  });
  assert.equal(input.paymentMethodType, undefined);
  assert.equal(input.pickupRequestedAt, null);
  assert.equal(input.parcels[0].smallBoxCount, undefined);
  assert.equal(input.parcels[0].origin.name, null);
  assert.equal(input.parcels[0].origin.phoneNumber, undefined);
  assert.equal(input.parcels[0].origin.latitude, 0);
  assert.equal(input.parcels[0].clientComment, '');
  assert.equal(input.parcels[1].orderParcelSeq, undefined);
  assert.equal(input.parcels[1].documentCount, 0);
  assert.equal(input.parcels[1].itemPrice, null);
  await validateUpdate({ expectedVersion: 1, paymentMethodType: 'billing', parcels: [] });
});

test('order updates reject missing changes, duplicate details, invalid fields and value types', async () => {
  for (const input of [
    {},
    { paymentMethodType: 'billing' },
    { expectedVersion: '1', paymentMethodType: 'billing' },
    { expectedVersion: null, paymentMethodType: 'billing' },
    { expectedVersion: 0, paymentMethodType: 'billing' },
    { expectedVersion: 2147483648, paymentMethodType: 'billing' },
    { expectedVersion: 1 },
    { expectedVersion: 1, parcels: [] },
    { expectedVersion: 1, parcels: [{}] },
    { expectedVersion: 1, parcels: [{ origin: {} }] },
    { expectedVersion: 1, parcels: [{ orderParcelSeq: 1, destination: {} }] },
    { expectedVersion: 1, parcels: [{ orderParcelSeq: 1 }] },
    { expectedVersion: 1, paymentMethodType: 'billing', parcels: [{}] },
    { expectedVersion: 1, paymentMethodType: null },
    { expectedVersion: 1, paymentMethodType: 'cash' },
    { expectedVersion: 1, paymentMethodType: 'cat' },
    { expectedVersion: 1, pickupRequestedAt: '2026-02-30T10:00:00Z' },
    { expectedVersion: 1, pickupRequestedAt: '2026-10-28T10:00:00' },
    { expectedVersion: 1, pickupRequestedAt: '2026-10-28T10:00:00+25:00' },
    { expectedVersion: 1, customerSeq: 1 },
    { expectedVersion: 1, status: 'ACCEPTED' },
    { expectedVersion: 1, parcels: null },
    { expectedVersion: 1, parcels: [null] },
    { expectedVersion: 1, parcels: [[{}]] },
    ...[null, 0, '1', 1.5, 2147483648].map((orderParcelSeq) => ({
      expectedVersion: 1,
      parcels: [{ orderParcelSeq, smallBoxCount: 1 }],
    })),
    ...[
      { origin: null },
      { destination: [] },
      { origin: { extra: 1 } },
      { origin: { phoneNumber: '010-1234' } },
      { origin: { latitude: 91 } },
      { originPin: {} },
      { originPin: { scope: 'PERSONAL', pinSeq: null } },
      { itemPrice: Number.MAX_SAFE_INTEGER + 1 },
      { clientComment: null },
      { smallBoxCount: null },
      { smallBoxCount: -1 },
      { notifiedPrice: 3500 },
      { parcelPosition: 1 },
    ].map((parcel) => ({ expectedVersion: 1, parcels: [parcel] })),
    {
      expectedVersion: 1,
      parcels: [
        { orderParcelSeq: 1, smallBoxCount: 1 },
        { orderParcelSeq: 1, smallBoxCount: 2 },
      ],
    },
  ])
    await assert.rejects(
      () => validateUpdate(input),
      (error) => {
        assert.equal(error.getStatus(), 400);
        assert.equal(error.getResponse().code, 'INVALID_REQUEST');
        return true;
      },
      JSON.stringify(input),
    );
});

test('order queries validate dates, enum filters, integer pagination and unknown fields', async () => {
  const query = (value) => pipe.transform(value, { type: 'query', metatype: OrderQueryDto });
  const defaults = await query({});
  assert.equal(defaults.limit, 20);
  assert.equal(defaults.offset, 0);
  assert.equal(defaults.customerSeq, undefined);
  const result = await query({
    customerSeq: '31',
    limit: '100',
    offset: '2',
    from: '2026-10-27T00:00:00+09:00',
    to: '2026-10-28T00:00:00Z',
    status: 'COLLECTING',
    recipientName: ' 수령인 ',
  });
  assert.equal(result.customerSeq, 31);
  assert.equal(result.limit, 100);
  assert.equal(result.offset, 2);
  assert.equal(result.recipientName, '수령인');
  assert.equal(result.status, 'COLLECTING');
  for (const input of [
    { customerSeq: '0' },
    { customerSeq: '2147483648' },
    { customerSeq: '1e2' },
    { customerSeq: ['1', '2'] },
    { limit: '0' },
    { limit: '101' },
    { limit: '' },
    { offset: '-1' },
    { offset: '1.5' },
    { status: 'paid' },
    { shipmentStatus: 'paid' },
    { recipientName: '   ' },
    { recipientName: ['a', 'b'] },
    { from: '2026-02-30T00:00:00Z' },
    { to: '2026-10-28T00:00:00' },
    { unexpected: '1' },
  ])
    await assert.rejects(
      () => query(input),
      (error) => error.getStatus() === 400,
      JSON.stringify(input),
    );
});

test('order path IDs accept only positive PostgreSQL integers', async () => {
  const params = (id) => pipe.transform({ id }, { type: 'param', metatype: OrderIdParamsDto });
  assert.equal((await params('2147483647')).id, 2147483647);
  for (const id of ['0', '-1', '2147483648', '1.5', '1e2', '+1', 'abc', '1 OR 1=1'])
    await assert.rejects(
      () => params(id),
      (error) => error.getStatus() === 400,
      id,
    );
});

test('collecting orders accept missing details and preserve nullable fields and leading zeros', async () => {
  const minimal = await validate({ customerSeq: 31 });
  assert.equal(minimal.parcels, undefined);
  assert.equal(minimal.paymentMethodType, undefined);
  assert.deepEqual((await validate({ customerSeq: 31, parcels: [] })).parcels, []);
  const partial = await validate({
    customerSeq: 31,
    pickupRequestedAt: null,
    parcels: [
      {
        origin: { name: '발송인', phoneNumber: '01012345678', roadAddress: null },
        originPin: null,
        itemPrice: null,
      },
    ],
  });
  assert.equal(partial.parcels[0].origin.phoneNumber, '01012345678');
  assert.equal(partial.parcels[0].origin.roadAddress, null);
  assert.equal(partial.parcels[0].itemPrice, null);
});

test('order inputs preserve zero, explicit timezone and PostgreSQL numeric boundaries', async () => {
  const result = await validate({
    customerSeq: 2147483647,
    paymentMethodType: 'billing',
    pickupRequestedAt: '2026-10-28T10:00:00+09:00',
    parcels: [
      {
        origin: { latitude: 0, longitude: 180 },
        documentCount: 0,
        smallBoxCount: 2147483647,
        itemPrice: Number.MAX_SAFE_INTEGER,
      },
    ],
  });
  assert.equal(result.parcels[0].origin.latitude, 0);
  assert.equal(result.parcels[0].documentCount, 0);
  assert.equal(result.parcels[0].itemPrice, Number.MAX_SAFE_INTEGER);
});

test('orders accept customer identity without an existing customer ID', async () => {
  const input = { customer: { name: '신규 고객', phoneNumber: '01000550001' } };
  const result = await validate(input);
  assert.equal(result.customerSeq, undefined);
  assert.equal(result.customer.name, input.customer.name);
  assert.equal(result.customer.phoneNumber, input.customer.phoneNumber);
});

test('order inputs reject invalid types, nulls, ranges, nested arrays and extra fields', async () => {
  const bodies = [
    {},
    { customerSeq: '31' },
    { customerSeq: 0 },
    { customerSeq: 2147483648 },
    { customer: null },
    { customer: [] },
    { customer: {} },
    { customer: { name: ' \t', phoneNumber: '01000550001' } },
    { customer: { name: 1, phoneNumber: '01000550001' } },
    { customer: { name: '고객', phoneNumber: 1000550001 } },
    { customer: { name: '고객', phoneNumber: '010-0055-0001' } },
    { customer: { name: '고객', phoneNumber: '' } },
    { customer: { name: '고객', phoneNumber: '01000550001', status: 'ACTIVE' } },
    { customerSeq: 31, paymentMethodType: null },
    { customerSeq: 31, paymentMethodType: 'cash' },
    { customerSeq: 31, paymentMethodType: 'cat' },
    { customerSeq: 31, pickupRequestedAt: '2026-10-28T10:00:00' },
    { customerSeq: 31, pickupRequestedAt: '2026-02-30T10:00:00Z' },
    { customerSeq: 31, parcels: null },
    { customerSeq: 31, parcels: [null] },
    { customerSeq: 31, parcels: [[{}]] },
    { customerSeq: 31, parcels: [{ origin: null }] },
    { customerSeq: 31, parcels: [{ origin: [] }] },
    { customerSeq: 31, parcels: [{ origin: { phoneNumber: '010-1234-5678' } }] },
    { customerSeq: 31, parcels: [{ origin: { latitude: 91 } }] },
    { customerSeq: 31, parcels: [{ origin: { longitude: -181 } }] },
    { customerSeq: 31, parcels: [{ origin: { latitude: Infinity } }] },
    { customerSeq: 31, parcels: [{ originPin: { scope: 'PERSONAL' } }] },
    { customerSeq: 31, parcels: [{ documentCount: null }] },
    { customerSeq: 31, parcels: [{ documentCount: -1 }] },
    { customerSeq: 31, parcels: [{ documentCount: 1.5 }] },
    { customerSeq: 31, parcels: [{ documentCount: '1' }] },
    { customerSeq: 31, parcels: [{ itemPrice: Number.MAX_SAFE_INTEGER + 1 }] },
    { customerSeq: 31, parcels: [{ notifiedPrice: 1 }] },
    { customerSeq: 31, parcels: [{ origin: { unexpected: true } }] },
    { customerSeq: 31, status: 'ACCEPTED' },
  ];
  for (const body of bodies) {
    await assert.rejects(
      () => validate(body),
      (error) => {
        assert.equal(error.getStatus(), 400);
        assert.equal(error.getResponse().code, 'INVALID_REQUEST');
        return true;
      },
      JSON.stringify(body),
    );
  }
});
