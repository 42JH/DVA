require('reflect-metadata');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {ServiceAuditReceiver}=require('../dist/audit/service-audit.receiver');

test('order cancellation and billing audits preserve the monolith storage contracts', async () => {
  const token = 'order-audit-regression-token-'.padEnd(48, 'x');
  const client = { query: async () => ({ rows: [], rowCount: 1 }), release() {} };
  const writes = [];
  const receiver = new ServiceAuditReceiver(
    { pool: { connect: async () => client } },
    { get: () => token },
    { insert: async (audit, result) => { writes.push({ audit, result }); } },
  );
  const event = (result, metadata) => ({
    eventId: randomUUID(), source: 'order', eventType: 'AuditPrepared',
    payload: {
      transactionId: randomUUID(), result, occurredAt: new Date().toISOString(),
      audit: {
        actorType: 'SYSTEM', actorId: null, action: 'ORDER_CANCELLED',
        targetType: 'ORDER', targetId: 1, requestId: randomUUID(),
        ...(metadata === undefined ? {} : { metadata }),
      },
    },
  });
  for (const result of ['DENIED', 'FAILED']) {
    const input = event(result);
    assert.equal((await receiver.receive(input, 'Bearer ' + token)).status, 'processed');
    assert.equal(writes.at(-1).result, result);
    assert.equal(writes.at(-1).audit.actorType, 'SYSTEM');
  }
  const expiry = { amountBefore: 7000, amountAfter: 0, reason: 'PAYMENT_EXPIRED' };
  await receiver.receive(event('SUCCESS', expiry), 'Bearer ' + token);
  assert.deepEqual(writes.at(-1).audit.metadata, expiry);
  for (const invalid of [
    event('SUCCESS'), event('DENIED', expiry),
    event('SUCCESS', { ...expiry, reason: 'OTHER' }),
    event('SUCCESS', { ...expiry, amountAfter: 1 }),
  ]) {
    const before = writes.length;
    await assert.rejects(receiver.receive(invalid, 'Bearer ' + token));
    assert.equal(writes.length, before);
  }
  const billing = (action, amountBefore, amountAfter) => {
    const input = event('SUCCESS', {
      billingMonth: '2035-04', paymentMethodType: 'credit', amountBefore, amountAfter,
    });
    input.payload.audit.action = action;
    input.payload.audit.targetType = 'ORGANIZATION';
    return input;
  };
  for (const valid of [
    billing('BILLING_MONTH_INITIALIZED', Number.MAX_SAFE_INTEGER, 0),
    billing('BILLING_AMOUNT_INCREASED', Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER),
  ]) await receiver.receive(valid, 'Bearer ' + token);
  for (const invalid of [
    billing('BILLING_MONTH_INITIALIZED', Number.MAX_SAFE_INTEGER + 1, 0),
    billing('BILLING_AMOUNT_INCREASED', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1),
  ]) {
    const before = writes.length;
    await assert.rejects(receiver.receive(invalid, 'Bearer ' + token));
    assert.equal(writes.length, before);
  }
});

test('a consultation recovery outage does not prevent order recovery and shutdown waits for both',async t=> {
  let tick,release,finished=false;
  t.mock.method(global,'setInterval',work=>{tick=work;return{unref(){}};});
  t.mock.method(global,'clearInterval',()=>{});
  const receiver=new ServiceAuditReceiver({pool:{}},{get:()=>undefined},{}),seen=[];
  receiver.flushPending=async services=> {
    seen.push(...services);
    if(services[0]==='consultation')throw Error('unavailable');
    await new Promise(resolve=>{release=resolve;});finished=true;
  };
  receiver.onModuleInit();tick();
  assert.deepEqual(seen,['consultation','order']);
  const stopping=receiver.onModuleDestroy();await Promise.resolve();assert.equal(finished,false);
  release();await stopping;assert.equal(finished,true);
});
