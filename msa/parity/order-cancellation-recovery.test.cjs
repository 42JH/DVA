require('reflect-metadata');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {once}=require('node:events');
const {fork}=require('node:child_process');
const {createServer}=require('node:http');
const {Pool}=require('pg');
const {DatabaseService}=require('../dist/database/database.service');
const {sendEvent}=require('@dva/events');
const {requestOrderCancellation}=require('@dva/events/order-cancellation.cjs');
const {AuditService}=require('../dist/audit/audit.service');
const {OrdersService}=require('../dist/orders/orders.service');
const {OrdersRepository}=require('../dist/orders/orders.repository');
const {OrderShipmentCheckClient}=require('../dist/orders/order-shipment-check.client');
const {OrderDeletionCheckClient}=require('../dist/orders/order-deletion-check.client');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(work,label) {for(let i=0;i<100;i++){if(await work())return;await pause(100);}assert.fail(label);}

test('partial cancellation and payment replacement recover across ACK loss, duplicate delivery and actual producer SIGKILL',async t=> {
  assert.equal(process.env.PGDATABASE,'dva_webhook_test');
  const order=new Pool({host:'order-db',user:'order_app'}),ops=new Pool({host:'operations-db',user:'operations_app'});
  const children=[];
  t.after(async()=>{for(const child of children)if(child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');child.kill('SIGKILL');await exit;}await Promise.all([order.end(),ops.end()]);});
  let id=9000;
  const seed=async()=>{
    id++;
    await order.query("INSERT INTO orders(order_seq,customer_seq,status,creation_source,created_by_admin_user_seq,payment_method_type,payment_due_at,pickup_requested_at) OVERRIDING SYSTEM VALUE VALUES($1,1,'COLLECTING','ADMIN',1,'billing','2094-01-01Z','2030-03-01Z')",[id]);
    for(let n=1;n<=2;n++)await order.query('INSERT INTO order_parcels(order_parcel_seq,order_seq,parcel_position,notified_price) OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,3500)',[id*10+n,id,n]);
    await order.query("UPDATE orders SET status='notPaid',total_amount=7000 WHERE order_seq=$1",[id]);
    await order.query("INSERT INTO order_payment_requests(order_seq,amount,expires_at) VALUES($1,7000,'2094-01-01Z')",[id]);
    return id;
  };
  async function auditRows(requestId) {return (await ops.query('SELECT * FROM audit_logs WHERE request_id=$1',[requestId])).rows;}
  async function cancelled(id) {
    const saved=(await order.query('SELECT status,total_amount FROM orders WHERE order_seq=$1',[id])).rows[0];
    const parcels=(await order.query('SELECT status FROM order_parcels WHERE order_seq=$1 ORDER BY parcel_position',[id])).rows;
    if(parcels[0].status==='CANCELLED') { assert.deepEqual(parcels,[{status:'CANCELLED'},{status:'ACTIVE'}]);assert.deepEqual(saved,{status:'notPaid',total_amount:3500});return true; }
    assert.deepEqual(saved,{status:'notPaid',total_amount:7000});return false;
  }
  const credentials={Authorization:'Bearer '+process.env.CUSTOMER_AUTH_TOKEN,'Content-Type':'application/json'};
  async function event(value,token=process.env.CUSTOMER_AUTH_TOKEN) {
    const r=await fetch('http://operations-app:3005/internal/events',{method:'POST',headers:{...credentials,Authorization:'Bearer '+token},body:JSON.stringify(value)});
    return {status:r.status,body:await r.json()};
  }
  async function flush(transactionId) {
    const r=await fetch('http://order-app:3002/internal/audit/flush',{method:'POST',headers:credentials,body:JSON.stringify({eventId:randomUUID(),source:'operations',eventType:'AuditFlushRequested',payload:{transactionIds:[transactionId]}})});
    assert.equal(r.status,200,await r.text());
  }
  async function start(mode,id,requestId) {
    const child=fork(require.resolve('./order-cancellation-claimant.cjs'),[],{env:{...process.env,ORDER_CANCELLATION_CRASH:JSON.stringify({mode,id,requestId})},stdio:['ignore','pipe','pipe','ipc']});
    children.push(child);
    const [ready]=await once(child,'message',{signal:AbortSignal.timeout(15000)});
    assert.equal(ready.phase,'prepared');
    const preparation=(await ops.query("SELECT event_id,transaction_id FROM order_audit_preparations WHERE audit->>'request_id'=$1",[requestId])).rows[0];
    assert.ok(preparation);return {child,...preparation};
  }

  await t.test('a prepared live producer stays pending, SIGKILL rolls back partial cancellation and operations automatically aborts it',async()=> {
    const id=await seed(),requestId=randomUUID(),before=(await order.query(`SELECT to_jsonb(o) AS header,(SELECT jsonb_agg(to_jsonb(p) ORDER BY order_parcel_seq) FROM order_parcels p WHERE p.order_seq=o.order_seq) AS parcels,(SELECT jsonb_agg(to_jsonb(r) ORDER BY payment_request_id) FROM order_payment_requests r WHERE r.order_seq=o.order_seq) AS requests FROM orders o WHERE order_seq=$1`,[id])).rows;
    const producer=await start('prepared',id,requestId);
    await flush(producer.transaction_id);
    assert.equal((await ops.query('SELECT 1 FROM order_audit_preparations WHERE event_id=$1 AND NOT aborted',[producer.event_id])).rowCount,1);
    assert.deepEqual(await auditRows(requestId),[]);
    const exit=once(producer.child,'exit');producer.child.kill('SIGKILL');await exit;
    await until(async()=> (await ops.query('SELECT 1 FROM order_audit_preparations WHERE event_id=$1 AND aborted AND audit IS NULL',[producer.event_id])).rowCount===1,'automatic orphan abort');
    assert.deepEqual((await order.query(`SELECT to_jsonb(o) AS header,(SELECT jsonb_agg(to_jsonb(p) ORDER BY order_parcel_seq) FROM order_parcels p WHERE p.order_seq=o.order_seq) AS parcels,(SELECT jsonb_agg(to_jsonb(r) ORDER BY payment_request_id) FROM order_payment_requests r WHERE r.order_seq=o.order_seq) AS requests FROM orders o WHERE order_seq=$1`,[id])).rows,before);
    assert.deepEqual(await auditRows(requestId),[]);
    const response=await fetch('http://order-app:3002/api/orders/'+id+'/parcels/cancel',{method:'POST',headers:{Origin:'http://localhost:5173',Cookie:'dva_session='+'a'.repeat(64),'X-Request-Id':requestId,'Content-Type':'application/json'},body:JSON.stringify({orderParcelSeqs:[id*10+1]})});
    assert.equal(response.status,204);assert.equal((await auditRows(requestId)).length,2);
  });

  await t.test('SIGKILL after business COMMIT preserves all success audits through retry and duplicate acknowledgement',async()=> {
    const id=await seed(),requestId=randomUUID(),producer=await start('committed',id,requestId);
    const gate=await ops.connect();
    try {
      await gate.query('BEGIN');await gate.query('SELECT 1 FROM order_audit_preparations WHERE event_id=$1 FOR UPDATE',[producer.event_id]);
      const next=once(producer.child,'message');producer.child.send({continue:true});const [message]=await next;assert.equal(message.phase,'committed');
      assert.ok(await cancelled(id));assert.deepEqual(await auditRows(requestId),[]);
      const exit=once(producer.child,'exit');producer.child.kill('SIGKILL');await exit;
    } finally {await gate.query('ROLLBACK');gate.release();}
    await until(async()=> (await auditRows(requestId)).length===2,'committed audit relay recovery');
    await flush(producer.transaction_id);
    const saved=(await order.query("SELECT event_id,event_type,payload FROM outbox_events WHERE event_type='AuditCommitted' AND payload->>'transactionId'=$1",[producer.transaction_id])).rows;
    assert.equal(saved.length,1);
    const envelope={eventId:saved[0].event_id,source:'order',eventType:saved[0].event_type,payload:saved[0].payload};
    for(let n=0;n<2;n++){const ack=await event(envelope);assert.equal(ack.status,200);assert.deepEqual(ack.body,{eventId:envelope.eventId,status:'duplicate'});}
    assert.equal((await auditRows(requestId)).length,2);
    assert.equal((await order.query("SELECT 1 FROM outbox_events WHERE event_type='AuditAborted' AND payload->>'transactionId'=$1",[producer.transaction_id])).rowCount,0,'never abort a committed outcome');
  });

  await t.test('lost prepare and committed ACKs preserve rollback or one committed audit group respectively',async()=> {
    for(const boundary of ['AuditPrepared','AuditCommitted']) {
      let dropped=false;
      const server=createServer(async(request,response)=> {
        const chunks=[];for await(const chunk of request)chunks.push(chunk);
        const body=Buffer.concat(chunks),input=JSON.parse(body);
        try {
          const upstream=await fetch('http://operations-app:3005/internal/events',{method:'POST',headers:credentials,body});
          const reply=await upstream.text();
          if(input.eventType===boundary&&!dropped){dropped=true;request.socket.destroy();return;}
          response.writeHead(upstream.status,{'Content-Type':'application/json'}).end(reply);
        } catch {response.writeHead(503).end('{}');}
      });
      await new Promise(resolve=>server.listen(0,'0.0.0.0',resolve));
      const values={DB_HOST:'order-db',DB_PORT:5432,DB_USER:'order_app',DB_PASSWORD:process.env.PGPASSWORD,DB_NAME:'dva_webhook_test',
        OPERATIONS_URL:'http://127.0.0.1:'+server.address().port,DELIVERY_URL:'http://delivery-app:3003',CONSULTATION_URL:'http://consultation-app:3004',CUSTOMER_AUTH_TOKEN:process.env.CUSTOMER_AUTH_TOKEN};
      const config={get:key=>values[key]},database=new DatabaseService(config),audit=new AuditService(database,config);
      if(boundary==='AuditCommitted') {
        const before=audit.beforeCommit.bind(audit);
        audit.beforeCommit=async client=> {
          const confirm=await before(client);
          const message=(await client.query("UPDATE outbox_events SET next_attempt_at=clock_timestamp()+interval '2 seconds' WHERE destination='operations' AND delivered_at IS NULL RETURNING event_id,event_type,payload")).rows.at(-1);
          return async()=> {
            await assert.rejects(sendEvent(values.OPERATIONS_URL+'/internal/events',process.env.CUSTOMER_AUTH_TOKEN,
              {eventId:message.event_id,source:'order',eventType:message.event_type,payload:message.payload}));
            assert.equal((await order.query('SELECT 1 FROM outbox_events WHERE event_id=$1 AND delivered_at IS NULL',[message.event_id])).rowCount,1,'lost ACK remains pending');
            await confirm?.();
          };
        };
      }
      const id=await seed(),requestId=randomUUID();
      const service=new OrdersService(database,new OrdersRepository(),config,audit,new OrderDeletionCheckClient(config),new OrderShipmentCheckClient(config));
      try {
        if(boundary==='AuditPrepared') {
          await assert.rejects(service.cancel(1,id,requestId,undefined,[id*10+1]));await audit.flush();
          assert.equal(await cancelled(id),false);assert.deepEqual(await auditRows(requestId),[]);
          await until(async()=> (await ops.query("SELECT 1 FROM order_audit_preparations WHERE audit->>'request_id'=$1 AND NOT aborted",[requestId])).rowCount===0,'lost prepare abort');
        }else {
          await service.cancel(1,id,requestId,undefined,[id*10+1]);assert.ok(await cancelled(id));assert.equal((await auditRows(requestId)).length,2);
        }
        assert.equal(dropped,true,'fault was actually injected');
      } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await database.onModuleDestroy();}
    }
  });

  await t.test('a lost final callback ACK preserves committed money and retries the same selected parcels without another audit',async()=> {
    const id=await seed(),requestId=randomUUID();let dropped=false;
    const server=createServer(async(request,response)=>{
      const chunks=[];for await(const chunk of request)chunks.push(chunk);
      try{
        const upstream=await fetch('http://order-app:3002/internal/order-cancellation',{method:'POST',headers:credentials,body:Buffer.concat(chunks)});
        const body=await upstream.text();
        if(upstream.status===200&&!dropped){dropped=true;request.socket.destroy();return;}
        response.writeHead(upstream.status,{'Content-Type':'application/json'}).end(body);
      }catch{response.writeHead(503).end('{}');}
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const url='http://127.0.0.1:'+server.address().port+'/internal/order-cancellation';
    const input={eventId:randomUUID(),source:'customer',eventType:'OrderCancellationRequested',payload:{command:{id,callSessionSeq:1011,requestId,orderParcelSeqs:[id*10+1]},customerSeq:1}};
    try{
      await assert.rejects(requestOrderCancellation(url,process.env.CUSTOMER_AUTH_TOKEN,input));assert.equal(dropped,true);
      assert.equal(await cancelled(id),true);assert.equal((await auditRows(requestId)).length,2);
      const before=(await order.query('SELECT * FROM order_payment_requests WHERE order_seq=$1 ORDER BY payment_request_id',[id])).rows;
      assert.equal(before.length,2);assert.equal(before.filter(row=>row.invalidated_at===null).length,1);
      assert.equal(await requestOrderCancellation(url,process.env.CUSTOMER_AUTH_TOKEN,input),null);
      assert.deepEqual((await order.query('SELECT * FROM order_payment_requests WHERE order_seq=$1 ORDER BY payment_request_id',[id])).rows,before);
      assert.equal((await auditRows(requestId)).length,2);
    }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  });

  await t.test('money audit metadata and parcel target forgery are rejected before inserting',async()=> {
    const base={eventId:randomUUID(),source:'order',eventType:'AuditPrepared',payload:{transactionId:randomUUID(),audit:{actorId:1,actorType:'ADMIN',action:'ORDER_AMOUNT_CHANGED',metadata:{amountBefore:7000,amountAfter:3500,orderParcelSeqs:[1]},targetType:'ORDER',targetId:1,requestId:randomUUID()},result:'SUCCESS',occurredAt:new Date().toISOString()}};
    const before=(await ops.query('SELECT count(*)::int AS n FROM audit_logs')).rows[0].n;
    assert.equal((await event(base,'wrong')).status,403);
    const foreign=await event(base,process.env.CONSULTATION_AUTH_TOKEN);
    assert.equal(foreign.status,401);
    assert.deepEqual(foreign.body,{error:'EVENT_UNAUTHORIZED'});
    for(const mutate of [v=>v.payload.audit.action='CUSTOMER_CREATED',v=>v.payload.audit.targetType='CUSTOMER',v=>v.payload.audit.metadata={amountBefore:-1,amountAfter:3500,orderParcelSeqs:[1]},v=>v.payload.audit.metadata={amountBefore:7000,amountAfter:'3500',orderParcelSeqs:[1]},v=>v.payload.audit.metadata={amountBefore:7000,amountAfter:3500,orderParcelSeqs:[1,1]},v=>v.payload.audit.metadata={private:'unexpected'}]) {
      const value=structuredClone(base);value.eventId=randomUUID();mutate(value);assert.equal((await event(value)).status,422);
    }
    assert.equal((await ops.query('SELECT count(*)::int AS n FROM audit_logs')).rows[0].n,before);
  });
});
