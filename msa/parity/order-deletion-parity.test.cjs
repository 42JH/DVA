require('reflect-metadata');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {Pool}=require('pg');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const origin='http://localhost:5173';
const cookie='dva_session='+'a'.repeat(64);
const tables=['orders','order_parcels','order_payment_requests','order_billing_charges','organization_billing_months','empty_ai_order_results'];

test('order DELETE preserves source HTTP, business rows, audit and owner boundaries',async t=> {
  assert.equal(process.env.PGDATABASE,'dva_webhook_test');
  const pools=Object.fromEntries(['monolith','order','consultation','operations','customer'].map(name=>[name,new Pool({host:name+'-db',user:name+'_app'})]));
  const retained=[];
  t.after(async()=>{for(const lock of retained){await lock.query('ROLLBACK');lock.release();}await Promise.all(Object.values(pools).map(p=>p.end()));});
  const sides=[{name:'monolith',url:'http://monolith-app:3000',db:pools.monolith,audit:pools.monolith,calls:pools.monolith},
    {name:'msa',url:'http://order-app:3002',db:pools.order,audit:pools.operations,calls:pools.consultation}];
  // The preceding read-only differential finishes with a deliberately MSA-only concurrency edit.
  // Start this independent suite from equal stored rows, rather than filtering that difference away.
  for(const side of sides) {
    await side.calls.query('TRUNCATE call_sessions RESTART IDENTITY CASCADE');
    await side.db.query('TRUNCATE '+tables.join(',')+(side.name==='monolith'?',shipments':'')+' RESTART IDENTITY CASCADE');
    await side.audit.query('TRUNCATE audit_logs RESTART IDENTITY CASCADE');
    await side.db.query("INSERT INTO orders(order_seq,customer_seq,status,version,created_at,updated_at) OVERRIDING SYSTEM VALUE VALUES(1001,1,'COLLECTING',23,'2030-01-01Z','2030-01-01Z')");
    await side.calls.query("INSERT INTO call_sessions(call_session_seq,provider_call_id,caller_phone_number,incoming_at,registered_at) OVERRIDING SYSTEM VALUE VALUES(1011,'deletion-access-call','01000000001','2030-01-01Z','2030-01-01Z')");
  }
  let next=3000,compared=0;
  const fixtures=[];
  async function seed({status='COLLECTING',call,notification,completion='WAITING',approval=false,completed=false,invalid=false,expired=false,deleted=false,closedExpired=false,history=false}={}) {
    const id=++next,paymentId=randomUUID();
    for(const side of sides) {
      const c=await side.db.connect();
      try {
        await c.query('BEGIN');
        // Identical valid stored snapshots, while the DELETE itself runs with every guard enabled.
        await c.query("SET LOCAL session_replication_role='replica'");
        await c.query(`INSERT INTO orders(order_seq,customer_seq,status,payment_method_type,version,total_amount,
          created_at,updated_at,closed_at,deleted_at,payment_due_at,creation_source,created_by_admin_user_seq,
          parcel_no,dver_received_at,pickup_requested_at,submission_first_attempt_at,submission_last_attempt_at)
          OVERRIDING SYSTEM VALUE VALUES($1,1,$2,$3,27,7000,$4,'2030-01-01Z',$5,$6,'2094-01-01Z','ADMIN',1,$7,$8,'2030-02-01Z','2094-01-01Z','2094-01-01Z')`,
          [id,status,status==='COLLECTING'?null:'billing',expired?'2000-01-01Z':'2030-01-01Z',
            closedExpired?'2000-01-01Z':['ACCEPTED','CANCELLED'].includes(status)?'2030-02-01Z':null,
            deleted?'2030-03-01Z':null,status==='ACCEPTED'?'DELE0001':null,status==='ACCEPTED'?'2030-02-01Z':null]);
        if(history) {
          await c.query("UPDATE orders SET payment_method_type='credit',billing_organization_seq=991,billing_organization_name='삭제 전 청구기업',paid_at='2030-01-15Z' WHERE order_seq=$1",[id]);
          await c.query("INSERT INTO organization_billing_months(organization_seq,billing_month,monthly_amount,organization_name) VALUES(991,'2030-01-01',7000,'삭제 전 청구기업')");
          await c.query("INSERT INTO order_billing_charges(order_seq,organization_seq,billing_month,payment_method_type,amount,occurred_at) VALUES($1,991,'2030-01-01','credit',7000,'2030-01-15Z')",[id]);
        }
        await c.query(`INSERT INTO order_parcels(order_parcel_seq,order_seq,parcel_position,status,origin_name,destination_name,small_box_count,item_price,notified_price,
          origin_phone_number,origin_road_address,origin_jibun_address,origin_dong_name,origin_postal_code,
          destination_phone_number,destination_road_address,destination_jibun_address,destination_dong_name,destination_postal_code)
          OVERRIDING SYSTEM VALUE VALUES($1,$2,1,$3,'보존 출발 스냅샷','보존 수령인',1,7000,7000,
            '01000000001','출발 도로','출발 지번','출발동','01234','01099999999','도착 도로','도착 지번','도착동','05678')`,[id*10,id,status==='CANCELLED'?'CANCELLED':'ACTIVE']);
        if(notification) await c.query(`INSERT INTO order_payment_requests(payment_request_id,order_seq,amount,created_at,expires_at,
          notification_status,completion_notification_status,notification_attempted_at,completion_notification_attempted_at,
          approval_started_at,invalidated_at,completed_at,provider_reference,approval_next_check_at)
          VALUES($1,$2,7000,'2020-01-01Z','2094-01-01Z',$3,$4,'2094-01-01Z','2094-01-01Z',$5,$6,$7,$8,'2094-01-01Z')`,
          [paymentId,id,notification,completion,approval?'2030-01-01Z':null,invalid?'2030-01-02Z':null,
            completed?'2030-01-03Z':null,completed?'delete-reference-'+id:null]);
        await c.query('COMMIT');
      } catch(error) {await c.query('ROLLBACK');throw error;} finally {c.release();}
      if(call) await side.calls.query(`INSERT INTO call_sessions(call_session_seq,provider_call_id,order_seq,incoming_at,registered_at,started_at,ended_at,deleted_at)
        OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4,'2030-01-01Z',$5,$6,$7)`,
        [id,'delete-call-'+id,id,call==='old-live'?'2000-01-01Z':'2030-01-01Z',call==='ended'?'2030-01-01Z':null,
          call==='ended'?'2030-01-02Z':null,call==='deleted'?'2030-01-03Z':null]);
    }
    fixtures.push(id);return id;
  }
  async function rows(db,table) {
    return (await db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows.map(x=>x.row);
  }
  async function business(db) {const value={};for(const table of tables)value[table]=await rows(db,table);return value;}
  async function request(side,id,headers,requestId) {
    const response=await fetch(side.url+'/api/orders/'+id,{method:'DELETE',headers:{...headers,'X-Request-Id':requestId},signal:AbortSignal.timeout(25000)});
    const text=await response.text();
    assert.equal(response.headers.get('x-request-id'),requestId);
    return {status:response.status,body:text?JSON.parse(text):null,cache:response.headers.get('cache-control')};
  }
  function within(value,start,end,label) {
    assert.ok(Number.isFinite(Date.parse(value))&&Date.parse(value)>=start-1000&&Date.parse(value)<=end+1000,label+': '+value);
  }
  async function audits(requestId,start,end) {
    const result=[];
    for(const side of sides) {
      const values=(await side.audit.query('SELECT * FROM audit_logs WHERE request_id=$1 ORDER BY audit_log_seq',[requestId])).rows;
      for(const row of values) {
        within(row.occurred_at,start,end,side.name+' audit time');
        assert.equal(row.action,'ORDER_DELETED');assert.equal(row.target_type,'ORDER');
        assert.ok(Number.isInteger(row.audit_log_seq)&&row.audit_log_seq>0);
        delete row.audit_log_seq;delete row.occurred_at;
      }
      result.push(values);
    }
    assert.deepEqual(result[1],result[0],'same audit actor/name/target/result/metadata');
    return result[0];
  }
  async function compare(id,expected,headers={Origin:origin,Cookie:cookie}) {
    const before=await Promise.all(sides.map(side=>business(side.db)));
    const beforeCalls=await Promise.all(sides.map(side=>rows(side.calls,'call_sessions')));
    const requestId=randomUUID(),start=Date.now();
    const result=[];for(const side of sides)result.push(await request(side,id,headers,requestId));
    const end=Date.now();
    for(let i=0;i<2;i++)assert.equal(result[i].status,expected,sides[i].name+' delete '+id+' '+JSON.stringify(result[i]));
    assert.deepEqual(result[1],result[0],'same delete response');compared++;
    const audit=await audits(requestId,start,end);
    const after=await Promise.all(sides.map(side=>business(side.db)));
    for(let i=0;i<sides.length;i++)assert.deepEqual(await rows(sides[i].calls,'call_sessions'),beforeCalls[i],'every stored call field remains unchanged');
    for(let i=0;i<2;i++) {
      if(expected!==204)assert.deepEqual(after[i],before[i],'failed delete must roll back every order-owned row');
      else {
        const old=before[i].orders.find(o=>o.order_seq===id),row=after[i].orders.find(o=>o.order_seq===id);
        within(row.deleted_at,start,end,'deleted_at');
        const changed={...row,deleted_at:old.deleted_at};
        if(changed.updated_at!==old.updated_at) {within(changed.updated_at,start,end,'updated_at');changed.updated_at=old.updated_at;}
        assert.deepEqual(changed,old,'only source deletion/touch fields may change');
        for(const table of tables.filter(name=>!['orders','order_payment_requests'].includes(name)))
          assert.deepEqual(after[i][table],before[i][table],'preserve '+table);
        for(const payment of after[i].order_payment_requests) {
          const oldPayment=before[i].order_payment_requests.find(p=>p.payment_request_id===payment.payment_request_id);
          assert.deepEqual(payment,payment.order_seq===id?{...oldPayment,
            notification_status:oldPayment.notification_status==='PENDING'?'FAILED':oldPayment.notification_status,
            completion_notification_status:['WAITING','PENDING'].includes(oldPayment.completion_notification_status)?'FAILED':oldPayment.completion_notification_status}:oldPayment);
        }
        assert.equal(audit.length,1);assert.equal(audit[0].result,'SUCCESS');
      }
    }
    for(const table of tables) {
      const normalize=list=>list.map(row=> {
        if(table!=='orders')return row;
        return {...row,deleted_at:row.deleted_at===null?null:'deleted',updated_at:fixtures.includes(row.order_seq)&&Date.parse(row.updated_at)!==Date.parse('2030-01-01Z')?'touched':row.updated_at};
      }).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
      assert.deepEqual(normalize(after[1][table]),normalize(after[0][table]),'source-equivalent stored '+table);
    }
    return {audit,requestId,response:result[0]};
  }
  assert.deepEqual(await business(pools.order),await business(pools.monolith),'identical initial order-owned fixture');
  const preservedOwners={customer:await rows(pools.customer,'customers'),calls:await rows(pools.consultation,'call_sessions')};

  await t.test('the source DELETE OpenAPI operation and referenced schemas match',async()=> {
    const docs=await Promise.all(sides.map(async side=>(await fetch(side.url+'/api/docs-json')).json()));
    const seen=new Set();
    function visit(value) {
      if(!value||typeof value!=='object')return;
      if(value.$ref?.startsWith('#/components/schemas/')) {
        const name=value.$ref.split('/').at(-1);
        if(!seen.has(name)) {seen.add(name);assert.deepEqual(docs[1].components.schemas[name],docs[0].components.schemas[name],name);visit(docs[0].components.schemas[name]);}
      }
      Object.values(value).forEach(visit);
    }
    const source=docs[0].paths['/api/orders/{id}'].delete;
    assert.deepEqual(docs[1].paths['/api/orders/{id}'].delete,source);visit(source);
    assert.ok(Object.keys(docs[1].paths).every(path=>!path.includes('internal')));
  });

  await t.test('administrator session, roles, Origin and ID errors keep failure/denied audits',async()=> {
    const id=await seed();
    for(const headers of [{Origin:origin},{Origin:origin,Authorization:'Bearer '+process.env.CUSTOMER_AUTH_TOKEN,call_session_seq:'1011'},
      {Origin:origin,Cookie:'dva_session=invalid'},{Origin:origin,Cookie:cookie+'; '+cookie}])await compare(id,401,headers);
    await compare(id,403,{Cookie:cookie});
    await compare(id,403,{Cookie:cookie,Origin:'https://untrusted.invalid'});
    for(const value of ['0','-1','1.5','2147483648','abc'])await compare(value,400);
    await compare(2147483647,404);
    for(const [n,role] of ['OPERATOR','SUPERVISOR','SYSTEM_ADMIN'].entries()) {
      const row=await seed();
      const result=await compare(row,204,{Origin:origin,Cookie:'dva_session='+['a','b','c'][n].repeat(64)});
      assert.equal(result.audit[0].actor_seq,n+1,role);
    }
  });

  await t.test('all order states, deletion, retention and active call predicates match',async()=> {
    for(const status of ['COLLECTING','CANCELLED','ACCEPTED','notPaid','PAID','SUBMITTING','SUBMITTING_FAILED','SUBMISSION_FAILED'])
      await compare(await seed({status}),['COLLECTING','CANCELLED','ACCEPTED'].includes(status)?204:409);
    await compare(await seed({deleted:true}),404);
    // Keep expired fixture locks until this suite ends, so later full snapshots cannot race a real purger.
    for(const options of [{expired:true},{status:'ACCEPTED',closedExpired:true},{status:'CANCELLED',closedExpired:true}]) {
      const id=await seed(options);
      for(const side of sides) {const lock=await side.db.connect();retained.push(lock);await lock.query('BEGIN');await lock.query('SELECT 1 FROM orders WHERE order_seq=$1 FOR KEY SHARE',[id]);}
      await compare(id,404);
    }
    for(const call of ['live','old-live','ended','deleted']) {
      const id=await seed({call});
      if(call==='old-live')for(const side of sides) {const lock=await side.calls.connect();retained.push(lock);await lock.query('BEGIN');await lock.query('SELECT 1 FROM call_sessions WHERE call_session_seq=$1 FOR KEY SHARE',[id]);}
      await compare(id,['live','old-live'].includes(call)?409:204);
    }
  });

  await t.test('every payment notification pair and completed/invalid approval branch preserves payment fields',async()=> {
    for(const notification of ['PENDING','SENDING','SENT','FAILED','UNKNOWN'])
      for(const completion of ['WAITING','PENDING','SENDING','SENT','FAILED','UNKNOWN'])
        await compare(await seed({notification,completion}),notification==='SENDING'||completion==='SENDING'?409:204);
    await compare(await seed({notification:'SENT',completion:'SENT',approval:true}),409);
    await compare(await seed({notification:'SENT',completion:'SENT',approval:true,completed:true}),204);
    await compare(await seed({notification:'SENT',completion:'SENT',approval:true,invalid:true}),204);
  });

  await t.test('deleted orders disappear from reads and a repeated DELETE has one success audit',async()=> {
    const id=await seed({status:'ACCEPTED',history:true});
    for(const side of sides) {
      const response=await fetch(side.url+'/api/customers/1/addresses?direction=ORIGIN&limit=100',{headers:{Cookie:cookie}});
      assert.equal(response.status,200);assert.ok((await response.json()).data.some(row=>row.orderSeq===id),'address history existed before deletion');
    }
    await compare(id,204);await compare(id,404);
    for(const side of sides) {
      const detail=await fetch(side.url+'/api/orders/'+id,{headers:{Cookie:cookie}});assert.equal(detail.status,404);
      for(const path of ['/api/orders?limit=100','/api/admin/orders?limit=100','/api/customers/1/addresses?direction=ORIGIN&limit=100']) {
        const response=await fetch(side.url+path,{headers:{Cookie:cookie}});assert.equal(response.status,200);
        assert.ok((await response.json()).data.every(row=>row.orderSeq!==id));
      }
      assert.equal((await side.audit.query("SELECT 1 FROM audit_logs WHERE target_type='ORDER' AND target_seq=$1 AND result='SUCCESS'",[id])).rowCount,1);
    }
  });

  await t.test('concurrent deletes serialize and a two-second row lock timeout keeps REQUEST_IN_PROGRESS',async()=> {
    const id=await seed();
    const start=Date.now(),ids=[randomUUID(),randomUUID()];
    const outputs=[];
    for(const side of sides) {
      const values=await Promise.all(ids.map(requestId=>request(side,id,{Origin:origin,Cookie:cookie},requestId)));
      assert.deepEqual(values.map(v=>v.status).sort(),[204,404]);outputs.push(values.map(v=>v.status).sort());
    }
    assert.deepEqual(outputs[1],outputs[0]);
    for(const side of sides) {
      const audit=(await side.audit.query("SELECT result FROM audit_logs WHERE target_seq=$1 AND action='ORDER_DELETED' ORDER BY result",[id])).rows;
      assert.deepEqual(audit,[{result:'FAILED'},{result:'SUCCESS'}]);
      within((await side.db.query('SELECT deleted_at FROM orders WHERE order_seq=$1',[id])).rows[0].deleted_at,start,Date.now(),'concurrent deleted_at');
    }
    const locked=await seed(),locks=[];
    try {
      for(const side of sides){const c=await side.db.connect();await c.query('BEGIN');await c.query('SELECT 1 FROM orders WHERE order_seq=$1 FOR UPDATE',[locked]);locks.push(c);}
      const result=await compare(locked,409);
      assert.equal(result.audit[0].result,'FAILED');
      assert.equal(result.response.body.error.code,'REQUEST_IN_PROGRESS');
    } finally {for(const c of locks){await c.query('ROLLBACK');c.release();}}
  });

  await t.test('a success audit SQL failure rolls back order and payment changes before failure audit',async()=> {
    const id=await seed({notification:'PENDING'});
    for(const side of sides)await side.audit.query(`CREATE FUNCTION reject_order_delete_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='ORDER_DELETED' AND NEW.result='SUCCESS' THEN RAISE EXCEPTION 'fixture-audit-storage-failure'; END IF;
      RETURN NEW; END $$; CREATE TRIGGER reject_order_delete_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_order_delete_audit();`);
    try {const result=await compare(id,500);assert.equal(result.audit[0].result,'FAILED');}
    finally {for(const side of sides)await side.audit.query('DROP TRIGGER reject_order_delete_audit ON audit_logs; DROP FUNCTION reject_order_delete_audit();');}
    await compare(id,204);
  });

  await t.test('private deletion checks authenticate, reject forged commands, reread same event and never persist a response',async()=> {
    const url='http://consultation-app:3004/internal/order-deletion-check';
    const event={eventId:randomUUID(),source:'order',eventType:'OrderDeletionCheckRequested',payload:{orderSeq:1001}};
    const before=await rows(pools.consultation,'inbox_events');
    async function send(value,token=process.env.CUSTOMER_AUTH_TOKEN) {
      const response=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(value)});
      return {status:response.status,body:await response.json()};
    }
    assert.equal((await send(event,'wrong')).status,403);
    for(const bad of [{...event,source:'consultation'},{...event,eventType:'OrderDeleted'},
      {...event,payload:{orderSeq:'1001'}},{...event,payload:{orderSeq:0}},{...event,payload:{orderSeq:2147483648}},
      {...event,payload:{orderSeq:1001,customerSeq:1}}])assert.equal((await send(bad)).status,422);
    const value=await send(event);assert.equal(value.status,200);assert.deepEqual(value.body,{eventId:event.eventId,status:'processed',payload:{blocked:false}});
    await pools.consultation.query("INSERT INTO call_sessions(provider_call_id,order_seq,incoming_at) VALUES('delete-query-reread',1001,'2030-01-01Z')");
    assert.equal((await send(event)).body.payload.blocked,true);
    await pools.consultation.query("DELETE FROM call_sessions WHERE provider_call_id='delete-query-reread'");
    assert.equal((await send(event)).body.payload.blocked,false);
    assert.deepEqual(await rows(pools.consultation,'inbox_events'),before);
  });

  assert.deepEqual(await rows(pools.customer,'customers'),preservedOwners.customer,'delete must not mutate customer-owned data');
  const originalIds=new Set(preservedOwners.calls.map(row=>row.call_session_seq));
  assert.deepEqual((await rows(pools.consultation,'call_sessions')).filter(row=>originalIds.has(row.call_session_seq)),preservedOwners.calls,'delete must preserve original call-owned rows');
  await pause(300);
  assert.equal((await pools.operations.query('SELECT 1 FROM order_audit_preparations WHERE NOT aborted')).rowCount,0);
  assert.equal((await pools.order.query("SELECT 1 FROM outbox_events WHERE destination='operations' AND delivered_at IS NULL")).rowCount,0);
  console.log('ORDER DELETE HTTP PAIRS: '+compared+'; full order/payment rows and audit fields compared after each request');
});
