require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertOrderAmount } = require('../dist/orders/order-pricing');
const { createValidationPipe } = require('../dist/common/http/validation.pipe');
const { CreateOrderDto } = require('../dist/orders/dto/create-order.dto');
const pipe = createValidationPipe();

test('fees are validated at the input boundary without accepting strings or fractions', async () => {
  for (const fee of [1, 3000, 2147483647]) {
    const value = await pipe.transform(
      { customerSeq: 1, totalAmount: fee, parcels: [{ notifiedPrice: fee }] },
      { type: 'body', metatype: CreateOrderDto },
    );
    assert.equal(value.parcels[0].notifiedPrice, fee);
  }
  for (const fee of [0, -1, 1.5, '3500', true, 2147483648]) {
    await assert.rejects(
      () =>
        pipe.transform(
          { customerSeq: 1, parcels: [{ notifiedPrice: fee }] },
          { type: 'body', metatype: CreateOrderDto },
        ),
      (e) => e.getStatus() === 400,
    );
  }
});

test('the active parcel sum must match the supplied order amount and fit the database range', () => {
  const parcels = [{ notifiedPrice: 3000 }, { notifiedPrice: 5000 }, { notifiedPrice: 4000 }];
  assert.doesNotThrow(() => assertOrderAmount({ totalAmount: 12000, parcels }));
  parcels[1].status = 'CANCELLED';
  assert.doesNotThrow(() => assertOrderAmount({ totalAmount: 7000, parcels }));
  for (const totalAmount of [null, 0, -1, 12000, 7000.1])
    assert.throws(
      () => assertOrderAmount({ totalAmount, parcels }),
      (e) => e.getStatus() === 422,
    );
  assert.throws(
    () =>
      assertOrderAmount({
        totalAmount: 2147483647,
        parcels: [{ notifiedPrice: 2147483647 }, { notifiedPrice: 1 }],
      }),
    (e) => e.getStatus() === 422,
  );
});
