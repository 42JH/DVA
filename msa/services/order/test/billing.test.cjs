require('reflect-metadata');
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {createServer}=require('node:http');
const {validateBilling,requestBilling,BillingError}=require('@dva/events/billing.cjs');
const {BillingWorker}=require('../dist/billing/billing.worker');
const token='billing-test-only-'.padEnd(40,'x');
const rollover=()=>({eventId:randomUUID(),source:'order',eventType:'BillingRolloverRequested',payload:{months:[{organizationSeq:1,billingMonth:'2026-11-01'}]}});
let server,url,mode='valid';
before(async()=>{
  server=createServer(async(req,res)=>{
    const parts=[];for await(const part of req)parts.push(part);const input=JSON.parse(Buffer.concat(parts));
    assert.equal(req.headers.authorization,'Bearer '+token);
    if(mode==='lost'){req.socket.destroy();return;}
    if(mode==='redirect'){res.writeHead(307,{Location:'/wrong'}).end();return;}
    res.setHeader('Content-Type',mode==='html'?'text/html':'application/json');
    if(mode==='domain'){res.writeHead(404).end(JSON.stringify({error:{code:'NOT_FOUND',message:'기업을 찾을 수 없습니다.',details:[]}}));return;}
    if(mode==='oversized'){res.end(' '.repeat(4097));return;}
    const payload=input.eventType==='BillingRolloverRequested'?true:input.eventType==='BillingOrganizationsReadRequested'?[1,2]:
      input.eventType==='CustomerBillingReadRequested'?{customerSeq:mode==='customer'?2:1,month:'2026-11',monthlyAmount:mode==='amount'?-1:Number.MAX_SAFE_INTEGER+1}:
      {organizationSeq:1,organizationName:null,month:'2026-11',monthlyAmount:Number.MAX_SAFE_INTEGER,groupBillingAmount:0};
    res.end(mode==='json'?'{' : mode==='utf8'?Buffer.from([255]):JSON.stringify({eventId:mode==='id'?randomUUID():input.eventId,status:mode==='status'?'received':'processed',payload:mode==='payload'?null:payload}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));url='http://127.0.0.1:'+server.address().port;
});
after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
test('billing commands reject forged owners, balances, names, duplicate or oversized batches',()=>{
  validateBilling(rollover(),'BillingRolloverRequested','order');
  for(const mutate of [e=>e.source='customer',e=>e.source='delivery',e=>e.eventType='AuditPrepared',e=>e.payload.actorId=1,
    e=>e.payload.months=[],e=>e.payload.months=Array(11).fill(e.payload.months[0]),e=>e.payload.months.push(e.payload.months[0]),
    e=>e.payload.months[0].organizationSeq=0,e=>e.payload.months[0].billingMonth='2026-02-31']){
    const bad=rollover();mutate(bad);assert.throws(()=>validateBilling(bad,'BillingRolloverRequested','order'));
  }
  const scoped={...rollover(),source:'customer'};scoped.payload.organizations=[{organizationSeq:1,name:'기업'}];
  validateBilling(scoped,'BillingRolloverRequested','customer');
  const personal={eventId:randomUUID(),source:'customer',eventType:'CustomerBillingReadRequested',payload:{id:1,month:null}};
  validateBilling(personal,'CustomerBillingReadRequested','customer');
  for(const changed of [{...personal,source:'order'},{...personal,payload:{id:0,month:null}},
    {...personal,payload:{id:1,month:'2026-13'}},{...personal,payload:{id:1,month:null,amount:1}}])
    assert.throws(()=>validateBilling(changed,'CustomerBillingReadRequested','customer'));
  for(const organizations of [[{organizationSeq:2,name:'위조'}],[{organizationSeq:1,name:'이름',amount:100}],Array(2).fill(scoped.payload.organizations[0])])
    assert.throws(()=>validateBilling({...scoped,payload:{...scoped.payload,organizations}},'BillingRolloverRequested','customer'));
});
test('billing requires matching strict ACKs, preserves domain errors and source float8 totals',async()=>{
  mode='valid';assert.equal(await requestBilling(url,token,rollover()),true);
  assert.deepEqual(await requestBilling(url,token,{eventId:randomUUID(),source:'order',eventType:'BillingOrganizationsReadRequested',payload:{}}),[1,2]);
  assert.equal((await requestBilling(url,token,{eventId:randomUUID(),source:'customer',eventType:'BillingReadRequested',payload:{id:1,month:'2026-11',organizationName:null}})).monthlyAmount,Number.MAX_SAFE_INTEGER);
  const personal={eventId:randomUUID(),source:'customer',eventType:'CustomerBillingReadRequested',payload:{id:1,month:'2026-11'}};
  assert.equal((await requestBilling(url,token,personal)).monthlyAmount,Number.MAX_SAFE_INTEGER+1);
  for(mode of ['id','status','payload','customer','amount'])await assert.rejects(requestBilling(url,token,personal));
  for(mode of ['lost','redirect','html','json','utf8','id','status','payload','oversized'])await assert.rejects(requestBilling(url,token,rollover()));
  mode='domain';await assert.rejects(requestBilling(url,token,rollover()),e=>e instanceof BillingError&&e.status===404&&e.error.message==='기업을 찾을 수 없습니다.');
});
test('rollover worker isolates tests, coalesces ticks, retries errors and waits for shutdown',async()=>{
  let calls=0,finish;
  const worker=new BillingWorker({rollover:()=>{calls++;return new Promise(resolve=>finish=resolve);}},{get:()=> 'test'});
  worker.onApplicationBootstrap();assert.equal(calls,0);
  const first=worker.run();assert.equal(worker.run(),first);assert.equal(calls,1);
  let closed=false;const stop=worker.onModuleDestroy().then(()=>closed=true);await Promise.resolve();assert.equal(closed,false);
  finish();await stop;assert.equal(closed,true);
  const retry=new BillingWorker({rollover:async()=>{if(calls++===1)throw new Error('test-only');}},{get:()=> 'test'});
  await assert.rejects(retry.run());await retry.run();await retry.onModuleDestroy();assert.equal(calls,3);
});
