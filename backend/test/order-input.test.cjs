require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { OrderInputDto } = require('../dist/orders/dto/order-input.dto');
const { createValidationPipe } = require('../dist/common/http/validation.pipe');
const validate = (body) =>
  createValidationPipe().transform(body, { type: 'body', metatype: OrderInputDto });

test('snapshot shape preserves missing values, zero, leading zeros and invalid collected strings', async () => {
  const input = {
    paymentMethodType: null,
    pickupRequestedAt: '미확인',
    parcels: [{ origin: { phoneNumber: '010-잘못수집', latitude: 0 }, smallBoxCount: 0 }],
  };
  const result = await validate(input);
  assert.equal(result.paymentMethodType, null);
  assert.equal(result.parcels[0].origin.phoneNumber, '010-잘못수집');
  assert.equal(result.parcels[0].origin.latitude, 0);
  assert.equal(result.parcels[0].smallBoxCount, 0);
  assert.equal((await validate({})).parcels, undefined);
});

test('snapshot boundary rejects unsupported fields, nested arrays and wrong primitive types', async () => {
  for (const input of [
    { customerSeq: 31 },
    { status: 'ACCEPTED' },
    { paymentMethodType: 1 },
    { parcels: 'wrong' },
    { parcels: [null] },
    { parcels: [[{}]] },
    { parcels: [{ origin: [] }] },
    { parcels: [{ origin: { phoneNumber: 10123 } }] },
    { parcels: [{ origin: { latitude: Infinity } }] },
    { parcels: [{ smallBoxCount: '1' }] },
    { parcels: [{ smallBoxCount: 1.5 }] },
    { parcels: [{ transcript: 'do not store conversations here' }] },
  ]) {
    await assert.rejects(
      () => validate(input),
      (error) => error.getStatus() === 400 && error.getResponse().code === 'INVALID_REQUEST',
    );
  }
});
