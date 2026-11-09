require('reflect-metadata');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {once}=require('node:events');
const {fork}=require('node:child_process');
const {createServer}=require('node:http');
const {Pool}=require('pg');
const {DatabaseService}=require('../dist/database/database.service');
const {AuditService}=require('../dist/audit/audit.service');
const {BillingService}=require('../dist/billing/billing.service');
const {requestBilling}=require('@dva/events/billing.cjs');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(work,label){for(let n=0;n<150;n++){if(await work())return;await pause(50);}assert.fail(label);}

test('billing initialization converges through actual producer SIGKILL, ACK loss and malformed audit rejection',async t=>{
  assert.equal(process.env.PGDATABASE,'dva_webhook_test');
  const order=new Pool({host:'order-db',user:'order_app'}),ops=new Pool({host:'operations-db',user:'operations_app'}),customer=new Pool({host:'customer-db',user:'customer_app'}),children=[];
  const token=process.env.CUSTOMER_AUTH_TOKEN,credentials={Authorization:'Bearer '+token,'Content-Type':'application/json'};
  const values={DB_HOST:'order-db',DB_PORT:5432,DB_USER:'order_app',DB_PASSWORD:process.env.PGPASSWORD,DB_NAME:'dva_webhook_test',
    CUSTOMER_URL:'http://customer-app:3001',OPERATIONS_URL:'http://operations-app:3005',CUSTOMER_AUTH_TOKEN:token};
  t.after(async()=>{for(const child of children)if(child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');child.kill('SIGKILL');await exit;}await Promise.all([order.end(),ops.end(),customer.end()]);});
  let seq=60000;
  const command=()=>{const id=++seq;return{eventId:randomUUID(),source:'customer',eventType:'BillingRolloverRequested',payload:{months:[{organizationSeq:id,billingMonth:'2035-04-01'}],organizations:[{organizationSeq:id,name:'복구 회사'}]}};};
  const logs=async id=>(await ops.query("SELECT * FROM audit_logs WHERE action='BILLING_MONTH_INITIALIZED' AND target_seq=$1 ORDER BY audit_log_seq",[id])).rows;
  async function start(mode,event){
    const child=fork(require.resolve('./billing-months-claimant.cjs'),[],{env:{...process.env,BILLING_CRASH:JSON.stringify({mode,event})},stdio:['ignore','pipe','pipe','ipc']});children.push(child);
    const [message]=await once(child,'message',{signal:AbortSignal.timeout(15000)});assert.equal(message.phase,'prepared');
    const prepared=(await ops.query("SELECT event_id,transaction_id FROM order_audit_preparations WHERE (audit->>'target_seq')::integer=$1",[event.payload.months[0].organizationSeq])).rows[0];assert.ok(prepared);return{child,...prepared};
  }
  async function receive(event,otherToken=token){const r=await fetch('http://operations-app:3005/internal/events',{method:'POST',headers:{...credentials,Authorization:'Bearer '+otherToken},body:JSON.stringify(event)});return{status:r.status,body:await r.json()};}
  await t.test('SIGKILL after first prepared audit rolls back the entire month and automatically aborts orphaned preparation',async()=>{
    const event=command(),id=event.payload.months[0].organizationSeq,producer=await start('prepared',event);
    await pause(1200);assert.equal((await ops.query('SELECT 1 FROM order_audit_preparations WHERE event_id=$1 AND NOT aborted',[producer.event_id])).rowCount,1);assert.deepEqual(await logs(id),[]);
    const exit=once(producer.child,'exit');producer.child.kill('SIGKILL');await exit;
    await until(async()=> (await ops.query('SELECT 1 FROM order_audit_preparations WHERE event_id=$1 AND aborted AND audit IS NULL',[producer.event_id])).rowCount===1,'automatic billing abort');
    assert.equal((await order.query('SELECT 1 FROM organization_billing_months WHERE organization_seq=$1',[id])).rowCount,0);assert.deepEqual(await logs(id),[]);
    assert.equal(await requestBilling('http://order-app:3002/internal/billing/initialize',token,event),true);assert.equal((await logs(id)).length,2);
  });
  await t.test('SIGKILL after business COMMIT restores both audit rows and duplicate confirmation does not reapply them',async()=>{
    const event=command(),id=event.payload.months[0].organizationSeq,producer=await start('committed',event),gate=await ops.connect();
    try{
      await gate.query('BEGIN');await gate.query('SELECT 1 FROM order_audit_preparations WHERE event_id=$1 FOR UPDATE',[producer.event_id]);
      const next=once(producer.child,'message');producer.child.send({continue:true});const [message]=await next;assert.equal(message.phase,'committed');
      assert.equal((await order.query('SELECT 1 FROM organization_billing_months WHERE organization_seq=$1',[id])).rowCount,1);assert.deepEqual(await logs(id),[]);
      const exit=once(producer.child,'exit');producer.child.kill('SIGKILL');await exit;
    }finally{await gate.query('ROLLBACK');gate.release();}
    await until(async()=> (await logs(id)).length===2,'automatic billing commit recovery');
    const saved=(await order.query("SELECT event_id,event_type,payload FROM outbox_events WHERE event_type='AuditCommitted' AND payload->>'transactionId'=$1",[producer.transaction_id])).rows[0];assert.ok(saved);
    const confirmation={eventId:saved.event_id,source:'order',eventType:saved.event_type,payload:saved.payload};
    for(let n=0;n<2;n++){const ack=await receive(confirmation);assert.equal(ack.status,200);assert.equal(ack.body.status,'duplicate');}
    const before=await logs(id);assert.equal(await requestBilling('http://order-app:3002/internal/billing/initialize',token,event),true);assert.deepEqual(await logs(id),before);
    assert.equal((await order.query("SELECT 1 FROM outbox_events WHERE event_type='AuditAborted' AND payload->>'transactionId'=$1",[producer.transaction_id])).rowCount,0);
  });
  await t.test('lost prepared/committed ACKs leave no partial month or duplicate audit',async()=>{
    for(const boundary of ['AuditPrepared','AuditCommitted']){
      let dropped=false;
      const proxy=createServer(async(req,res)=>{
        const parts=[];for await(const part of req)parts.push(part);const body=Buffer.concat(parts),event=JSON.parse(body);
        try{const upstream=await fetch('http://operations-app:3005/internal/events',{method:'POST',headers:credentials,body}),reply=await upstream.text();
          if(event.eventType===boundary&&!dropped){dropped=true;req.socket.destroy();return;}res.writeHead(upstream.status,{'Content-Type':'application/json'}).end(reply);
        }catch{req.socket.destroy();}
      });
      await new Promise(resolve=>proxy.listen(0,'0.0.0.0',resolve));
      const config={get:key=>key==='OPERATIONS_URL'?'http://127.0.0.1:'+proxy.address().port:values[key]},db=new DatabaseService(config),audit=new AuditService(db,config),service=new BillingService(db,audit,config),event=command(),id=event.payload.months[0].organizationSeq;
      try{
        if(boundary==='AuditPrepared'){await assert.rejects(service.initialize(event));await audit.flush();assert.equal((await order.query('SELECT 1 FROM organization_billing_months WHERE organization_seq=$1',[id])).rowCount,0);assert.deepEqual(await logs(id),[]);}
        else{assert.equal(await service.initialize(event),true);assert.equal((await logs(id)).length,2);}
        assert.equal(dropped,true);await service.initialize(event);const first=await logs(id);assert.equal(first.length,2);await service.initialize(event);assert.deepEqual(await logs(id),first);
      }finally{proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));await db.onModuleDestroy();}
    }
  });
  await t.test('lost outer callback ACK is recovered by rerunning discovery without extra months or audit rows',async()=>{
    const id=++seq;await customer.query("INSERT INTO organizations(organization_seq,name,status) OVERRIDING SYSTEM VALUE VALUES($1,'응답 유실 회사','ACTIVE')",[id]);
    let dropped=false;
    const proxy=createServer(async(req,res)=>{
      const parts=[];for await(const part of req)parts.push(part);const body=Buffer.concat(parts);
      try{const upstream=await fetch('http://customer-app:3001'+req.url,{method:'POST',headers:credentials,body}),reply=await upstream.text();
        if(req.url==='/internal/billing/rollover'&&!dropped){dropped=true;req.socket.destroy();return;}res.writeHead(upstream.status,{'Content-Type':'application/json'}).end(reply);
      }catch{req.socket.destroy();}
    });
    await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
    const config={get:key=>key==='CUSTOMER_URL'?'http://127.0.0.1:'+proxy.address().port:values[key]},db=new DatabaseService(config),audit=new AuditService(db,config),service=new BillingService(db,audit,config);
    try{await assert.rejects(service.rollover(new Date('2035-04-01Z')));assert.equal(dropped,true);
      const before=await logs(id);assert.equal(before.length,2);await service.rollover(new Date('2035-04-01Z'));assert.deepEqual(await logs(id),before);
      assert.equal((await order.query('SELECT 1 FROM organization_billing_months WHERE organization_seq=$1',[id])).rowCount,1);
    }finally{proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));await db.onModuleDestroy();}
  });
  await t.test('billing audit permits only order SYSTEM initialization with exact nonnegative safe-integer metadata',async()=>{
    const valid={eventId:randomUUID(),source:'order',eventType:'AuditPrepared',payload:{transactionId:randomUUID(),result:'SUCCESS',occurredAt:new Date().toISOString(),
      audit:{actorId:null,actorType:'SYSTEM',action:'BILLING_MONTH_INITIALIZED',targetType:'ORGANIZATION',targetId:++seq,requestId:randomUUID(),metadata:{billingMonth:'2035-04',paymentMethodType:'credit',amountBefore:0,amountAfter:0}}}};
    for(const mutate of [e=>e.source='customer',e=>e.payload.result='FAILED',e=>e.payload.audit.actorType='AI',e=>e.payload.audit.actorName='SYSTEM',
      e=>e.payload.audit.targetType='ORDER',e=>e.payload.audit.metadata.amountBefore=-1,e=>e.payload.audit.metadata.amountBefore=Number.MAX_SAFE_INTEGER+1,
      e=>e.payload.audit.metadata.amountAfter=1,e=>e.payload.audit.metadata.billingMonth='2035-13',e=>e.payload.audit.metadata.paymentMethodType='billing',e=>e.payload.audit.metadata.extra=1]){
      const bad=structuredClone(valid);bad.eventId=randomUUID();mutate(bad);assert.equal((await receive(bad)).status,422);
    }
    assert.equal((await receive(valid,'wrong')).status,403);
    const existing=structuredClone(valid);existing.eventId=randomUUID();existing.payload.audit.action='ORDER_CANCELLED';existing.payload.audit.targetType='ORDER';delete existing.payload.audit.metadata;
    assert.equal((await receive(existing)).status,422,'billing must not allow SYSTEM through administrator/AI cancellation');
  });
});
