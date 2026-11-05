require('reflect-metadata');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseService}=require('../dist/database/database.service');
async function fixture(mode){
  const values={DB_HOST:'unused',DB_PORT:5432,DB_USER:'unused',DB_PASSWORD:'unused',DB_NAME:'unused'};
  const db=new DatabaseService({get:key=>values[key]});await db.pool.end();
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
    if(sql.startsWith('INSERT INTO outbox_events')){const id=randomUUID();decisions.push({id,payload:values[3]});return{rows:[{event_id:id}]};}
    return{rows:[]};
  }};
  const config={OPERATIONS_URL:'http://operations:3005',CUSTOMER_AUTH_TOKEN:'test-only-audit-token-'.padEnd(40,'a')};
  const audit=new AuditService({pool:{}},{get:key=>config[key]});
  for(let i=0;i<3001;i++)await audit.recordSuccess({actorId:1,action:'MEMBERSHIP_REMOVED',targetType:'MEMBERSHIP',targetId:i+1,requestId:randomUUID()},client);
  const confirm=await audit.beforeCommit(client);
  for(const decision of decisions)assert.ok(Buffer.byteLength(JSON.stringify({eventId:decision.id,source:'customer',eventType:'AuditCommitted',payload:decision.payload}))<100*1024,'confirmation exceeds Nest HTTP limit');
  assert.deepEqual(decisions.flatMap(item=>item.payload.preparedEventIds),prepared);
  let confirmed;audit.flush=async id=>{confirmed=id;};await confirm();
  assert.equal(confirmed,decisions.at(-1).id);
});
