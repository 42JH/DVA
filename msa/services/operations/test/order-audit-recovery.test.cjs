require('reflect-metadata');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {ServiceAuditReceiver}=require('../dist/audit/service-audit.receiver');

test('payment failure and notification audits retain only SYSTEM source outcomes without payment data',async()=>{
  const token='payment-audit-regression-'.padEnd(48,'x'),writes=[];
  const client={query:async()=>({rows:[],rowCount:1}),release(){}};
  const receiver=new ServiceAuditReceiver({pool:{connect:async()=>client}},{get:()=>token},
    {insert:async(audit,result)=>{writes.push({audit,result});}});
  const event=(action,result,metadata)=>({eventId:randomUUID(),source:'order',eventType:'AuditPrepared',payload:{
    transactionId:randomUUID(),result,occurredAt:new Date().toISOString(),audit:{actorType:'SYSTEM',actorId:null,
      targetType:'ORDER',targetId:1,action,requestId:randomUUID(),...(metadata===undefined?{}:{metadata})},
  }});
  let accepted=0;
  for(const completion of ['', 'COMPLETION_'])for(const status of ['ATTEMPTED','SENT','FAILED','UNKNOWN']){
    const input=event(`ORDER_PAYMENT_${completion}NOTIFICATION_${status}`,['ATTEMPTED','SENT'].includes(status)?'SUCCESS':'FAILED');
    await receiver.receive(input,'Bearer '+token);accepted++;
    const wrong=structuredClone(input);wrong.eventId=randomUUID();wrong.payload.result=input.payload.result==='SUCCESS'?'FAILED':'SUCCESS';
    await assert.rejects(receiver.receive(wrong,'Bearer '+token));
  }
  for(const action of ['ORDER_PAYMENT_CONFIRMATION','ORDER_PAYMENT_RECONCILED','ORDER_CARD_PAYMENT']){
    for(const reason of [undefined,'PAYMENT_DECLINED','PAYMENT_RESULT_UNKNOWN','PAYMENT_REQUEST_FAILED']){
      const input=event(action,'FAILED',reason===undefined?undefined:{reason});input.payload.audit.targetId=null;
      await receiver.receive(input,'Bearer '+token);accepted++;
    }
    await receiver.receive(event(action,'DENIED'),'Bearer '+token);accepted++;
    for(const input of [event(action,'SUCCESS'),event(action,'FAILED',{reason:'PRIVATE'}),
      event(action,'FAILED',{reason:'PAYMENT_DECLINED',paymentKey:'PRIVATE'})])
      await assert.rejects(receiver.receive(input,'Bearer '+token));
  }
  for(const change of [{actorType:'AI'},{actorType:'ADMIN',actorId:1},{actorName:'PRIVATE'},
    {targetType:'PAYMENT_CARD'},{targetId:null},{metadata:{paymentRequestId:'PRIVATE'}}]){
    const input=event('ORDER_PAYMENT_NOTIFICATION_SENT','SUCCESS');Object.assign(input.payload.audit,change);
    await assert.rejects(receiver.receive(input,'Bearer '+token));
  }
  for(const source of ['customer','consultation']){
    const input=event('ORDER_PAYMENT_CONFIRMATION','FAILED');input.source=source;
    await assert.rejects(receiver.receive(input,'Bearer '+token));
  }
  assert.equal(writes.length,accepted);
});

test('automatic complaint audits accept only consultation SYSTEM outcomes and bounded metadata',async()=>{
  const token='complaint-audit-regression-'.padEnd(48,'x'),writes=[];
  const client={query:async()=>({rows:[],rowCount:1}),release(){}};
  const receiver=new ServiceAuditReceiver({pool:{connect:async()=>client}},{get:()=>token},
    {insert:async(audit,result)=>{writes.push({audit,result});}});
  const event=(action,result,metadata)=>({eventId:randomUUID(),source:'consultation',eventType:'AuditPrepared',payload:{
    transactionId:randomUUID(),result,occurredAt:new Date().toISOString(),audit:{
      actorId:null,actorType:'SYSTEM',action,targetType:'CALL_SESSION',targetId:1,requestId:randomUUID(),
      ...(metadata===undefined?{}:{metadata}),
    },
  }});
  const judged=()=>event('CALL_COMPLAINT_JUDGED','SUCCESS',{hasComplaint:false,complaintCount:0});
  for(const input of [judged(),event('CALL_COMPLAINT_JUDGED','SUCCESS',{hasComplaint:true,complaintCount:2147483647}),
    ...['MODEL_UNAVAILABLE','RECORDING_UNAVAILABLE','INPUT_TOO_LONG'].map(reason=>event('CALL_COMPLAINT_FAILED','FAILED',{reason})),
    event('CALL_COMPLAINT_FAILED','FAILED'),event('CALL_COMPLAINT_FAILED','DENIED')]){
    await receiver.receive(input,'Bearer '+token);
    assert.deepEqual(writes.at(-1),{audit:input.payload.audit,result:input.payload.result});
  }
  for(const change of [{actorType:'AI'},{actorType:'ADMIN',actorId:1},{actorName:'PRIVATE'},
    {targetType:'ORDER'},{targetId:null},{metadata:{hasComplaint:'false',complaintCount:0}},
    {metadata:{hasComplaint:true,complaintCount:-1}},{metadata:{hasComplaint:true,complaintCount:0.5}},
    {metadata:{hasComplaint:true,complaintCount:2147483648}},{metadata:{hasComplaint:false,complaintCount:0,transcript:'PRIVATE'}}]){
    const input=judged();Object.assign(input.payload.audit,change);
    await assert.rejects(receiver.receive(input,'Bearer '+token));
  }
  for(const input of [event('CALL_COMPLAINT_JUDGED','FAILED',{hasComplaint:false,complaintCount:0}),
    event('CALL_COMPLAINT_FAILED','SUCCESS'),event('CALL_COMPLAINT_FAILED','FAILED',{reason:'PRIVATE'}),
    event('CALL_COMPLAINT_FAILED','FAILED',{reason:'MODEL_UNAVAILABLE',error:'PRIVATE'}),
    {...judged(),source:'customer'},{...judged(),source:'order'}])
    await assert.rejects(receiver.receive(input,'Bearer '+token));
  await assert.rejects(receiver.receive(judged(),'Bearer wrong'));
  assert.equal(writes.length,7);
});

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

test('card removal audits bind success to card IDs and failures to public owners without private fields', async () => {
  const token = 'card-audit-regression-token-'.padEnd(48, 'x');
  const client = { query: async () => ({ rows: [], rowCount: 1 }), release() {} };
  const writes = [];
  const receiver = new ServiceAuditReceiver(
    { pool: { connect: async () => client } },
    { get: () => token },
    { insert: async (audit, result) => writes.push({ audit, result }) },
  );
  const event = (result, targetType, actorType = 'AI', targetId = 1) => ({
    eventId: randomUUID(),
    source: 'customer',
    eventType: 'AuditPrepared',
    payload: {
      transactionId: randomUUID(),
      result,
      occurredAt: new Date().toISOString(),
      audit: {
        actorType,
        actorId: actorType === 'ADMIN' ? 1 : null,
        action: 'PAYMENT_CARD_DELETED',
        targetType,
        targetId,
        requestId: randomUUID(),
      },
    },
  });
  for (const actor of ['AI', 'ADMIN'])
    await receiver.receive(event('SUCCESS', 'PAYMENT_CARD', actor), 'Bearer ' + token);
  for (const result of ['FAILED', 'DENIED'])
    for (const owner of ['CUSTOMER', 'ORGANIZATION'])
      await receiver.receive(event(result, owner, 'SYSTEM', null), 'Bearer ' + token);
  for (const [result, target] of [
    ['SUCCESS', 'PAYMENT_CARD'],
    ['FAILED', 'CUSTOMER'],
  ]) {
    const registration = event(result, target);
    registration.payload.audit.action = 'PAYMENT_CARD_REGISTERED';
    await receiver.receive(registration, 'Bearer ' + token);
  }
  const privateMetadata = event('SUCCESS', 'PAYMENT_CARD');
  privateMetadata.payload.audit.metadata = { billingKey: 'private' };
  const unrelated = event('SUCCESS', 'PAYMENT_CARD');
  unrelated.payload.audit.action = 'CUSTOMER_CREATED';
  for (const invalid of [
    event('SUCCESS', 'CUSTOMER'),
    event('SUCCESS', 'PAYMENT_CARD', 'SYSTEM'),
    event('SUCCESS', 'PAYMENT_CARD', 'AI', null),
    event('FAILED', 'PAYMENT_CARD'),
    privateMetadata,
    unrelated,
  ]) {
    const before = writes.length;
    await assert.rejects(receiver.receive(invalid, 'Bearer ' + token));
    assert.equal(writes.length, before);
  }
  const revoked=event('SUCCESS','PAYMENT_CARD','SYSTEM');
  revoked.payload.audit.action='PAYMENT_CARD_REVOKED';
  await receiver.receive(revoked,'Bearer '+token);
  for(const change of [{actorType:'AI'},{actorType:'ADMIN',actorId:1},{targetType:'CUSTOMER'},
    {targetId:null},{actorId:1},{metadata:{billingKey:'private'}}]) {
    const invalid=structuredClone(revoked);invalid.eventId=randomUUID();
    Object.assign(invalid.payload.audit,change);
    await assert.rejects(receiver.receive(invalid,'Bearer '+token));
  }
  const failed=structuredClone(revoked);failed.eventId=randomUUID();failed.payload.result='FAILED';
  await assert.rejects(receiver.receive(failed,'Bearer '+token));
  assert.equal(writes.length, 9);
});
