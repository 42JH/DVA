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

test('finalization batches distinct mappings and preserves duplicate version increments', async () => {
  const { OrderIntakeRepository } = require('../dist/orders/order-intake.repository');
  const repository = new OrderIntakeRepository(null);
  for (const mappings of [
    [],
    [{ draftSeq: 1, orderParcelSeq: 11 }],
    [
      { draftSeq: 1, orderParcelSeq: 11 },
      { draftSeq: 2, orderParcelSeq: 12 },
    ],
    [
      { draftSeq: 1, orderParcelSeq: 11 },
      { draftSeq: 1, orderParcelSeq: 11 },
    ],
  ]) {
    const queries = [];
    await repository.finish(
      {
        query: async (text, values) => {
          queries.push({ text, values });
          return {};
        },
      },
      7,
      9,
      mappings,
    );
    const updates = queries.filter((q) => /SET status='CONVERTED'/.test(q.text));
    assert.equal(
      updates.length,
      mappings.length === 2 && mappings[0].draftSeq !== mappings[1].draftSeq ? 1 : mappings.length,
    );
    if (updates.length === 1 && mappings.length === 2) {
      assert.match(updates[0].text, /jsonb_to_recordset/);
      assert.deepEqual(JSON.parse(updates[0].values[0]), mappings);
    }
    assert.deepEqual(JSON.parse(queries.at(-1).values[1]), {
      orderSeq: 9,
      parcelMappings: mappings,
    });
  }
});
