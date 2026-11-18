require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { OrderRetentionWorker } = require('../dist/orders/order-retention.worker');
const config={get:key=>({NODE_ENV:'test',DELIVERY_URL:'http://delivery',CUSTOMER_AUTH_TOKEN:'retention-test-only-'.padEnd(40,'x')})[key]};

test('order retention coalesces ticks, waits for shutdown and does not schedule in test mode', async () => {
  let finish, transactions = 0;
  const worker = new OrderRetentionWorker({ purgeDatabase: () => { transactions++; return new Promise(resolve => finish = resolve); } }, {pool:{}}, config);
  worker.start(); assert.equal(transactions, 0);
  const first = worker.run(); assert.equal(worker.run(), first); assert.equal(transactions, 1);
  let stopped = false; const stopping = worker.onModuleDestroy().then(() => stopped = true);
  await Promise.resolve(); assert.equal(stopped, false);
  finish(); await stopping; assert.equal(stopped, true);
  await worker.run();assert.equal(transactions,1);
});
test('order retention defers delivery without its cleanup lock and retries failed cleanup', async () => {
  let locked=false,fail=false,deliveries=0;
  const worker = new OrderRetentionWorker({purgeDatabase:async()=>{if(fail)throw new Error('test-only failure');return locked;}},
    {pool:{connect:async()=>{deliveries++;return{query:async()=>({rows:[]}),release(){}};}}},config);
  await worker.run();assert.equal(deliveries,0);
  fail=true;await assert.rejects(worker.run());assert.equal(deliveries,0);
  fail=false;locked=true;await worker.run();assert.equal(deliveries,1);
  await worker.onModuleDestroy();
});
