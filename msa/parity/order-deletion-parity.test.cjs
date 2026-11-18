const { truncateFixture } = require('./fixture-reset.cjs');
require('reflect-metadata');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {Pool}=require('pg');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const origin='http://localhost:5173';
const cookie='dva_session='+'a'.repeat(64);
const tables=['order_parcel_drafts','orders','order_parcels','order_payment_requests','order_billing_charges','organization_billing_months','empty_ai_order_results'];

test('order DELETE preserves source HTTP, business rows, audit and owner boundaries',async t=> {
  assert.equal(process.env.PGDATABASE,'dva_webhook_test');
  const pools=Object.fromEntries(['monolith','order','consultation','operations','customer'].map(name=>[name,new Pool({host:name+'-db',user:name+'_app'})]));
  const retained=[];
  t.after(async()=>{for(const lock of retained){await lock.query('ROLLBACK');lock.release();}await Promise.all(Object.values(pools).map(p=>p.end()));});
  const sides=[{name:'monolith',url:'http://monolith-app:3000',db:pools.monolith,audit:pools.monolith,calls:pools.monolith},
    {name:'msa',url:'http://order-app:3002',db:pools.order,audit:pools.operations,calls:pools.consultation}];
  // The preceding differential includes a deliberately MSA-only concurrency edit.
  // Start this independent suite from equal stored rows, rather than filtering that difference away.
  // Creation fixtures also leave active companies that the production billing worker can initialize.
  for (const pool of [pools.monolith, pools.customer]) {
    await truncateFixture(pool, 'TRUNCATE memberships,departments,organizations RESTART IDENTITY CASCADE');
  }
  for(const side of sides) {
    await truncateFixture(side.calls, 'TRUNCATE call_sessions RESTART IDENTITY CASCADE');
    await truncateFixture(side.db, 'TRUNCATE '+tables.join(',')+(side.name==='monolith'?',shipments':'')+' RESTART IDENTITY CASCADE');
    await truncateFixture(side.audit, 'TRUNCATE audit_logs RESTART IDENTITY CASCADE');
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
          approval_started_at,invalidated_at,completed_at,provider_reference,approval_next_check_at,card_payment_order_id)
          VALUES($1,$2,7000,'2020-01-01Z','2094-01-01Z',$3,$4,'2094-01-01Z','2094-01-01Z',$5,$6,$7,$8,'2094-01-01Z',$1)`,
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
  async function request(side,id,headers,requestId,body={orderSeqs:Array.isArray(id)?id:[id]}) {
    const response=await fetch(side.url+'/api/orders',{method:'DELETE',headers:{...headers,'X-Request-Id':requestId,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(25000)});
    const text=await response.text();
    assert.equal(response.headers.get('x-request-id'),requestId);
    return {status:response.status,body:text?JSON.parse(text):null,cache:response.headers.get('cache-control')};
  }
  function within(value,start,end,label) {
    assert.ok(Number.isFinite(Date.parse(value))&&Date.parse(value)>=start-1000&&Date.parse(value)<=end+1000,label+': '+value);
  }
  async function audits(requestId,start,end,action='ORDER_DELETED',target='ORDER') {
    const result=[];
    for(const side of sides) {
      const values=(await side.audit.query('SELECT * FROM audit_logs WHERE request_id=$1 ORDER BY audit_log_seq',[requestId])).rows;
      for(const row of values) {
        within(row.occurred_at,start,end,side.name+' audit time');
        assert.equal(row.action,action);assert.equal(row.target_type,target);
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
    for(const path of ['/api/orders','/api/parcel-drafts']) {
      const source=docs[0].paths[path].delete;
      assert.deepEqual(docs[1].paths[path].delete,source,path);visit(source);
    }
    assert.ok(Object.keys(docs[1].paths).every(path=>!path.includes('internal')));
    for(const doc of docs)for(const path of ['/api/orders/{id}','/api/parcel-drafts/{id}'])assert.equal(doc.paths[path].delete,undefined);
  });

  await t.test('administrator session, roles, Origin and ID errors keep failure/denied audits',async()=> {
    const id=await seed();
    for(const headers of [{Origin:origin},{Origin:origin,Authorization:'Bearer '+process.env.CUSTOMER_AUTH_TOKEN,call_session_seq:'1011'},
      {Origin:origin,Cookie:'dva_session=invalid'},{Origin:origin,Cookie:cookie+'; '+cookie}])await compare(id,401,headers);
    await compare(id,403,{Cookie:cookie});
    await compare(id,403,{Cookie:cookie,Origin:'https://untrusted.invalid'});
    for(const value of ['0','-1','1.5','2147483648','abc'])await compare(value,400);
    await compare(2147483647,404);
    for(const [n,role] of ['OPERATOR','OPERATOR','SYSTEM_ADMIN'].entries()) {
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

  await t.test('order arrays validate strictly, roll every target back and share sorted success audits',async()=> {
    const ids=[await seed({notification:'PENDING'}),await seed({status:'CANCELLED'})];
    const blocked=await seed({status:'PAID'}),headers={Origin:origin,Cookie:cookie};
    async function attempt(selected,status,body) {
      const before=await Promise.all(sides.map(side=>business(side.db)));
      const requestId=randomUUID(),start=Date.now(),responses=[];
      for(const side of sides)responses.push(await request(side,selected,headers,requestId,body));
      for(const response of responses)assert.equal(response.status,status,JSON.stringify(response));
      assert.deepEqual(responses[1],responses[0]);
      const audit=await audits(requestId,start,Date.now());
      if(status!==204) {
        for(const [index,side] of sides.entries())assert.deepEqual(await business(side.db),before[index]);
        assert.ok(audit.every(row=>row.result==='FAILED'));
      } else {
        assert.deepEqual(audit.map(row=>row.target_seq),ids);
        assert.ok(audit.every(row=>row.result==='SUCCESS'));
        for(const [index,side] of sides.entries()) {
          const after=await business(side.db);
          for(const id of ids) {
            const old=before[index].orders.find(row=>row.order_seq===id),row=after.orders.find(row=>row.order_seq===id);
            within(row.deleted_at,start,Date.now(),'batch deleted_at');
            if(row.updated_at!==old.updated_at)within(row.updated_at,start,Date.now(),'batch updated_at');
            assert.deepEqual({...row,deleted_at:old.deleted_at,updated_at:old.updated_at},old);
          }
          for(const table of tables.filter(table=>!['orders','order_payment_requests'].includes(table)))
            assert.deepEqual(after[table],before[index][table]);
          for(const payment of after.order_payment_requests) {
            const old=before[index].order_payment_requests.find(row=>row.payment_request_id===payment.payment_request_id);
            assert.deepEqual(payment,ids.includes(payment.order_seq)?{...old,
              notification_status:old.notification_status==='PENDING'?'FAILED':old.notification_status,
              completion_notification_status:['WAITING','PENDING'].includes(old.completion_notification_status)?'FAILED':old.completion_notification_status}:old);
          }
        }
      }
    }
    for(const body of [{},{orderSeqs:[]},{orderSeqs:[ids[0],ids[0]]},{orderSeqs:['1']},
      {orderSeqs:[0]},{orderSeqs:[1.5]},{orderSeqs:[2147483648]},{orderSeqs:ids,extra:true}])
      await attempt(ids,400,body);
    await attempt([ids[0],2147483647],404);
    await attempt([blocked,ids[0]],409);
    for(const side of sides)await side.audit.query(`CREATE FUNCTION reject_second_order_delete_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='ORDER_DELETED' AND NEW.target_seq=${ids[1]} AND NEW.result='SUCCESS' THEN RAISE EXCEPTION 'private second order audit failure'; END IF;
      RETURN NEW; END $$; CREATE TRIGGER reject_second_order_delete_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_second_order_delete_audit()`);
    try {await attempt([...ids].reverse(),500);}
    finally {for(const side of sides)await side.audit.query('DROP TRIGGER reject_second_order_delete_audit ON audit_logs; DROP FUNCTION reject_second_order_delete_audit()');}
    await attempt([...ids].reverse(),204);
    for(const side of sides)assert.equal((await fetch(side.url+'/api/orders/'+ids[0],{
      method:'DELETE',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({orderSeqs:ids}),
    })).status,404);
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

  await t.test('parcel draft DELETE preserves source states, permissions, row locks, audits and snapshots',async()=>{
    let nextDraft=40000,draftPairs=0;
    const created=[],fixtureLocks=[],auth={Origin:origin,Cookie:cookie};
    async function seedDraft({status='READY',call=null,retention='2032-01-01Z',deleted=false,source=null}={}){
      const id=++nextDraft,uuid=randomUUID(),phone='010'+String(id).padStart(8,'0');created.push(id);
      for(const side of sides){
        if(call&&call!=='missing')await side.calls.query(
          `INSERT INTO call_sessions(call_session_seq,provider_call_id,caller_phone_number,incoming_at,registered_at,started_at,ended_at,deleted_at,
            order_intake_enabled,order_completion_received_at,order_completion_payload,order_finalized_at,order_finalization_result)
            OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4,'2032-01-01Z',CASE WHEN $5 THEN '2032-01-01Z'::timestamptz ELSE NULL END,
            CASE WHEN $5 THEN '2032-01-02Z'::timestamptz ELSE NULL END,$6,$7,
            CASE WHEN $8 THEN '2032-01-02Z'::timestamptz ELSE NULL END,CASE WHEN $8 THEN '{}'::jsonb ELSE NULL END,
            CASE WHEN $8 THEN '2032-01-03Z'::timestamptz ELSE NULL END,CASE WHEN $8 THEN '{}'::jsonb ELSE NULL END)`,
          [id,'draft-delete-'+id,phone,call==='no-incoming'?null:call==='expired'?'2000-01-01Z':'2032-01-01Z',
            ['ended','finalized'].includes(call),call==='deleted'?'2032-01-02Z':null,call!=='disabled',call==='finalized']);
        // Keep the independent retention worker from purging rows that the DELETE cannot lock.
        if(call==='expired'){
          const lock=await side.calls.connect();await lock.query('BEGIN');
          await lock.query('SELECT 1 FROM call_sessions WHERE call_session_seq=$1 FOR KEY SHARE',[id]);fixtureLocks.push(lock);
        }
        const party={name:'원문 그대로 보관',phoneNumber:'01012345678',roadAddress:'서울 도로',jibunAddress:'서울 지번',detailAddress:null,dongName:null,postalCode:'00123'};
        const parcel={origin:party,destination:party,originPin:null,documentCount:1,smallBoxCount:0,mediumBoxCount:0,bigBoxCount:0,itemPrice:10000,notifiedPrice:3500,clientComment:'<보존> & %_',otherItemDescription:'문서'};
        await side.db.query(`INSERT INTO order_parcel_drafts(draft_seq,reserved_order_seq,call_session_seq,caller_phone_number,created_by_admin_user_seq,client_parcel_id,
          creation_payload,parcel_data,status,version,source_draft_seq,order_seq,order_parcel_seq,created_at,updated_at,retention_started_at,deleted_at)
          OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4,$5,$6,'{"original":"보존"}',$7,$8,23,$9,$10,$11,'2032-01-01Z','2032-01-02Z',$12,$13)`,
          [id,300000+id,call?id:null,phone,call?null:1,uuid,parcel,status,source,status==='CONVERTED'?1001:null,status==='CONVERTED'?400000+id:null,retention,deleted?'2032-01-03Z':null]);
        if(['2000-01-01Z','2020-01-01Z'].includes(retention)){
          const lock=await side.db.connect();await lock.query('BEGIN');
          await lock.query('SELECT 1 FROM order_parcel_drafts WHERE draft_seq=$1 FOR KEY SHARE',[id]);fixtureLocks.push(lock);
        }
      }
      return id;
    }
    async function send(side,id,headers,requestId,input={draftSeqs:Array.isArray(id)?id:[id]}){
      const response=await fetch(side.url+'/api/parcel-drafts',{method:'DELETE',headers:{...headers,'X-Request-Id':requestId,'Content-Type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(25000)});
      const body=await response.text();assert.equal(response.headers.get('x-request-id'),requestId);
      return {status:response.status,body:body?JSON.parse(body):null,cache:response.headers.get('cache-control')};
    }
    async function compareDraft(id,expected,headers=auth){
      const before=await Promise.all(sides.map(side=>business(side.db)));
      const calls=await Promise.all(sides.map(side=>rows(side.calls,'call_sessions')));
      const requestId=randomUUID(),start=Date.now(),results=[];
      for(const side of sides)results.push(await send(side,id,headers,requestId));
      const end=Date.now();
      for(let i=0;i<2;i++)assert.equal(results[i].status,expected,sides[i].name+' draft '+id+' '+JSON.stringify(results[i]));
      assert.deepEqual(results[1],results[0]);draftPairs++;
      const audit=await audits(requestId,start,end,'PARCEL_DRAFT_DELETED','ORDER_PARCEL_DRAFT');
      for(let i=0;i<2;i++){
        const after=await business(sides[i].db);
        assert.deepEqual(await rows(sides[i].calls,'call_sessions'),calls[i],'draft deletion never changes calls');
        for(const table of tables.filter(table=>table!=='order_parcel_drafts'))assert.deepEqual(after[table],before[i][table],'preserve '+table);
        const draft=after.order_parcel_drafts.find(row=>row.draft_seq===id);
        if(expected===204){
          const old=before[i].order_parcel_drafts.find(row=>row.draft_seq===id);
          within(draft.deleted_at,start,end,'draft deleted_at');within(draft.updated_at,start,end,'draft updated_at');
          assert.deepEqual(draft,{...old,deleted_at:draft.deleted_at,updated_at:draft.updated_at,version:old.version+1});
          assert.deepEqual(after.order_parcel_drafts.filter(row=>row.draft_seq!==id),before[i].order_parcel_drafts.filter(row=>row.draft_seq!==id),'parent, resumed child and every other draft unchanged');
          const hidden=await fetch(sides[i].url+'/api/parcel-drafts/'+id,{headers:{Cookie:cookie}});assert.equal(hidden.status,404);
          assert.equal(audit.length,1);assert.equal(audit[0].result,'SUCCESS');
        }else assert.deepEqual(after,before[i],'rejected deletion rolls back every business row');
      }
      return {response:results[0],audit};
    }
    try {
      for(const status of ['READY','EDITING','INCOMPLETE','CONVERTED','CANCELLED','RESUMED'])await compareDraft(await seedDraft({status}),204);
      for(const call of ['active','ended','disabled'])for(const status of ['READY','EDITING']){
        const result=await compareDraft(await seedDraft({call,status}),409);assert.equal(result.response.body.error.code,'INVALID_STATE');
      }
      for(const call of ['finalized','missing','deleted','expired','no-incoming'])await compareDraft(await seedDraft({call}),204);
      for(const status of ['INCOMPLETE','CONVERTED','CANCELLED','RESUMED'])await compareDraft(await seedDraft({call:'active',status}),204);
      for(const input of [{deleted:true},{retention:'2000-01-01Z'},{status:'INCOMPLETE',retention:'2020-01-01Z'}])await compareDraft(await seedDraft(input),404);
      const superseded=await seedDraft({status:'INCOMPLETE',call:'active'});
      for(const side of sides)await side.calls.query(`INSERT INTO call_sessions(provider_call_id,caller_phone_number,incoming_at,registered_at,started_at,ended_at,order_completion_received_at,order_completion_payload,order_finalized_at,order_finalization_result)
        VALUES('draft-delete-newer','010'||lpad($1::text,8,'0'),'2033-01-01Z','2033-01-01Z','2033-01-01Z','2033-01-02Z','2033-01-02Z','{}','2033-01-03Z','{}')`,[superseded]);
      await compareDraft(superseded,404);
      const parent=await seedDraft({status:'RESUMED'}),child=await seedDraft({source:parent});
      await compareDraft(parent,204);await compareDraft(child,204);await compareDraft(child,404);
      for(const headers of [{Origin:origin},{Origin:origin,Authorization:'Bearer '+process.env.CUSTOMER_AUTH_TOKEN},{Origin:origin,Cookie:'dva_session=bad'}])await compareDraft(await seedDraft(),401,headers);
      const guarded=await seedDraft();await compareDraft(guarded,403,{Cookie:cookie});await compareDraft(guarded,403,{...auth,Origin:'https://untrusted.invalid'});
      for(const id of ['0','-1','1.5','2147483648','abc'])await compareDraft(id,400);await compareDraft(2147483647,404);
      for(const [n,role]of ['OPERATOR','OPERATOR','SYSTEM_ADMIN'].entries()){
        const result=await compareDraft(await seedDraft(),204,{Origin:origin,Cookie:'dva_session='+['a','b','c'][n].repeat(64)});
        assert.equal(result.audit[0].actor_seq,n+1,role);
      }
      for(const target of ['draft','call']){
        const id=await seedDraft({status:'CANCELLED',call:'active'}),locks=[];
        try {
          for(const side of sides){const client=await(target==='draft'?side.db:side.calls).connect();await client.query('BEGIN');
            await client.query(target==='draft'?'SELECT 1 FROM order_parcel_drafts WHERE draft_seq=$1 FOR UPDATE':'SELECT 1 FROM call_sessions WHERE call_session_seq=$1 FOR UPDATE',[id]);locks.push(client);}
          const result=await compareDraft(id,409);assert.equal(result.response.body.error.code,'REQUEST_IN_PROGRESS');
        }finally{for(const client of locks){await client.query('ROLLBACK');client.release();}}
        await compareDraft(id,204);
      }
      const concurrent=await seedDraft();
      for(const side of sides){
        const start=Date.now(),before=(await side.db.query('SELECT to_jsonb(d) AS row FROM order_parcel_drafts d WHERE draft_seq=$1',[concurrent])).rows[0].row;
        const result=await Promise.all([send(side,concurrent,auth,randomUUID()),send(side,concurrent,auth,randomUUID())]);
        assert.deepEqual(result.map(value=>value.status).sort(),[204,404]);
        const after=(await side.db.query('SELECT to_jsonb(d) AS row FROM order_parcel_drafts d WHERE draft_seq=$1',[concurrent])).rows[0].row;
        within(after.deleted_at,start,Date.now(),'concurrent draft deletion');within(after.updated_at,start,Date.now(),'concurrent draft update');
        assert.deepEqual(after,{...before,version:before.version+1,deleted_at:after.deleted_at,updated_at:after.updated_at});
        assert.deepEqual((await side.audit.query("SELECT result FROM audit_logs WHERE action='PARCEL_DRAFT_DELETED' AND target_seq=$1 ORDER BY result",[concurrent])).rows,[{result:'FAILED'},{result:'SUCCESS'}]);
      }
      const failed=await seedDraft();
      for(const side of sides)await side.audit.query(`CREATE FUNCTION reject_draft_delete_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.action='PARCEL_DRAFT_DELETED' AND NEW.result='SUCCESS' THEN RAISE EXCEPTION 'fixture-draft-audit-failure'; END IF;
        RETURN NEW; END $$; CREATE TRIGGER reject_draft_delete_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_draft_delete_audit();`);
      try{const result=await compareDraft(failed,500);assert.equal(result.audit[0].result,'FAILED');}
      finally{for(const side of sides)await side.audit.query('DROP TRIGGER reject_draft_delete_audit ON audit_logs; DROP FUNCTION reject_draft_delete_audit();');}
      await compareDraft(failed,204);
      const batch=[await seedDraft({call:'finalized'}),await seedDraft({call:'finalized'})];
      const blocked=await seedDraft({call:'active'});
      async function rejectBatch(ids,status,input) {
        const before=await Promise.all(sides.map(side=>business(side.db)));
        const calls=await Promise.all(sides.map(side=>rows(side.calls,'call_sessions')));
        const requestId=randomUUID(),start=Date.now(),responses=[];
        for(const side of sides)responses.push(await send(side,ids,auth,requestId,input));
        for(const response of responses)assert.equal(response.status,status,JSON.stringify(response));
        assert.deepEqual(responses[1],responses[0]);
        const audit=await audits(requestId,start,Date.now(),'PARCEL_DRAFT_DELETED','ORDER_PARCEL_DRAFT');
        assert.ok(audit.every(row=>row.result==='FAILED'));
        for(const [index,side] of sides.entries()) {
          assert.deepEqual(await business(side.db),before[index]);
          assert.deepEqual(await rows(side.calls,'call_sessions'),calls[index]);
        }
      }
      for(const input of [{},{draftSeqs:[]},{draftSeqs:[batch[0],batch[0]]},{draftSeqs:['1']},
        {draftSeqs:[0]},{draftSeqs:[1.5]},{draftSeqs:[2147483648]},{draftSeqs:batch,extra:true}])
        await rejectBatch(batch,400,input);
      await rejectBatch([batch[0],2147483647],404);
      await rejectBatch([blocked,batch[0]],409);
      for(const side of sides)await side.audit.query(`CREATE FUNCTION reject_second_draft_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.action='PARCEL_DRAFT_DELETED' AND NEW.target_seq=${batch[1]} AND NEW.result='SUCCESS' THEN RAISE EXCEPTION 'private second draft audit failure'; END IF;
        RETURN NEW; END $$; CREATE TRIGGER reject_second_draft_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_second_draft_audit()`);
      try {await rejectBatch([...batch].reverse(),500);}
      finally {for(const side of sides)await side.audit.query('DROP TRIGGER reject_second_draft_audit ON audit_logs; DROP FUNCTION reject_second_draft_audit()');}
      const gates=[],inflight=[],before=await Promise.all(sides.map(side=>business(side.db)));
      const beforeCalls=await Promise.all(sides.map(side=>rows(side.calls,'call_sessions')));
      const batchRequestId=randomUUID(),started=Date.now();
      let responses;
      try {
        for(const side of sides) {
          await side.audit.query(`CREATE FUNCTION hold_second_draft_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
            IF NEW.action='PARCEL_DRAFT_DELETED' AND NEW.target_seq=${batch[1]} AND NEW.result='SUCCESS' THEN PERFORM pg_advisory_xact_lock(20261112,73); END IF;
            RETURN NEW; END $$; CREATE TRIGGER hold_second_draft_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION hold_second_draft_audit()`);
          const gate=await side.audit.connect();gates.push(gate);await gate.query('SELECT pg_advisory_lock(20261112,73)');
          inflight.push(send(side,[...batch].reverse(),auth,batchRequestId));
        }
        for(let retry=0;;retry++) {
          const waiting=await Promise.all(sides.map(side=>side.audit.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
            WHERE datname=current_database() AND wait_event='advisory' AND query LIKE '%INSERT INTO audit_logs%') waiting`)));
          if(waiting.every(result=>result.rows[0].waiting))break;
          assert.ok(retry<100,'both batch deletes must reach the second audit');await pause(50);
        }
        for(const side of sides)for(const id of batch)
          await assert.rejects(side.calls.query('SELECT 1 FROM call_sessions WHERE call_session_seq=$1 FOR UPDATE NOWAIT',[id]),error=>error.code==='55P03');
        for(const gate of gates)await gate.query('SELECT pg_advisory_unlock(20261112,73)');
        responses=await Promise.all(inflight);
      } finally {
        for(const gate of gates){await gate.query('SELECT pg_advisory_unlock_all()');gate.release();}
        await Promise.allSettled(inflight);
        for(const side of sides)await side.audit.query('DROP TRIGGER IF EXISTS hold_second_draft_audit ON audit_logs; DROP FUNCTION IF EXISTS hold_second_draft_audit()');
      }
      for(const response of responses)assert.equal(response.status,204,JSON.stringify(response));
      assert.deepEqual(responses[1],responses[0]);
      const batchAudits=await audits(batchRequestId,started,Date.now(),'PARCEL_DRAFT_DELETED','ORDER_PARCEL_DRAFT');
      assert.deepEqual(batchAudits.map(row=>row.target_seq),batch);
      assert.ok(batchAudits.every(row=>row.result==='SUCCESS'));
      for(const [index,side] of sides.entries()) {
        const after=await business(side.db);
        for(const id of batch) {
          const old=before[index].order_parcel_drafts.find(row=>row.draft_seq===id),row=after.order_parcel_drafts.find(row=>row.draft_seq===id);
          within(row.deleted_at,started,Date.now(),'batch draft deleted_at');within(row.updated_at,started,Date.now(),'batch draft updated_at');
          assert.deepEqual(row,{...old,version:old.version+1,deleted_at:row.deleted_at,updated_at:row.updated_at});
        }
        for(const table of tables.filter(table=>table!=='order_parcel_drafts'))assert.deepEqual(after[table],before[index][table]);
        assert.deepEqual(await rows(side.calls,'call_sessions'),beforeCalls[index]);
        assert.equal((await fetch(side.url+'/api/parcel-drafts/'+batch[0],{method:'DELETE',headers:auth})).status,404);
      }
      const command={ids:[failed],adminId:1,requestId:randomUUID()};
      for(const [url,event]of [
        ['http://consultation-app:3004/internal/parcel-draft-delete',{eventId:randomUUID(),source:'order',eventType:'ParcelDraftDeletionRequested',payload:{command,orderAddress:null}}],
        ['http://order-app:3002/internal/parcel-draft-delete',{eventId:randomUUID(),source:'consultation',eventType:'ParcelDraftDeletionRequested',payload:{command,phase:'delete',callFinalized:[{draftSeq:failed,callSessionSeq:null,finalized:null}],consultationAddress:null}}],
      ]){
        const sendPrivate=(value,token=process.env.CUSTOMER_AUTH_TOKEN)=>fetch(url,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(value)});
        assert.equal((await sendPrivate(event,'wrong')).status,403);
        for(const bad of [{...event,source:'customer'},{...event,payload:{...event.payload,sql:'DELETE'}},{...event,payload:{...event.payload,command:{...command,adminId:null}}}])assert.equal((await sendPrivate(bad)).status,422);
      }
      console.log('PARCEL DRAFT DELETE HTTP PAIRS: '+draftPairs+'; concurrency, audit rollback and both owner locks compared');
    }finally{
      for(const lock of fixtureLocks){await lock.query('ROLLBACK');lock.release();}
      for(const side of sides){await side.db.query('DELETE FROM order_parcel_drafts WHERE draft_seq=ANY($1::int[])',[created]);await side.calls.query("DELETE FROM call_sessions WHERE provider_call_id LIKE 'draft-delete-%'");}
    }
  });

  assert.deepEqual(await rows(pools.customer,'customers'),preservedOwners.customer,'delete must not mutate customer-owned data');
  const originalIds=new Set(preservedOwners.calls.map(row=>row.call_session_seq));
  assert.deepEqual((await rows(pools.consultation,'call_sessions')).filter(row=>originalIds.has(row.call_session_seq)),preservedOwners.calls,'delete must preserve original call-owned rows');
  await pause(300);
  assert.equal((await pools.operations.query('SELECT 1 FROM order_audit_preparations WHERE NOT aborted')).rowCount,0);
  assert.equal((await pools.order.query("SELECT 1 FROM outbox_events WHERE destination='operations' AND delivered_at IS NULL")).rowCount,0);
  console.log('ORDER DELETE HTTP PAIRS: '+compared+'; full order/payment rows and audit fields compared after each request');
});
