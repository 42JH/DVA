require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ParcelDraftRetentionWorker } = require('../dist/orders/parcel-draft-retention.worker');

test('draft retention coalesces ticks, waits for shutdown and does not schedule in test mode', async () => {
  let finish, transactions = 0;
  const worker = new ParcelDraftRetentionWorker({ transaction: () => { transactions++; return new Promise(resolve => finish = resolve); } }, { get: () => 'test' });
  worker.start(); assert.equal(transactions, 0);
  const first = worker.run(); assert.equal(worker.run(), first); assert.equal(transactions, 1);
  let stopped = false; const stopping = worker.onModuleDestroy().then(() => stopped = true);
  await Promise.resolve(); assert.equal(stopped, false);
  finish(); await stopping; assert.equal(stopped, true);
});
test('draft retention leaves live work alone and a failed cleanup can be retried', async () => {
  let locked = false, fail = false; const sql = [];
  const worker = new ParcelDraftRetentionWorker({ transaction: async work => work({ query: async text => {
    sql.push(text); if (fail) throw new Error('test-only failure'); return { rows: [{ locked }] };
  } }) }, { get: () => 'test' });
  await worker.run(); assert.equal(sql.length, 1);
  fail = true; await assert.rejects(worker.run());
  sql.length = 0; fail = false; locked = true; await worker.run();
  assert.equal(sql.filter(s => s.startsWith('DELETE FROM order_parcel_drafts')).length, 1);
  assert.ok(!sql.some(s => /DELETE FROM (orders|call_sessions)/.test(s)));
  await worker.onModuleDestroy();
});
