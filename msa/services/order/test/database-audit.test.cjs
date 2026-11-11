require('reflect-metadata');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseService}=require('../dist/database/database.service');
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

test('owner recovery reads use the reference connection while business connections are occupied',async()=>{
  const {ParcelDraftWriteController}=require('../dist/orders/parcel-draft-write.controller');
  const reads=[];
  const receipt={eventId:require('node:crypto').randomUUID()};
  const database={
    pool:{query:async()=>{throw new Error('All five business connections are occupied');}},
    referencePool:{query:async sql=>{reads.push(sql);return{rows:sql.includes('customerReceipt')?[{receipt}]:[]};}},
  };
  const controller=new ParcelDraftWriteController(null,null,database,null,null,null);
  for(const [source,operation,input]of [
    ['consultation','PendingCallWritesRead',{id:1}],
    ['consultation','IntakeFinalizationRead',{id:1}],
    ['customer','RecipientReceiptRead',{eventId:receipt.eventId}],
  ]) {
    const event={eventId:require('node:crypto').randomUUID(),source,eventType:'ParcelDraftWriteReferenceRequested',payload:{operation,input}};
    const result=await controller.references(event);
    assert.equal(result.eventId,event.eventId);
    assert.equal(result.status,'processed');
    assert.deepEqual(result.payload,operation==='RecipientReceiptRead'?receipt:operation==='IntakeFinalizationRead'?null:[]);
  }
  assert.equal(reads.length,3);
});
