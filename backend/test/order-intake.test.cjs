require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { OrderIntakeService } = require('../dist/orders/order-intake.service');

test('a slow finalization does not serialize the recovery batch ahead of existing payment maintenance', async () => {
  const service = new OrderIntakeService(null, { candidates: async () => [1, 2] });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const started = [];
  service.finalize = async (id) => {
    started.push(id);
    await gate;
  };
  const pending = service.recoverPending();
  try {
    await new Promise(setImmediate);
    assert.deepEqual(started, [1, 2]);
  } finally {
    release();
    await pending;
  }
});
