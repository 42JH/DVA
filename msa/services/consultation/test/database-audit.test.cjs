require('reflect-metadata');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseService}=require('../dist/database/database.service');
async function fixture(mode){
  const values={DB_HOST:'unused',DB_PORT:5432,DB_USER:'unused',DB_PASSWORD:'unused',DB_NAME:'unused'};
  const db=new DatabaseService({get:key=>values[key]});await db.onModuleDestroy();
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

test('owner callback queries keep one independent connection with the existing database limits',async()=>{
  const values={DB_HOST:'unused',DB_PORT:5432,DB_USER:'unused',DB_PASSWORD:'unused',DB_NAME:'unused'};
  const database=new DatabaseService({get:key=>values[key]});
  try {
    assert.notEqual(database.referencePool,database.pool);assert.equal(database.pool.options.max,5);assert.equal(database.referencePool.options.max,1);
    for(const key of ['host','port','user','password','database','connectionTimeoutMillis','query_timeout','options'])
      assert.equal(database.referencePool.options[key],database.pool.options[key]);
  } finally {await database.onModuleDestroy();}
});

test('owner writes leave capacity for audit completion and release queued work after a dependency failure',async t=>{
  const {createServer}=require('node:http');
  const {randomUUID}=require('node:crypto');
  const {ParcelDraftWriteService}=require('../dist/customers/parcel-draft-write.service');
  let active=0,peak=0,arrived=0,release;
  const held=new Promise(resolve=>{release=resolve;});
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const event=JSON.parse(Buffer.concat(chunks));arrived++;
    await held;
    res.setHeader('Content-Type','application/json');
    if(event.payload.command.id===1)res.writeHead(503).end(JSON.stringify({error:{code:'DEPENDENCY_UNAVAILABLE',message:'Unavailable',details:[]}}));
    else res.end(JSON.stringify({eventId:event.eventId,status:'processed',payload:{data:{sealed:true},receipt:null}}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{release();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const client={query:async(sql,params)=>({rows:[{callSessionSeq:params?.[0]??1,customerSeq:1,intakeVersion:1}]})};
  const database={pool:{options:{max:5}},transaction:async work=>{active++;peak=Math.max(peak,active);try{return await work(client);}finally{active--;}}};
  const values={CUSTOMER_URL:'http://127.0.0.1:'+server.address().port,CONSULTATION_AUTH_TOKEN:'owner-write-test-token-'.padEnd(48,'a')};
  const service=new ParcelDraftWriteService(database,{get:key=>values[key]},null,{run:async(id,client,work)=>work()},null);
  service.recoverCall=async()=>{};
  const results=Promise.allSettled(Array.from({length:20},(_,n)=>service.execute({eventId:randomUUID(),source:'order',eventType:'ParcelDraftWriteRequested',payload:{orderAddress:null,command:{operation:'OrderIntakeSealed',id:n+1,callSessionSeq:n+1,adminId:null,input:{expectedIntakeVersion:1,paymentMethodType:'credit'},requestId:randomUUID()}}})));
  try{
    const deadline=Date.now()+2000;while(arrived<4&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(arrived,4);assert.ok(active<database.pool.options.max,'a business connection must remain available for commit confirmation');
  }finally{release();}
  const settled=await results;
  assert.equal(settled.filter(row=>row.status==='fulfilled').length,19);
  assert.equal(settled.filter(row=>row.status==='rejected').length,1);
  assert.equal(settled.find(row=>row.status==='rejected').reason.getStatus(),503);
  assert.equal(active,0);assert.equal(peak,4);assert.equal(service.activeCalls.size,0);
});
