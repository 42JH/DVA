require('reflect-metadata');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseService}=require('../dist/database/database.service');

test('card selection reuses a held customer transaction and avoids the occupied business pool otherwise', async () => {
  const { ParcelDraftWriteController } = require('../dist/customers/parcel-draft-write.controller');
  const { randomUUID } = require('node:crypto');
  let referenceReads = 0, heldReads = 0;
  const database = {
    pool: { query: async () => { throw new Error('All five business connections are occupied'); } },
    referencePool: { query: async () => { referenceReads++; return { rows: [{ id: 7 }] }; } },
  };
  const held = { query: async () => { heldReads++; return { rows: [] }; } };
  const controller = new ParcelDraftWriteController(database, null, { use: async (_id, work) => work(held) }, null, null);
  const event = { eventId: randomUUID(), source: 'order', eventType: 'ParcelDraftWriteReferenceRequested',
    payload: { operation: 'CustomerPaymentCardRead', input: { customerSeq: 1, organizationSeq: null } } };
  assert.equal((await controller.reference(event)).payload, 7);
  const scopeId = randomUUID();
  assert.equal((await controller.reference(event, scopeId)).payload, null);
  assert.equal(referenceReads, 1);
  assert.equal(heldReads, 1);
});
async function fixture(mode){
  const values={DB_HOST:'unused',DB_PORT:5432,DB_USER:'unused',DB_PASSWORD:'unused',DB_NAME:'unused'};
  const db=new DatabaseService({get:key=>values[key]});assert.equal(db.pool.options.max,5);assert.equal(db.referencePool.options.max,1);await Promise.all([db.pool.end(),db.referencePool.end()]);
  const events=[];let released=false;
  const client={query:async sql=>{events.push(sql);if(mode==='lost-commit'&&sql==='COMMIT')throw Error('connection lost');},release:()=>{released=true;events.push('release');}};
  db.pool={connect:async()=>client};
  db.audit={beforeCommit:async()=>{events.push('prepare');if(mode==='prepare-failed')throw Error('prepare failed');return async()=>{assert.equal(released,true);events.push('confirmed');};},
    rollback:async()=>{events.push('abort');},clear:()=>{events.push('clear');}};
  return{db,events};
}
test('confirmation runs after commit and releasing the business pool connection',async()=>{
  const {db,events}=await fixture('ok');assert.equal(await db.transaction(async()=>42),42);
  assert.ok(events.indexOf('COMMIT')<events.indexOf('release'));assert.ok(events.indexOf('release')<events.indexOf('confirmed'));assert.ok(!events.includes('abort'));
});
test('failed preparation rolls back business work and publishes an abort',async()=>{
  const {db,events}=await fixture('prepare-failed');await assert.rejects(db.transaction(async()=>42));
  assert.ok(events.includes('ROLLBACK'));assert.ok(events.includes('abort'));assert.ok(!events.includes('COMMIT'));assert.ok(!events.includes('confirmed'));
});
test('an unknown COMMIT outcome never sends an abort that could erase committed audit',async()=>{
  const {db,events}=await fixture('lost-commit');await assert.rejects(db.transaction(async()=>42));
  assert.ok(events.includes('COMMIT'));assert.ok(events.includes('release'));assert.ok(!events.includes('abort'));assert.ok(!events.includes('confirmed'));
});

test('large corporate audit confirmations fit the HTTP body limit and wait for the final batch',async t=>{
  const {AuditService}=require('../dist/audit/audit.service');
  const {randomUUID}=require('node:crypto');
  const prepared=[],decisions=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    const event=JSON.parse(options.body);prepared.push(event.eventId);
    return new Response(JSON.stringify({eventId:event.eventId,status:'processed'}),{headers:{'Content-Type':'application/json'}});
  });
  const client={query:async(sql,values)=>{
    if(sql.includes('transaction_timestamp()'))return{rows:[{at:new Date()}]};
    if(sql.startsWith('INSERT INTO outbox_events')){const id=randomUUID();decisions.push({id,type:values[1],key:values[2],payload:values[3]});return{rows:[{event_id:id}]};}
    return{rows:[]};
  }};
  const config={OPERATIONS_URL:'http://operations:3005',CUSTOMER_AUTH_TOKEN:'test-only-audit-token-'.padEnd(40,'a')};
  const audit=new AuditService({pool:{}},{get:key=>config[key]});
  for(let i=0;i<3001;i++)await audit.recordSuccess({actorId:1,action:'MEMBERSHIP_REMOVED',targetType:'MEMBERSHIP',targetId:i+1,requestId:randomUUID()},client);
  const confirm=await audit.beforeCommit(client);
  for(const decision of decisions)assert.ok(Buffer.byteLength(JSON.stringify({eventId:decision.id,source:'customer',eventType:'AuditCommitted',payload:decision.payload}))<100*1024,'confirmation exceeds Nest HTTP limit');
  assert.deepEqual(decisions.flatMap(item=>item.payload.preparedEventIds),prepared);
  const key=decisions[0].key;
  assert.ok(key>=2&&key<=2147483647);
  assert.ok(decisions.every(decision=>decision.key===key));
  let confirmed;audit.flush=async id=>{confirmed=id;};await confirm();
  assert.equal(confirmed,decisions.at(-1).id);
  await audit.rollback(client);
  assert.equal(decisions.at(-1).type,'AuditAborted');
  assert.equal(decisions.at(-1).key,key);
});
