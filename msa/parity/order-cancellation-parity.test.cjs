const { truncateFixture } = require('./fixture-reset.cjs');
require('reflect-metadata');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {Pool}=require('pg');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const origin='http://localhost:5173',cookie='dva_session='+'a'.repeat(64);
const orderTables=['orders','order_parcels','order_payment_requests','organization_billing_months','order_billing_charges','empty_ai_order_results'];
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function within(value,start,end,label){assert.ok(Number.isFinite(Date.parse(value))&&Date.parse(value)>=start-1000&&Date.parse(value)<=end+1000,label+': '+value);}

test('both cancellation APIs preserve source HTTP, full order/payment/shipment rows, audits and AI scope',async t=>{
  assert.equal(process.env.PGDATABASE,'dva_webhook_test');
  const pools=Object.fromEntries(['monolith','order','delivery','consultation','operations','customer'].map(name=>[name,new Pool({host:name+'-db',user:name+'_app'})]));
  const retained=[];
  t.after(async()=>{for(const c of retained){await c.query('ROLLBACK');c.release();}await Promise.all(Object.values(pools).map(p=>p.end()));});
  const sides=[{name:'monolith',url:'http://monolith-app:3000',db:pools.monolith,audit:pools.monolith,calls:pools.monolith,customers:pools.monolith,delivery:pools.monolith},
    {name:'msa',url:'http://order-app:3002',db:pools.order,audit:pools.operations,calls:pools.consultation,customers:pools.customer,delivery:pools.delivery}];
  for(const side of sides){
    await truncateFixture(side.calls, 'TRUNCATE call_sessions RESTART IDENTITY CASCADE');
    await truncateFixture(side.delivery, 'TRUNCATE shipments RESTART IDENTITY CASCADE');
    await truncateFixture(side.db, 'TRUNCATE '+orderTables.join(',')+' RESTART IDENTITY CASCADE');
    await truncateFixture(side.audit, 'TRUNCATE audit_logs RESTART IDENTITY CASCADE');
    await side.db.query("INSERT INTO orders(order_seq,customer_seq,status,version,created_at,updated_at) OVERRIDING SYSTEM VALUE VALUES(1001,1,'COLLECTING',23,'2030-01-01Z','2030-01-01Z')");
    await side.calls.query("INSERT INTO call_sessions(call_session_seq,provider_call_id,caller_phone_number,incoming_at,registered_at,order_intake_enabled) OVERRIDING SYSTEM VALUE VALUES(1011,'cancel-access-call','01000000001','2030-01-01Z','2030-01-01Z',false)");
  }
  for(let i=0;;i++){try{if((await fetch('http://delivery-app:3003/delivery/health/ready')).status===200)break;}catch{}assert.ok(i<60,'delivery ready');await pause(100);}
  for(const [owner,forbidden] of [['delivery',['orders','order_parcels','customers','admin_users']],['order',['shipments','call_sessions','customers']]])
    for(const table of forbidden)assert.equal((await pools[owner].query('SELECT to_regclass($1) AS name',[table])).rows[0].name,null,owner+' owns only its tables');
  let next=8000,compared=0;
  const generated=[new Map(),new Map()],times=[new Map(),new Map()];
  const rows=async(db,table)=>(await db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows.map(x=>x.row);
  async function state(side){const value={};for(const table of orderTables)value[table]=await rows(side.db,table);for(const table of ['shipments','shipment_status_history'])value[table]=await rows(side.delivery,table);return value;}
  function canonical(value,i){
    const result=structuredClone(value);
    for(const [table,values] of Object.entries(result))for(const row of values){
      const key=table==='orders'?row.order_seq:table==='order_payment_requests'?row.payment_request_id:null;
      for(const col of ['updated_at','closed_at','created_at','invalidated_at'])if(times[i].has(table+':'+key+':'+col))row[col]=times[i].get(table+':'+key+':'+col);
      if(table==='order_payment_requests'&&generated[i].has(row.payment_request_id))row.payment_request_id=generated[i].get(row.payment_request_id);
    }
    for(const values of Object.values(result))values.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return result;
  }
  async function seed({status='COLLECTING',prices=[3500,3500],cancelled=[],customer=1,shipment={},payment=true,approval=false,completed=false,invalid=false,notification='SENT',completion='WAITING',expired=false,deleted=false,amount,closed=null}={}){
    const id=++next,requestId=randomUUID(),parcels=prices.map((_,i)=>id*10+i+1);
    for(const side of sides){
      const c=await side.db.connect();
      try{
        await c.query('BEGIN');await c.query("SET LOCAL session_replication_role='replica'");
        await c.query(`INSERT INTO orders(order_seq,customer_seq,status,payment_method_type,version,total_amount,created_at,updated_at,closed_at,deleted_at,payment_due_at,pickup_requested_at,creation_source,created_by_admin_user_seq,parcel_no,dver_received_at)
          OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4,27,$5,$6,'2030-01-01Z',$7,$8,'2094-01-01Z','2030-03-01Z','ADMIN',1,$9,$10)`,
          [id,customer,status,status==='COLLECTING'?null:'billing',amount===undefined?(prices.some(p=>p===null)?null:prices.reduce((a,b)=>a+b,0)):amount,expired?'2000-01-01Z':'2030-01-01Z',closed??(['CANCELLED','ACCEPTED'].includes(status)?'2030-02-01Z':null),deleted?'2030-02-01Z':null,status==='ACCEPTED'?'CANC0001':null,status==='ACCEPTED'?'2030-02-01Z':null]);
        for(const [i,price] of prices.entries())await c.query(`INSERT INTO order_parcels(order_parcel_seq,order_seq,parcel_position,status,notified_price,origin_name,destination_name,item_price,small_box_count,client_comment,origin_pin_scope,origin_pin_seq)
          OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4,$5,'출발 스냅샷','도착 스냅샷',10000,1,'보존 메모','PERSONAL',2)`,[parcels[i],id,i+1,status==='CANCELLED'||cancelled.includes(i)?'CANCELLED':'ACTIVE',price]);
        if(payment)await c.query(`INSERT INTO order_payment_requests(payment_request_id,order_seq,amount,created_at,expires_at,notification_status,completion_notification_status,approval_started_at,invalidated_at,completed_at,provider_reference)
          VALUES($1,$2,7000,'2030-01-01Z','2094-01-01Z',$3,$4,$5,$6,$7,$8)`,[requestId,id,notification,completion,approval?'2030-01-01Z':null,invalid?'2030-01-02Z':null,completed?'2030-01-03Z':null,completed?'cancellation-ref-'+id:null]);
        await c.query('COMMIT');
      }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
      for(const [position,shipmentStatus] of Object.entries(shipment)){
        const shipmentId=id*10+Number(position);
        await side.delivery.query(`INSERT INTO shipments(shipment_seq,order_parcel_seq,tracking_number,status,version,created_at,status_changed_at)
          OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4,19,'2030-01-01Z','2030-01-01Z')`,[shipmentId,parcels[Number(position)],'cancel-fixture-'+shipmentId,shipmentStatus]);
        await side.delivery.query(`INSERT INTO shipment_status_history(shipment_status_history_seq,shipment_seq,request_id,from_status,to_status,actor_type,occurred_at)
          OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,NULL,$4,'SYSTEM','2030-01-01Z')`,[shipmentId,shipmentId,requestId,shipmentStatus]);
      }
      if(expired){const lock=await side.db.connect();retained.push(lock);await lock.query('BEGIN');await lock.query('SELECT 1 FROM orders WHERE order_seq=$1 FOR KEY SHARE',[id]);}
    }
    return{id,parcels,requestId};
  }
  async function call({phone='01000000001',ended=false,order=null,expired=false,deleted=false,customer=2}={}){
    const id=++next;
    for(const side of sides){await side.calls.query(`INSERT INTO call_sessions(call_session_seq,provider_call_id,caller_phone_number,customer_seq,order_seq,incoming_at,registered_at,started_at,ended_at,deleted_at,order_intake_enabled)
      OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4,$5,$6,'2030-01-01Z',$7,$8,$9,false)`,[id,'cancel-scope-'+id,phone,customer,order,expired?'2000-01-01Z':'2030-01-01Z',ended?'2030-01-01Z':null,ended?'2030-01-02Z':null,deleted?'2030-01-03Z':null]);
      if(expired){const lock=await side.calls.connect();retained.push(lock);await lock.query('BEGIN');await lock.query('SELECT 1 FROM call_sessions WHERE call_session_seq=$1 FOR KEY SHARE',[id]);}}
    return{call_session_seq:String(id)};
  }
  async function request(side,id,options={},requestId=randomUUID()){
    const selected=Object.hasOwn(options,'parcels')||Object.hasOwn(options,'body');
    const headers=options.headers??{Origin:origin,Cookie:cookie};
    const response=await fetch(side.url+'/api/orders/'+id+(selected?'/parcels':'')+'/cancel',{method:'POST',headers:{...headers,'Content-Type':'application/json','X-Request-Id':requestId},
      body:Object.hasOwn(options,'body')?JSON.stringify(options.body):selected?JSON.stringify({orderParcelSeqs:options.parcels}):undefined,signal:AbortSignal.timeout(40000)});
    const raw=await response.text();assert.equal(response.headers.get('x-request-id'),requestId);
    return{status:response.status,body:raw?JSON.parse(raw):null,cache:response.headers.get('cache-control')};
  }
  async function compare(id,status,options={}){
    const before=await Promise.all(sides.map(state));
    assert.deepEqual(canonical(before[1],1),canonical(before[0],0),'equal full state before request');
    const owners=await Promise.all(sides.map(async side=>({calls:await rows(side.calls,'call_sessions'),customers:await rows(side.customers,'customers')})));
    const requestId=randomUUID(),start=Date.now(),responses=[];
    for(const side of sides)responses.push(await request(side,id,options,requestId));
    const end=Date.now();for(let i=0;i<2;i++)assert.equal(responses[i].status,status,sides[i].name+' cancel '+id+' '+JSON.stringify(responses[i]));
    assert.deepEqual(responses[1],responses[0],'same public cancellation response');compared++;
    const after=await Promise.all(sides.map(state)),audits=[];
    for(let i=0;i<2;i++){
      assert.deepEqual(await rows(sides[i].calls,'call_sessions'),owners[i].calls,'call owner rows unchanged');
      assert.deepEqual(await rows(sides[i].customers,'customers'),owners[i].customers,'customer owner rows unchanged');
      for(const table of ['shipments','shipment_status_history','organization_billing_months','order_billing_charges','empty_ai_order_results'])assert.deepEqual(after[i][table],before[i][table],'preserve '+table);
      if(status!==204)assert.deepEqual(after[i],before[i],'rejected cancellation rolls back all business writes');
      const newRequests=after[i].order_payment_requests.filter(row=>!before[i].order_payment_requests.some(old=>old.payment_request_id===row.payment_request_id));
      assert.ok(newRequests.length<=1);
      for(const row of newRequests){assert.match(row.payment_request_id,uuid);assert.ok(!generated[i].has(row.payment_request_id));generated[i].set(row.payment_request_id,'generated-'+id+'-'+generated[i].size);}
      for(const [table,fields,key] of [['orders',['updated_at','closed_at'],'order_seq'],['order_payment_requests',['created_at','invalidated_at'],'payment_request_id']])
        for(const row of after[i][table]){
          const old=before[i][table].find(value=>value[key]===row[key]);
          for(const field of fields)if(row[field]!==null&&(!old||old[field]!==row[field])){
            within(row[field],start,end,table+'.'+field);
            times[i].set(table+':'+row[key]+':'+field,'generated-time-'+compared+'-'+field);
          }
        }
      const found=(await sides[i].audit.query('SELECT * FROM audit_logs WHERE request_id=$1 ORDER BY audit_log_seq',[requestId])).rows;
      assert.ok(new Set(found.map(row=>row.occurred_at.toISOString())).size<=1,'one transaction timestamp per audit group');
      const ids=new Set();for(const row of found){within(row.occurred_at,start,end,'audit time');assert.ok(row.audit_log_seq>0&&!ids.has(row.audit_log_seq));ids.add(row.audit_log_seq);delete row.occurred_at;delete row.audit_log_seq;}
      audits.push(found);
    }
    assert.deepEqual(canonical(after[1],1),canonical(after[0],0),'same complete business state after request; generated IDs/times are separately checked');
    assert.deepEqual(audits[1],audits[0],'same audit order, actor, name, target, result and metadata');
    return{before,after,audit:audits[0],response:responses[0]};
  }
  await t.test('both original OpenAPI operations and referenced schemas are unchanged',async()=>{
    const docs=await Promise.all(sides.map(async side=>(await fetch(side.url+'/api/docs-json')).json())),seen=new Set();
    function visit(value){if(!value||typeof value!=='object')return;if(value.$ref?.startsWith('#/components/schemas/')){const name=value.$ref.split('/').at(-1);if(!seen.has(name)){seen.add(name);assert.deepEqual(docs[1].components.schemas[name],docs[0].components.schemas[name],name);visit(docs[0].components.schemas[name]);}}Object.values(value).forEach(visit);}
    for(const path of ['/api/orders/{id}/cancel','/api/orders/{id}/parcels/cancel']){assert.deepEqual(docs[1].paths[path].post,docs[0].paths[path].post,path);visit(docs[0].paths[path].post);}
    for(const [owner,port] of [['order',3002],['delivery',3003],['consultation',3004],['customer',3001]]){const doc=await(await fetch(`http://${owner}-app:${port}/${owner}/docs-json`)).json();assert.ok(Object.keys(doc.paths).every(path=>!path.includes('internal')));}
  });
  await t.test('all roles, bad cookies/Origin, invalid IDs/headers/DTOs retain failures and no writes',async()=>{
    for(const [i,role] of ['OPERATOR','SUPERVISOR','SYSTEM_ADMIN'].entries()){
      const f=await seed();const result=await compare(f.id,204,{headers:{Origin:origin,Cookie:'dva_session='+['a','b','c'][i].repeat(64)}});assert.equal(result.audit[0].actor_seq,i+1,role);
    }
    const f=await seed();
    for(const headers of [{Origin:origin,Cookie:'dva_session=bad',call_session_seq:'1011'},{Origin:origin,Cookie:cookie+'; '+cookie}])await compare(f.id,401,{headers});
    for(const headers of [{Cookie:cookie},{Cookie:cookie,Origin:'https://untrusted.invalid'}])await compare(f.id,403,{headers});
    for(const id of ['0','-1','abc','1.5','2147483648'])await compare(id,400);
    await compare(2147483647,404);
    for(const callId of ['', '0','1,2','-1','2147483648'])await compare(f.id,400,{headers:{Cookie:cookie,Origin:origin,call_session_seq:callId}});
    for(const body of [{},{orderParcelSeqs:[]},{orderParcelSeqs:null},{orderParcelSeqs:['1']},{orderParcelSeqs:[1,1]},{orderParcelSeqs:[0]},{orderParcelSeqs:[2147483648]},{orderParcelSeqs:[1],actorId:1}])await compare(f.id,400,{body});
    await compare(f.id,404,{parcels:[f.parcels[0],2147483647]});
    const largeSelection=Array.from({length:9300},(_,i)=>1000000000+i);
    assert.ok(Buffer.byteLength(JSON.stringify({orderParcelSeqs:largeSelection}))<100*1024);
    await compare(f.id,404,{parcels:largeSelection,headers:{call_session_seq:'1011'}});
    await compare(f.id,413,{body:{orderParcelSeqs:[],padding:'x'.repeat(103000)}});
  });
  await t.test('all states, deleted/expired orders, empty and already cancelled selections keep branch ordering',async()=>{
    for(const status of ['COLLECTING','notPaid','PAID','SUBMITTING','SUBMITTING_FAILED','ACCEPTED','SUBMISSION_FAILED','CANCELLED']){
      const f=await seed({status});await compare(f.id,['COLLECTING','notPaid'].includes(status)?204:409);
      const selected=await seed({status});await compare(selected.id,status==='CANCELLED'?204:['COLLECTING','notPaid'].includes(status)?204:409,{parcels:selected.parcels});
    }
    for(const flags of [{expired:true},{deleted:true}])await compare((await seed(flags)).id,404);
    await compare((await seed({prices:[]})).id,204);
    await compare((await seed({status:'notPaid',prices:[]})).id,409);
    const all=await seed({prices:[3500,3500],cancelled:[0,1]});
    const before=(await state(sides[0])).orders.find(row=>row.order_seq===all.id);
    assert.equal((await compare(all.id,204,{parcels:all.parcels})).audit.length,0);
    await compare(all.id,204);
    const saved=(await state(sides[0])).orders.find(row=>row.order_seq===all.id);assert.equal(saved.total_amount,0);assert.equal(saved.version,before.version+1);
    await compare(all.id,409);
  });
  await t.test('partial, mixed/reversed selections, NULL totals, parent versions, snapshots and payment replacement match',async()=>{
    const f=await seed({status:'notPaid',prices:[3500,3500,3500,3500]});
    const first=await compare(f.id,204,{parcels:[f.parcels[0]]});
    let saved=first.after[0].orders.find(row=>row.order_seq===f.id);assert.equal(saved.status,'notPaid');assert.equal(saved.total_amount,10500);assert.equal(saved.version,28);assert.equal(saved.closed_at,null);
    assert.deepEqual(first.audit.map(row=>row.action),['ORDER_PARCEL_CANCELLED','ORDER_AMOUNT_CHANGED']);
    const second=await compare(f.id,204,{parcels:[f.parcels[2],f.parcels[0],f.parcels[1]]});assert.equal(second.after[0].orders.find(row=>row.order_seq===f.id).total_amount,3500);
    assert.deepEqual(second.audit.map(row=>row.target_seq),[f.parcels[1],f.parcels[2],f.id]);
    const repeated=await compare(f.id,204,{parcels:[f.parcels[1],f.parcels[0],f.parcels[2]]});assert.deepEqual(repeated.after,repeated.before);assert.deepEqual(repeated.audit,[]);
    const finish=await compare(f.id,204,{parcels:[...f.parcels].reverse()});saved=finish.after[0].orders.find(row=>row.order_seq===f.id);assert.equal(saved.status,'CANCELLED');assert.equal(saved.total_amount,0);assert.equal(saved.version,32);
    assert.deepEqual(finish.audit.map(row=>row.action),['ORDER_PARCEL_CANCELLED','ORDER_CANCELLED','ORDER_AMOUNT_CHANGED']);
    assert.ok(finish.after[0].order_payment_requests.filter(row=>row.order_seq===f.id).every(row=>row.invalidated_at!==null));
    assert.deepEqual((await compare(f.id,204,{parcels:f.parcels})).audit,[]);
    for(const prices of [[3500,null],[null,3500],[null,null]]){const v=await seed({prices});const result=await compare(v.id,204,{parcels:[v.parcels[0]]});assert.equal(result.after[0].orders.find(row=>row.order_seq===v.id).total_amount,prices[1]);}
    const overflow=await seed({prices:[1,2147483647,2147483647],amount:null});
    await compare(overflow.id,500,{parcels:[overflow.parcels[0]]});
    const closed=await seed({closed:'2030-02-01Z'});const result=await compare(closed.id,204);assert.equal(result.after[0].orders.find(row=>row.order_seq===closed.id).closed_at,'2030-02-01T00:00:00+00:00');
  });
  await t.test('approval predicates and every notification/completion state preserve source payment fields',async()=>{
    await compare((await seed({approval:true})).id,409);
    for(const flags of [{approval:true,invalid:true},{approval:true,completed:true}])await compare((await seed(flags)).id,204);
    for(const notification of ['PENDING','SENDING','SENT','FAILED','UNKNOWN'])for(const completion of ['WAITING','PENDING','SENDING','SENT','FAILED','UNKNOWN']){
      const f=await seed({status:'notPaid',notification,completion});await compare(f.id,204,{parcels:[f.parcels[0]]});
    }
  });
  await t.test('every shipment status blocks active targets, while unrelated/cancelled siblings remain untouched',async()=>{
    for(const status of ['COLLECTING','notPaid'])for(const shipmentStatus of ['notPaid','paid','received','waiting','sent','canceling','canceled']){
      const f=await seed({status,shipment:{0:shipmentStatus}});await compare(f.id,409);await compare(f.id,409,{parcels:[f.parcels[0]]});
      await compare(f.id,204,{parcels:[f.parcels[1]]});await compare(f.id,204,{parcels:[f.parcels[1]]});
    }
    const f=await seed({cancelled:[0],shipment:{0:'sent'}});await compare(f.id,204);
  });
  await t.test('AI scope uses the current phone customer, ended links and the original error order',async()=>{
    const mine=await seed(),other=await seed({customer:2});
    await compare(mine.id,400,{headers:{}});await compare(mine.id,404,{headers:{call_session_seq:'2147483647'}});
    await compare(other.id,404,{headers:{call_session_seq:'1011'}});
    await compare(mine.id,204,{parcels:[mine.parcels[0]],headers:{call_session_seq:'0001011'}});
    await compare(mine.id,204,{headers:{call_session_seq:'1011'}});
    for(const flags of [{phone:null},{phone:'01099999999'},{phone:'01000000003'},{deleted:true},{expired:true}]){
      const headers=await call(flags);await compare((await seed()).id,flags.deleted||flags.expired?404:403,{headers});
    }
    const ended=await call({ended:true});await compare((await seed()).id,409,{headers:ended});
    const linked=await seed();await compare(linked.id,204,{headers:await call({ended:true,order:linked.id})});
    const current=await seed();const headers=await call({customer:2});const result=await compare(current.id,204,{headers});assert.equal(result.audit[0].actor_type,'AI');assert.equal(result.audit[0].actor_seq,null);
    const foreign=await seed({customer:2,status:'CANCELLED'});await compare(foreign.id,404,{parcels:foreign.parcels,headers:{call_session_seq:'1011'}});
  });
  await t.test('a later success audit SQL error rolls back prior parcels, replaced requests and prepared audits',async()=>{
    const f=await seed({status:'notPaid'});
    for(const side of sides)await side.audit.query(`CREATE FUNCTION reject_order_cancel_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ORDER_AMOUNT_CHANGED' AND NEW.result='SUCCESS' THEN RAISE EXCEPTION 'cancel-audit-fixture'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_order_cancel_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_order_cancel_audit();`);
    try{const result=await compare(f.id,500,{parcels:f.parcels});assert.deepEqual(result.audit.map(row=>[row.action,row.target_type,row.result]),[['ORDER_PARCEL_CANCELLED','ORDER','FAILED']]);}
    finally{for(const side of sides)await side.audit.query('DROP TRIGGER reject_order_cancel_audit ON audit_logs; DROP FUNCTION reject_order_cancel_audit();');}
    await compare(f.id,204,{parcels:f.parcels});
  });
  await t.test('private shipment checks authenticate, validate, reread the same event, and never persist payloads',async()=>{
    const url='http://delivery-app:3003/internal/order-shipment-check',f=await seed();
    const event={eventId:randomUUID(),source:'order',eventType:'OrderShipmentCheckRequested',payload:{orderParcelSeqs:f.parcels}};
    const before=await rows(pools.delivery,'inbox_events');
    const send=async(value,token=process.env.CUSTOMER_AUTH_TOKEN)=>{const r=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(value)});return{status:r.status,body:await r.json()};};
    assert.equal((await send(event,'wrong')).status,403);
    for(const patch of [{source:'customer'},{eventType:'OrderAccepted'},{payload:{orderParcelSeqs:['1']}},{payload:{orderParcelSeqs:[1,1]}},{payload:{orderParcelSeqs:[0]}},{payload:{orderParcelSeqs:f.parcels,adminId:1}}])assert.equal((await send({...event,...patch})).status,422);
    assert.equal((await send(event)).body.payload.blocked,false);
    assert.equal((await send({...event,payload:{orderParcelSeqs:Array.from({length:9300},(_,i)=>1000000000+i)}})).status,200);
    await pools.delivery.query("INSERT INTO shipments(order_parcel_seq,tracking_number,status) VALUES($1,'cancel-check-reread','canceled')",[f.parcels[0]]);
    assert.equal((await send(event)).body.payload.blocked,true);
    await pools.delivery.query("DELETE FROM shipments WHERE tracking_number='cancel-check-reread'");
    assert.equal((await send(event)).body.payload.blocked,false);assert.deepEqual(await rows(pools.delivery,'inbox_events'),before);
    for(const [url,source,token,payload] of [
      ['http://consultation-app:3004/internal/order-cancellation','order',process.env.CUSTOMER_AUTH_TOKEN,{}],
      ['http://customer-app:3001/internal/order-cancellation/call','consultation',process.env.CONSULTATION_AUTH_TOKEN,{}],
      ['http://order-app:3002/internal/order-cancellation','customer',process.env.CUSTOMER_AUTH_TOKEN,{}]]){
      const envelope={eventId:randomUUID(),source,eventType:'OrderCancellationRequested',payload};
      let r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(envelope)});assert.equal(r.status,403);
      r=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(envelope)});assert.equal(r.status,422);
    }
  });
  await t.test('concurrent whole, duplicate parcels and overlapping batches serialize without duplicate success audits',async()=>{
    for(const mode of ['whole','duplicate','overlap']){
      const f=await seed({status:'notPaid',prices:[3500,3500,3500]});
      for(const side of sides){
        const values=await Promise.all([0,1,2].map(n=>request(side,f.id,mode==='whole'?{}:{parcels:mode==='duplicate'?[f.parcels[0]]:n===0?f.parcels.slice(0,2):f.parcels.slice(1)})));
        assert.deepEqual(values.map(v=>v.status).sort(),mode==='whole'?[204,409,409]:[204,204,204]);
        const row=(await side.db.query('SELECT status,total_amount FROM orders WHERE order_seq=$1',[f.id])).rows[0];assert.deepEqual(row,mode==='duplicate'?{status:'notPaid',total_amount:7000}:{status:'CANCELLED',total_amount:0});
        const found=(await side.audit.query("SELECT action,target_seq,count(*)::int AS n FROM audit_logs WHERE result='SUCCESS' AND ((target_type='ORDER' AND target_seq=$1) OR (target_type='ORDER_PARCEL' AND target_seq=ANY($2::int[]))) GROUP BY action,target_seq",[f.id,f.parcels])).rows;
        for(const row of found)if(row.action!=='ORDER_AMOUNT_CHANGED')assert.equal(row.n,1);
      }
    }
  });
  await t.test('concurrent payment commit is rechecked and AI scope rows stay locked until cancellation completes',async()=>{
    const f=await seed({status:'notPaid'});
    async function waiting(db,pattern){for(let i=0;i<200;i++){if((await db.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE $1) AS waiting",[pattern])).rows[0].waiting)return;await pause(10);}assert.fail('not waiting '+pattern);}
    for(const side of sides){const gate=await side.db.connect();let pending;try{await gate.query('BEGIN');await gate.query("UPDATE orders SET status='PAID',paid_at=clock_timestamp() WHERE order_seq=$1",[f.id]);pending=request(side,f.id,{parcels:f.parcels});await waiting(side.db,'%FROM orders%FOR UPDATE%');await gate.query('COMMIT');assert.equal((await pending).status,409);}finally{await gate.query('ROLLBACK');gate.release();await pending?.catch(()=>{});}}
    const held=await seed(),side=sides[1],gate=await side.db.connect();let pending,ending,withdrawal;
    try{
      await gate.query('BEGIN');await gate.query('SELECT 1 FROM orders WHERE order_seq=$1 FOR UPDATE',[held.id]);
      pending=request(side,held.id,{headers:{call_session_seq:'1011'}});await waiting(side.db,'%FROM orders%FOR UPDATE%');
      ending=side.calls.query("UPDATE call_sessions SET started_at='2030-01-01Z',ended_at='2030-01-02Z' WHERE call_session_seq=1011");
      withdrawal=side.customers.query("UPDATE customers SET status='WITHDRAWN' WHERE customer_seq=1");
      await waiting(side.calls,'UPDATE call_sessions SET started_at=%');await waiting(side.customers,'UPDATE customers SET status=%');
      await gate.query('COMMIT');assert.equal((await pending).status,204);await Promise.all([ending,withdrawal]);
      assert.equal((await request(side,held.id,{headers:{call_session_seq:'1011'}})).status,409);
    }finally{await gate.query('ROLLBACK');gate.release();await pending?.catch(()=>{});await Promise.allSettled([ending,withdrawal]);
      await side.calls.query('UPDATE call_sessions SET started_at=NULL,ended_at=NULL WHERE call_session_seq=1011');await side.customers.query("UPDATE customers SET status='ACTIVE' WHERE customer_seq=1");}
  });
  console.log('ORDER CANCELLATION HTTP PAIRS: '+compared+'; full business rows and audit fields compared after each paired request');
});
