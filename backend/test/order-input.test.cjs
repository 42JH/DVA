require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CreateOrderDto } = require('../dist/orders/dto/create-order.dto');
const { createValidationPipe } = require('../dist/common/http/validation.pipe');

const pipe = createValidationPipe();
const validate = (body) => pipe.transform(body, { type: 'body', metatype: CreateOrderDto });

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

test('order inputs reject invalid types, nulls, ranges, nested arrays and extra fields', async () => {
  const bodies = [
    {},
    { customerSeq: '31' },
    { customerSeq: 0 },
    { customerSeq: 2147483648 },
    { customerSeq: 31, paymentMethodType: null },
    { customerSeq: 31, paymentMethodType: 'cash' },
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
