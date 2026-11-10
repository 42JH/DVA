const { truncateFixture } = require('./fixture-reset.cjs');
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { Pool } = require('pg');
const { OrdersService } = require('../dist/orders/orders.service');
const { OrdersRepository } = require('../dist/orders/orders.repository');
const tokens = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)];
const headers = { Cookie: 'dva_session='+tokens[0] };
const ai = id => ({ call_session_seq:String(id) });
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
const orderTables = ['orders','order_parcels','order_payment_requests','organization_billing_months','order_billing_charges','empty_ai_order_results','order_parcel_drafts'];

test('four order read APIs preserve monolith HTTP and stored data across owner databases', async t => {
  assert.equal(process.env.PGDATABASE,'dva_webhook_test');
  const databases = Object.fromEntries(['monolith','operations','customer','consultation','order'].map(name=>[name,new Pool({host:name+'-db',user:name+'_app'})]));
  const retention=[];
  t.after(async()=> {
    try {
      for(const client of retention) { await client.query('ROLLBACK');client.release(); }
      for(const db of [databases.monolith,databases.order])await db.query('DELETE FROM order_parcel_drafts WHERE draft_seq BETWEEN 13001 AND 13008');
      for(const db of [databases.monolith,databases.consultation])await db.query("DELETE FROM call_sessions WHERE provider_call_id LIKE 'draft-reference-%'");
    } finally { await Promise.all(Object.values(databases).map(db=>db.end())); }
  });
  const reference=databases.monolith;
  const owners={operations:['admin_users','admin_sessions','audit_logs'],customer:['customers','personal_pins'],consultation:['call_sessions'],order:orderTables};
  const sides=[{name:'monolith',base:'http://monolith-app:3000'}, {name:'msa',base:'http://order-app:3002'}];
  for (const [service,port] of [['monolith',3000],['operations',3005],['customer',3001],['consultation',3004],['order',3002]]) {
    const url=`http://${service}-app:${port}/${service==='monolith'?'api':service}/docs-json`;
    for(let i=0;;i++) {
      try { if((await fetch(url,{signal:AbortSignal.timeout(2000)})).ok) break; } catch {}
      assert.ok(i<60,'app did not start: '+service); await pause(250);
    }
  }
  assert.equal((await fetch(sides[1].base+'/order/health/ready')).status,200);
  for (const [name,db] of Object.entries(databases)) {
    if(name==='monolith') continue;
    const forbidden=name==='order'?['customers','call_sessions','admin_users','shipments']:['orders','order_parcels'];
    for(const table of forbidden) assert.equal((await db.query('SELECT to_regclass($1) AS name',[table])).rows[0].name,null,name+' ownership '+table);
  }
  await truncateFixture(reference, 'TRUNCATE '+[...orderTables,'customers','organizations','call_sessions','admin_users','audit_logs','shipments'].join(',')+' RESTART IDENTITY CASCADE');
  for(const [owner,tables] of Object.entries(owners)) await truncateFixture(databases[owner], 'TRUNCATE '+tables.join(',')+' RESTART IDENTITY CASCADE');
  for(const db of [reference,databases.operations]) {
    for(const [i,role] of ['OPERATOR','SUPERVISOR','SYSTEM_ADMIN'].entries()) {
      await db.query(`INSERT INTO admin_users(admin_user_seq,login_id,name,password_hash,role,status,created_at)
        OVERRIDING SYSTEM VALUE VALUES($1,$2,'조회 담당자','fixture-never-used-for-login',$3,'ACTIVE','2025-01-01T00:00:00Z')`,[i+1,'read'+i,role]);
      await db.query(`INSERT INTO admin_sessions(session_token_hash,admin_user_seq,created_at,expires_at) VALUES($1,$2,'2025-01-01T00:00:00Z','2094-01-01T00:00:00Z')`,[createHash('sha256').update(tokens[i]).digest('hex'),i+1]);
    }
  }
  for(const db of [reference,databases.customer]) {
    for(let id=1;id<=7;id++) await db.query(`INSERT INTO customers(customer_seq,name,phone_number,status,deleted_at)
      OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4,$5)`,
      [id,'고객 '+id,'0100000000'+(id===5?4:id),[3,7].includes(id)?'WITHDRAWN':'ACTIVE',id===4?'2026-01-01T00:00:00Z':null]);
    await db.query(`INSERT INTO personal_pins(personal_pin_seq,customer_seq,address_data,version) OVERRIDING SYSTEM VALUE
      VALUES(2,1,$1,9)`,[{name:'원본 변경됨',phoneNumber:'01000000001',roadAddress:'새 도로',jibunAddress:'새 지번',dongName:'새 동',postalCode:'11111'}]);
  }
  const statuses=['COLLECTING','notPaid','PAID','SUBMITTING','SUBMITTING_FAILED','ACCEPTED','SUBMISSION_FAILED','CANCELLED','ACCEPTED','ACCEPTED','COLLECTING','ACCEPTED','ACCEPTED','ACCEPTED','COLLECTING'];
  for(const db of [reference,databases.order]) {
    const client=await db.connect();
    try {
      await client.query('BEGIN');
      // Read fixtures are valid stored records with identical historical versions/times.
      // SQL guards/triggers are exercised by the separate Liquibase migration checks.
      await client.query("SET LOCAL session_replication_role='replica'");
      for(let n=1;n<=statuses.length;n++) {
        const id=1000+n,status=statuses[n-1],accepted=status==='ACCEPTED';
        const customer=n===7?2:n===9?5:n===10?3:n===11?null:1;
        const created=n===13?'2010-02-01T00:00:00Z':'2030-02-'+String(n===15?1:n).padStart(2,'0')+'T00:00:00Z';
        await client.query(`INSERT INTO orders(order_seq,customer_seq,payment_method_type,status,version,created_at,updated_at,
          creation_source,total_amount,payment_due_at,paid_at,pickup_requested_at,parcel_no,dver_received_at,closed_at,deleted_at,
          billing_organization_seq,billing_department_seq,billing_organization_name,billing_department_name,submission_first_attempt_at,submission_last_attempt_at)
          OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4,23,$5,$5,$6,$7,'2094-01-01T00:00:00Z',$8,'2030-03-01T00:00:00Z',$9,$10,$11,$12,
            999,998,'삭제 전 기업','삭제 전 부서','2094-01-01T00:00:00Z','2094-01-01T00:00:00Z')`,
          [id,customer,n===1?null:n===7?'cat':'billing',status,created,n%2?'AI':'ADMIN',n===1?null:7000,
            ['PAID','SUBMITTING','SUBMITTING_FAILED','ACCEPTED','SUBMISSION_FAILED'].includes(status)?'2030-01-01T00:00:00Z':null,
            accepted?'READ0058':null,accepted?'2030-02-20T00:00:00Z':null,['ACCEPTED','CANCELLED'].includes(status)?created:null,n===12?'2026-01-01T00:00:00Z':null]);
        const count=[1,11,15].includes(n)?0:n===6?3:2;
        for(let p=1;p<=count;p++) await client.query(`INSERT INTO order_parcels(order_parcel_seq,order_seq,parcel_position,status,
          origin_name,origin_phone_number,origin_road_address,origin_jibun_address,origin_detail_address,origin_dong_name,origin_postal_code,
          destination_name,destination_phone_number,destination_road_address,destination_jibun_address,destination_detail_address,destination_dong_name,destination_postal_code,
          origin_pin_scope,origin_pin_seq,document_count,small_box_count,item_price,notified_price,client_comment)
          OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4,$5,'01012345678',$6,CASE WHEN $2=1014 THEN '' ELSE '출발 지번' END,'101호','출발동','00123',
            $7,'01098765432',$8,CASE WHEN $2=1014 THEN '' ELSE '도착 지번' END,NULL,'도착동','00456',$9,$10,1,2,$11,$12,'저장 메모')`,
          [20000+n*10+p,id,p,status==='CANCELLED'||n===6&&p===3?'CANCELLED':'ACTIVE',n===2&&p===2?null:'발송 한글_%',
            n===14?' ':`출발 도로 ${n}`,p===1?'Alice_100%':'다른 수령인',n===14?'':`도착 도로 ${n}`,
            n===6?(p===1?'PERSONAL':'COMPANY'):null,n===6?(p===1?2:901):null,p===1?0:Number.MAX_SAFE_INTEGER,n===2?null:3500]);
      }
      for(const [id,order,invalid,completed,expires] of [
        ['00000000-0000-4000-8000-000000000001',1002,null,null,'2094-01-01T00:00:00Z'],
        ['00000000-0000-4000-8000-000000000002',1002,'2030-01-01T00:00:00Z',null,'2094-01-01T00:00:00Z'],
        ['00000000-0000-4000-8000-000000000003',1003,null,null,'2000-01-01T00:00:00Z'],
        ['00000000-0000-4000-8000-000000000004',1006,null,'2030-01-01T00:00:00Z','2094-01-01T00:00:00Z'],
        ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1004,null,null,'2094-01-01T00:00:00Z'],
        ['00000000-0000-4000-8000-000000000006',1012,null,null,'2094-01-01T00:00:00Z'],
        ['00000000-0000-4000-8000-000000000007',1013,null,null,'2094-01-01T00:00:00Z']])
        await client.query(`INSERT INTO order_payment_requests(payment_request_id,order_seq,amount,expires_at,created_at,invalidated_at,completed_at,provider_reference,notification_status,completion_notification_status)
          VALUES($1,$2,7000,$3,'1999-01-01T00:00:00Z',$4,$5,$6,'SENT',CASE WHEN $5::timestamptz IS NULL THEN 'WAITING' ELSE 'SENT' END)`,[id,order,expires,invalid,completed,completed?'stored-reference':null]);
      await client.query("UPDATE order_payment_requests SET approval_started_at='2030-01-01T00:00:00Z' WHERE payment_request_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'");
      await client.query('UPDATE order_parcels SET origin_name=$1 WHERE order_parcel_seq=20041', ['닫는 </script> & "이름"']);
      await client.query('COMMIT');
    } catch(error) { await client.query('ROLLBACK');throw error; } finally { client.release(); }
  }
  for(const db of [reference,databases.consultation]) {
    for(let n=1;n<=10;n++) await db.query(`INSERT INTO call_sessions(call_session_seq,provider_call_id,caller_phone_number,customer_seq,order_seq,incoming_at,started_at,ended_at,deleted_at,registered_at)
      OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $7::timestamptz IS NULL THEN NULL ELSE '2030-01-01T00:00:00Z'::timestamptz END,$7,$8,'2030-01-01T00:00:00Z')`,
      [1010+n,'read-call-'+n,n===4?null:n===5?'01099999999':'0100000000'+(n===10?4:[1,2,3][n-1]??1),n===10?4:null,n===6?1001:null,
        n===9?'2010-01-01T00:00:00Z':'2030-01-01T00:00:00Z',[6,7].includes(n)?'2030-01-02T00:00:00Z':null,n===8?'2026-01-01T00:00:00Z':null]);
  }
  const longDraftPhone='장'.repeat(40000);
  const draftCalls=[
    [1101,1,'01000000001','2030-01-01T00:00:00.123456Z',null,null,null,null],
    [1099,1,'01000000001','2030-01-01T00:00:00.123457Z','2030-01-01Z','2030-01-02Z','2030-01-02Z','2030-01-03Z'],
    [1103,1,'01000000001','2031-01-01Z','2031-01-01Z','2031-01-02Z',null,null],
    [1104,4,'01000000004',null,'2030-01-01T00:00:00.987654Z','2030-01-02Z',null,null],
    [1105,3,'01000000003','2030-01-01T00:00:00.222222Z',null,null,null,null],
    [1106,null,longDraftPhone,'2030-01-02Z','2030-01-02Z','2030-01-03Z','2030-01-03Z',null],
    [1108,3,'01000000003','2030-01-01T00:00:00.222222Z','2030-01-01Z','2030-01-02Z','2030-01-02Z',null],
  ];
  for(const db of [reference,databases.consultation])for(const [id,customer,phone,incoming,started,ended,finalized,deleted] of draftCalls)
    await db.query(`INSERT INTO call_sessions(call_session_seq,provider_call_id,customer_seq,caller_phone_number,incoming_at,started_at,ended_at,order_finalized_at,deleted_at,registered_at,order_completion_received_at,order_completion_payload,order_finalization_result)
      OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'2030-01-01Z',
        CASE WHEN $8::timestamptz IS NULL THEN NULL ELSE $7::timestamptz END,
        CASE WHEN $8::timestamptz IS NULL THEN NULL ELSE '{}'::jsonb END,
        CASE WHEN $8::timestamptz IS NULL THEN NULL ELSE '{}'::jsonb END)`,[id,'draft-reference-'+id,customer,phone,incoming,started,ended,finalized,deleted]);
  const drafts=[
    [13001,1101,1,'01000000001','INCOMPLETE',null,30001],
    [13002,1105,3,'01000000003','INCOMPLETE',null,30002],
    [13003,1104,4,'01000000004','INCOMPLETE',null,30003],
    [13004,null,null,longDraftPhone,'INCOMPLETE',null,30004],
    [13005,null,null,'no matching historical caller','INCOMPLETE',null,30005],
    [13006,1099,1,'01000000001','RESUMED',null,30006],
    [13007,null,1,'01000000001','READY',13006,30006],
    [13008,1101,null,'01000000001','INCOMPLETE',null,30008],
  ].map(row=>[...row,randomUUID()]);
  for(const db of [reference,databases.order])for(const [id,call,customer,phone,status,source,reserved,uuid] of drafts)
    await db.query(`INSERT INTO order_parcel_drafts(draft_seq,call_session_seq,customer_seq,caller_phone_number,status,source_draft_seq,reserved_order_seq,
      client_parcel_id,created_by_admin_user_seq,creation_payload,parcel_data,created_at,updated_at,retention_started_at)
      OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,'{}','{}','2030-01-01Z','2030-01-01Z','2030-01-01Z')`,
      [id,call,customer,phone,status,source,reserved,uuid]);
  await reference.query(`INSERT INTO shipments(order_parcel_seq,tracking_number,status) VALUES(20061,'private-shipment-tracking','sent')`);
  // Retain expired fixtures while exercising their HTTP/SQL invisibility with production purgers enabled.
  for(const [db,table,column,id] of [[reference,'orders','order_seq',1013],[databases.order,'orders','order_seq',1013],
    [reference,'call_sessions','call_session_seq',1019],[databases.consultation,'call_sessions','call_session_seq',1019]]) {
    const client=await db.connect();await client.query('BEGIN');await client.query(`SELECT 1 FROM ${table} WHERE ${column}=$1 FOR KEY SHARE`,[id]);retention.push(client);
  }
  async function snapshot(db,tables) {
    const value={};for(const table of tables) value[table]=(await db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
    return value;
  }
  const before={},referenceBefore={};
  const callFields=['call_session_seq','provider_call_id','caller_phone_number','customer_seq','order_seq','incoming_at','started_at','ended_at','registered_at','deleted_at'];
  const callScope=rows=>rows.map(({row})=>Object.fromEntries(callFields.map(field=>[field,row[field]]))).sort((a,b)=>a.call_session_seq-b.call_session_seq);
  for(const [owner,tables] of Object.entries(owners)) {
    before[owner]=await snapshot(databases[owner],tables);
    referenceBefore[owner]=await snapshot(reference,tables);
    if(owner==='consultation') {
      // The existing MSA retains retired end_reason and has no retention-worker claims yet.
      // Compare every order access field; full physical rows on both sides remain immutable below.
      assert.deepEqual(callScope(before[owner].call_sessions),callScope(referenceBefore[owner].call_sessions),'same call access fixture');
    } else assert.deepEqual(before[owner],referenceBefore[owner],'same stored fixture: '+owner);
  }
  const messageCounts={};
  for(const owner of Object.keys(owners)) messageCounts[owner]=await snapshot(databases[owner],['outbox_events','inbox_events']);
  let compared=0;
  async function request(side,path,expected,extra,requestId) {
    const response=await fetch(side.base+path,{headers:{Authorization:'Bearer '+process.env.PGPASSWORD,...extra,'X-Request-Id':requestId},signal:AbortSignal.timeout(20000)});
    const text=await response.text();
    const body=response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text;
    assert.equal(response.status,expected,side.name+' '+path+' '+JSON.stringify(body));
    assert.equal(response.headers.get('x-request-id'),requestId);assert.equal(response.headers.get('cache-control'),'no-store');
    if(path.startsWith('/api/payments/')&&expected===200) {
      assert.equal(response.headers.get('referrer-policy'),'no-referrer');
      if(!path.startsWith('/api/payments/requests/')) {
        assert.equal(response.headers.get('x-content-type-options'),'nosniff');
        assert.equal(response.headers.get('x-frame-options'),'DENY');
        assert.equal(response.headers.get('content-security-policy'),"default-src 'self'; script-src 'self' https://js.tosspayments.com; style-src 'self'; style-src-attr 'unsafe-inline'; connect-src 'self' https://*.tosspayments.com https://*.toss.im; frame-src https:; img-src 'self' data: https:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
        assert.equal(response.headers.get('content-type'),path.endsWith('.js')?'text/javascript; charset=utf-8':path.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8');
      } else assert.equal(response.headers.get('content-type'),'application/json; charset=utf-8');
    }
    return body;
  }
  async function compare(path,expected=200,extra=headers) {
    const requestId=randomUUID(),results=[];
    for(const side of sides) results.push(await request(side,path,expected,extra,requestId));
    assert.deepEqual(results[1],results[0],path);compared++;return results[0];
  }
  await t.test('the four OpenAPI operations and every referenced request/response schema match',async()=> {
    const documents=await Promise.all(sides.map(async side=>(await fetch(side.base+'/api/docs-json')).json()));
    const visited=new Set();
    function schemas(value) {
      if(value===null||typeof value!=='object') return;
      if(typeof value.$ref==='string'&&value.$ref.startsWith('#/components/schemas/')) {
        const name=value.$ref.slice('#/components/schemas/'.length);
        if(visited.has(name)) return;visited.add(name);
        assert.deepEqual(documents[1].components.schemas[name],documents[0].components.schemas[name],name);
        schemas(documents[0].components.schemas[name]);
      }
      for(const child of Object.values(value)) schemas(child);
    }
    for(const path of ['/api/orders','/api/orders/{id}','/api/admin/orders','/api/customers/{id}/addresses','/api/payments/requests/{id}']) {
      assert.deepEqual(documents[1].paths[path].get,documents[0].paths[path].get,path);
      schemas(documents[0].paths[path].get);
    }
    assert.ok(visited.size>5);
  });
  await t.test('payment reads preserve every state, exact HTML/assets, escaping and public access without changing stored data',async()=> {
    for(const [number,status] of [[1,'PENDING'],[2,'CANCELLED'],[3,'EXPIRED'],[4,'PAID'],[5,'REVIEW_REQUIRED']]) {
      const id=number===5?'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa':'00000000-0000-4000-8000-'+String(number).padStart(12,'0');
      const view=await compare('/api/payments/requests/'+id,200,{});
      assert.equal(view.data.status,status);
      assert.equal(view.data.token,id);
      await compare('/api/payments/requests/'+id.toUpperCase(),200,{Cookie:'dva_session=invalid'});
      for(const mode of ['p','success','fail']) {
        const html=await compare('/api/payments/'+mode+'/'+id,200,{});
        assert.ok(html.includes('id="payment-data" type="application/json"'));
        if(number===5) {
          assert.ok(html.includes('닫는 &lt;/script&gt; &amp; &quot;이름&quot;'));
          assert.ok(!html.includes('닫는 </script>'));
          const data=JSON.parse(/<script id="payment-data" type="application\/json">(.*?)<\/script>/s.exec(html)[1]);
          assert.equal(data.senderName,'닫는 </script> & "이름"');
        }
      }
    }
    for(const mode of ['requests','p','success','fail']) {
      for(const id of ['00000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-000000000007','ffffffff-ffff-4fff-8fff-ffffffffffff'])
        await compare('/api/payments/'+mode+'/'+id,404,{});
      for(const id of ['invalid','00000000-0000-1000-8000-000000000001'])
        await compare('/api/payments/'+mode+'/'+id,400,{});
    }
    for(const name of ['checkout.js','style.css']) await compare('/api/payments/assets/'+name,200,{});
    for(const name of ['secret.key','%2e%2e%2fpackage.json']) await compare('/api/payments/assets/'+name,404,{});
    const documents=await Promise.all(sides.map(async side=>(await fetch(side.base+'/api/docs-json')).json()));
    assert.deepEqual(documents[1].paths['/api/payments/requests/{id}'].get,documents[0].paths['/api/payments/requests/{id}'].get);
    for(const name of ['PaymentStatusDto','RequestMetaDto','ErrorResponseDto']) assert.deepEqual(documents[1].components.schemas[name],documents[0].components.schemas[name],name);
    for(const document of documents) for(const path of ['/api/payments/assets/{name}','/api/payments/p/{id}','/api/payments/success/{id}','/api/payments/fail/{id}']) assert.equal(document.paths[path],undefined);
  });
  await t.test('order customer references keep service authentication, current visibility and read-only receipts',async()=> {
    const {requestReferences}=require('@dva/events/call-read-references.cjs');
    const base='http://customer-app:3001';
    const path='/internal/call-read-references/for-orders';
    const customerToken=process.env.CUSTOMER_AUTH_TOKEN;
    const consultationToken=process.env.CONSULTATION_AUTH_TOKEN;
    const ids=[1,3,4,5,7];
    const expected=(await reference.query(`SELECT c.customer_seq,c.name,o.organization_seq,o.name AS organization_name FROM customers c
      LEFT JOIN memberships m ON m.customer_seq=c.customer_seq AND m.deleted_at IS NULL
      LEFT JOIN organizations o ON o.organization_seq=m.organization_seq AND o.deleted_at IS NULL
      WHERE c.customer_seq=ANY($1::int[]) AND c.deleted_at IS NULL ORDER BY c.customer_seq`,[ids])).rows;
    assert.deepEqual(await requestReferences('customer',base+path,customerToken,ids,'order'),expected);
    const maximum=Array.from({length:250},(_,n)=>n+1);
    const maximumExpected=(await reference.query('SELECT customer_seq FROM customers WHERE customer_seq=ANY($1::int[]) AND deleted_at IS NULL ORDER BY customer_seq',[maximum])).rows;
    assert.deepEqual((await requestReferences('customer',base+path,customerToken,maximum,'order')).map(row=>({customer_seq:row.customer_seq})),maximumExpected);
    const packet={eventId:randomUUID(),source:'order',eventType:'CallReadReferencesRequested',payload:{ids}};
    async function post(target,body,token,expectedStatus) {
      const response=await fetch(base+target,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
      assert.equal(response.status,expectedStatus);
      if(expectedStatus===200) {
        assert.equal(response.headers.get('cache-control'),'no-store');
        assert.deepEqual(await response.json(),{eventId:packet.eventId,status:'processed',payload:expected});
      } else await response.body?.cancel();
    }
    for(const token of [undefined,'wrong',consultationToken]) await post(path,packet,token,403);
    for(const body of [{...packet,source:'consultation'},{...packet,source:'customer'},
      {...packet,payload:{ids:[]}},{...packet,payload:{ids:[1,1]}},
      {...packet,payload:{ids:maximum.concat(251)}},{...packet,payload:{ids,sql:'SELECT private'}}])
      await post(path,body,customerToken,422);
    await post(path,packet,customerToken,200);
    await post(path,packet,customerToken,200);
    await post('/api'+path,packet,customerToken,404);
    await post('/internal/call-read-references',{...packet,source:'consultation'},customerToken,403);
    const old=await requestReferences('customer',base+'/internal/call-read-references',consultationToken,ids);
    assert.deepEqual(old,expected);
    const document=await (await fetch(base+'/api/docs-json')).json();
    assert.ok(!Object.keys(document.paths).some(path=>path.includes('call-read-references')));
  });
  await t.test('draft call references reproduce original availability including deleted newer calls, tuple precision and large legacy phones',async()=> {
    const {requestDraftCallReferences,requestParcelDraftCommand}=require('@dva/events/parcel-drafts.cjs');
    const base='http://consultation-app:3004';const path='/internal/order-draft-call-references';
    const token=process.env.CUSTOMER_AUTH_TOKEN;
    const scope={callIds:[1101,1099,1104,1105],customerIds:[1,3,4],phones:['01000000001',longDraftPhone,'no matching historical caller']};
    const refs=await requestDraftCallReferences(base+path,token,scope);
    assert.match(refs.calls.find(r=>r.call_session_seq===1101).started_at,/\.123456/);
    assert.equal(refs.customers.find(r=>r.customer_seq===1).call_session_seq,1099);
    assert.equal(refs.customers.find(r=>r.customer_seq===3).call_session_seq,1108);
    assert.equal(refs.phones.find(r=>r.caller_phone_number===longDraftPhone).call_session_seq,1106);
    const visible=(await databases.order.query(`WITH origins AS(
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS c(call_session_seq int,started_at timestamptz)),
      latest AS(SELECT call_session_seq,customer_seq,NULL::text AS caller_phone_number,started_at FROM jsonb_to_recordset($2::jsonb) AS c(call_session_seq int,customer_seq int,started_at timestamptz)
        UNION ALL SELECT call_session_seq,NULL::int,caller_phone_number,started_at FROM jsonb_to_recordset($3::jsonb) AS c(call_session_seq int,caller_phone_number text,started_at timestamptz))
      SELECT d.draft_seq FROM order_parcel_drafts d WHERE d.deleted_at IS NULL AND d.retention_started_at>transaction_timestamp()-interval '5 years'
       AND (NOT(d.status='INCOMPLETE' OR(d.source_draft_seq IS NOT NULL AND d.status IN('READY','EDITING')))
        OR(d.retention_started_at>transaction_timestamp()-interval '24 hours' AND NOT EXISTS(
          SELECT 1 FROM latest newer LEFT JOIN order_parcel_drafts source ON source.draft_seq=d.source_draft_seq
          LEFT JOIN origins origin ON origin.call_session_seq=COALESCE(d.call_session_seq,source.call_session_seq)
          WHERE ((d.customer_seq IS NOT NULL AND newer.customer_seq=d.customer_seq)OR(d.customer_seq IS NULL AND newer.caller_phone_number=d.caller_phone_number))
           AND(newer.started_at,newer.call_session_seq)>(COALESCE(origin.started_at,d.retention_started_at),COALESCE(origin.call_session_seq,0))))) ORDER BY d.draft_seq`,
      [JSON.stringify(refs.calls),JSON.stringify(refs.customers),JSON.stringify(refs.phones)])).rows.map(r=>r.draft_seq);
    assert.deepEqual(visible,[13003,13005,13006,13007]);
    for(const [id] of drafts) {
      const response=await fetch(sides[0].base+'/api/parcel-drafts/'+id,{headers});
      assert.equal(response.status,visible.includes(id)?200:404,'original draft availability '+id);
      const body=await response.json();if(response.ok)assert.equal(body.data.draftSeq,id);
    }
    const concurrent=await Promise.all(Array.from({length:5},()=>requestDraftCallReferences(base+path,token,scope)));
    for(const result of concurrent)assert.deepEqual(result,refs);
    const packet={eventId:randomUUID(),source:'order',eventType:'DraftCallReferencesRequested',payload:{callIds:Array.from({length:250},(_,n)=>n+1),customerIds:[],phones:[],phoneHashes:[]}};
    const maximum=await requestParcelDraftCommand(base+path,token,packet);assert.deepEqual(maximum,{calls:[],customers:[],phones:[]});
    async function post(target,body,credential,expected) {
      const response=await fetch(base+target,{method:'POST',headers:{'Content-Type':'application/json',...(credential?{Authorization:'Bearer '+credential}:{})},body:JSON.stringify(body)});
      assert.equal(response.status,expected);await response.body?.cancel();
    }
    for(const credential of [undefined,'wrong',process.env.CONSULTATION_AUTH_TOKEN])await post(path,packet,credential,403);
    for(const body of [{...packet,source:'consultation'},{...packet,payload:{...packet.payload,callIds:[1,1]}},
      {...packet,payload:{...packet.payload,callIds:packet.payload.callIds.concat(251)}},{...packet,payload:{...packet.payload,sql:'SELECT private'}},
      {...packet,payload:{...packet.payload,phones:['x'.repeat(257)]}}])await post(path,body,token,422);
    await post(path,{...packet,payload:{...packet.payload,phones:[longDraftPhone]}},token,413);
    await post('/api'+path,packet,token,404);
    const document=await(await fetch(base+'/api/docs-json')).json();assert.ok(!Object.keys(document.paths).some(p=>p.includes('order-draft-call-references')));
  });
  await t.test('admin read scopes reuse saturated owner pools and retain one snapshot during edits',async()=> {
    const {createServer}=require('node:http'),{networkInterfaces}=require('node:os');
    const {requestReferences,requestOrderOrganization}=require('@dva/events/call-read-references.cjs');
    const {requestDraftCallReferences}=require('@dva/events/parcel-drafts.cjs');
    const address=Object.values(networkInterfaces()).flat().find(row=>row.family==='IPv4'&&!row.internal)?.address;
    assert.ok(address);
    const token=process.env.CUSTOMER_AUTH_TOKEN,consToken=process.env.CONSULTATION_AUTH_TOKEN;
    const customerBase='http://customer-app:3001',consultationBase='http://consultation-app:3004';
    const oldName=(await databases.customer.query('SELECT name FROM customers WHERE customer_seq=1')).rows[0].name;
    const oldStarted=(await databases.consultation.query("SELECT to_jsonb(incoming_at)#>>'{}' AS started FROM call_sessions WHERE call_session_seq=1101")).rows[0].started;
    let entered,release;const arrivals=new Promise(r=>entered=r),gate=new Promise(r=>release=r),seen=[];let pending=[];
    const counts={all:0,incomplete:0,notPaid:0,paid:0,submissionFailed:0,cancelled:0};
    const server=createServer(async(req,res)=>{
      try {
        assert.equal(req.url,'/internal/admin-order-read');assert.equal(req.headers.authorization,'Bearer '+token);
        const chunks=[];for await(const chunk of req)chunks.push(chunk);const packet=JSON.parse(Buffer.concat(chunks));
        assert.equal(packet.source,'customer');seen.push(packet.eventId);if(seen.length===5)entered();await gate;
        const customer=await requestReferences('customer',customerBase+'/internal/call-read-references/for-orders',token,[1],'order',packet.eventId);
        assert.equal(customer[0].name,oldName);
        const refs=await requestDraftCallReferences(consultationBase+'/internal/order-draft-call-references',token,{callIds:[1101],customerIds:[],phones:[]},packet.eventId);
        assert.equal(refs.calls[0].started_at,oldStarted);
        assert.deepEqual(await requestOrderOrganization(customerBase+'/internal/call-read-references/order-organization',token,2147483647,packet.eventId),{organization_seq:2147483647,organization_name:null,customer_seqs:[]});
        res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({eventId:packet.eventId,status:'processed',payload:{data:[],hasNext:false,total_count:0,statusCounts:counts}}));
      } catch(error) {res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:String(error)}));}
    });
    await new Promise(r=>server.listen(3002,'0.0.0.0',r));
    const post=(base,path,body,auth=token,scope)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+auth,...(scope===undefined?{}:{'X-Msa-Read-Scope':scope})},body:JSON.stringify(body),signal:AbortSignal.timeout(25000)});
    const packet=()=>({eventId:randomUUID(),source:'order',eventType:'AdminOrdersReadRequested',payload:{query:{limit:20,offset:0},orderAddress:address}});
    const referencePacket={eventId:randomUUID(),source:'order',eventType:'CallReadReferencesRequested',payload:{ids:[1]}};
    try {
      assert.equal((await post(consultationBase,'/internal/admin-order-read',packet(),'wrong')).status,403);
      assert.equal((await post(consultationBase,'/internal/admin-order-read',{...packet(),source:'customer'})).status,422);
      const forged=packet();forged.payload.orderAddress='169.254.169.254';assert.equal((await post(consultationBase,'/internal/admin-order-read',forged)).status,422);
      assert.equal((await post(customerBase,'/internal/call-read-references/admin-orders',packet(),token)).status,403);
      pending=Array.from({length:5},()=>post(consultationBase,'/internal/admin-order-read',packet()));
      let timer;try{await Promise.race([arrivals,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('owner pool scope did not enter')),10000);})]);}finally{clearTimeout(timer);}
      await databases.customer.query("UPDATE customers SET name='수정된 고객' WHERE customer_seq=1");
      await databases.consultation.query("UPDATE call_sessions SET incoming_at='2030-01-01T00:00:00.123459Z' WHERE call_session_seq=1101");
      release();
      for(const response of await Promise.all(pending)){const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));assert.deepEqual(body.payload.statusCounts,counts);}
      assert.equal(new Set(seen).size,5);
      for(const scope of ['invalid',...seen])assert.equal((await post(customerBase,'/internal/call-read-references/for-orders',referencePacket,token,scope)).status,scope==='invalid'?422:503);
      const draft={eventId:randomUUID(),source:'order',eventType:'DraftCallReferencesRequested',payload:{callIds:[1101],customerIds:[],phones:[],phoneHashes:[]}};
      assert.equal((await post(consultationBase,'/internal/order-draft-call-references',draft,token,seen[0])).status,503);
      assert.equal((await requestReferences('customer',customerBase+'/internal/call-read-references/for-orders',token,[1],'order'))[0].name,'수정된 고객');
      assert.equal((await requestDraftCallReferences(consultationBase+'/internal/order-draft-call-references',token,{callIds:[1101],customerIds:[],phones:[]})).calls[0].started_at,'2030-01-01T00:00:00.123459+00:00');
      for(const [base,prefix]of [[customerBase,'customer'],[consultationBase,'consultation']]){
        const document=await(await fetch(base+'/'+prefix+'/docs-json')).json();assert.ok(!JSON.stringify(document.paths).includes('admin-order-read'));assert.ok(!JSON.stringify(document.paths).includes('order-organization'));
      }
    } finally {
      release();await Promise.allSettled(pending);await new Promise(r=>server.close(r));
      await databases.customer.query('UPDATE customers SET name=$1 WHERE customer_seq=1',[oldName]);
      await databases.consultation.query('UPDATE call_sessions SET incoming_at=$1 WHERE call_session_seq=1101',[oldStarted]);
    }
  });
  await t.test('all roles, filters, stable order, page boundaries and totals',async()=> {
    for(const token of tokens) await compare('/api/orders',200,{Cookie:'dva_session='+token});
    for(const path of ['/api/orders?customerSeq=1&limit=2','/api/orders?customerSeq=1&limit=2&offset=2','/api/orders?customerSeq=1&offset=100',
      '/api/orders?from=2030-02-01T09:00:00%2B09:00&to=2030-02-09T00:00:00Z',
      '/api/orders?recipientName=alice_100%25','/api/orders?recipientName=%25','/api/orders?recipientName=_',
      '/api/orders?recipientName=%27%20OR%201%3D1--','/api/orders?customerSeq=2&status=SUBMISSION_FAILED']) await compare(path);
    for(const status of statuses.slice(0,8)) await compare('/api/orders?status='+status);
    const first=await compare('/api/orders?customerSeq=1&from=2030-02-01T00:00:00Z&to=2030-02-02T00:00:00Z&limit=1');
    assert.deepEqual(first.data.map(row=>row.orderSeq),[1015]);assert.equal(first.total_count,2);assert.equal(first.hasNext,true);
    assert.equal(first.data[0].parcelCount,0);
  });
  await t.test('detail preserves nullable fields, historical amounts, PIN/billing snapshots and current payment request',async()=> {
    for(let id=1001;id<=1015;id++) {
      const body=await compare('/api/orders/'+id,[1012,1013].includes(id)?404:200);
      if(id===1001) { assert.equal(body.data.paymentMethodType,null);assert.equal(body.data.version,23);assert.deepEqual(body.data.parcels,[]); }
      if(id===1002) { assert.equal(body.data.paymentRequest.paymentRequestId,'00000000-0000-4000-8000-000000000001');assert.equal(body.data.parcels[1].itemPrice,Number.MAX_SAFE_INTEGER);assert.equal(body.data.parcels[0].notifiedPrice,null); }
      if(id===1003||id===1006) assert.equal(body.data.paymentRequest,null);
      if(id===1006) { assert.deepEqual(body.data.parcels.map(p=>p.status),['ACTIVE','ACTIVE','CANCELLED']);assert.deepEqual(body.data.parcels[0].originPin,{scope:'PERSONAL',pinSeq:2});assert.equal(body.data.billingOrganizationName,'삭제 전 기업'); }
      assert.ok(!JSON.stringify(body).includes('private-shipment-tracking'));
    }
  });
  await t.test('AI follows the current active phone customer and only the linked detail after call end',async()=> {
    await compare('/api/orders',200,ai(1011));await compare('/api/orders?customerSeq=1',200,ai(1011));
    await compare('/api/orders?customerSeq=2',403,ai(1011));
    for(const call of [1013,1014,1015]) await compare('/api/orders',403,ai(call));
    for(const call of [1016,1017]) await compare('/api/orders',409,ai(call));
    for(const call of [1018,1019,2147483647]) await compare('/api/orders',404,ai(call));
    for(const [id,status] of [[1001,200],[1007,404],[2147483647,404]]) await compare('/api/orders/'+id,status,ai(1011));
    await compare('/api/orders/1001',200,ai(1016));await compare('/api/orders/1002',409,ai(1016));
    const replaced=await compare('/api/orders',200,ai(1020));assert.deepEqual(replaced.data.map(o=>o.customerSeq),[5]);
    await compare('/api/orders/1009',200,ai(1020));
  });
  await t.test('admin screen searches NFC, formatted phones and literal special characters and groups states',async()=> {
    for(const query of ['', '?limit=1','?offset=999','?q=한글','?q=010-9876-5432','?q=%25','?q=_','?q=%27%20OR%201%3D1--',
      '?from=2030-02-01T00:00:00Z&to=2030-02-10T00:00:00Z&limit=2']) await compare('/api/admin/orders'+query);
    for(const group of ['COLLECTING','notPaid','PAID','SUBMISSION_FAILED','CANCELLED']) await compare('/api/admin/orders?statusGroup='+group);
    await compare('/api/admin/orders',401,{});
  });
  await t.test('previous addresses use accepted active snapshots, existing customers and caller bounds',async()=> {
    for(const direction of ['ORIGIN','DESTINATION']) for(const query of ['', '&limit=1','&offset=100','&q=한글','&q=%25',
      '&from=2030-02-06T09:00:00%2B09:00&to=2030-02-07T00:00:00Z']) await compare('/api/customers/1/addresses?direction='+direction+query);
    for(const id of [2,3,5,7]) await compare(`/api/customers/${id}/addresses?direction=ORIGIN`);
    for(const id of [4,2147483647]) await compare(`/api/customers/${id}/addresses?direction=ORIGIN`,404);
    await compare('/api/customers/1/addresses?direction=ORIGIN',200,ai(1011));
    await compare('/api/customers/2/addresses?direction=ORIGIN',403,ai(1011));
    await compare('/api/customers/1/addresses?direction=ORIGIN',409,ai(1016));
    const body=await compare('/api/customers/1/addresses?direction=ORIGIN');
    assert.deepEqual(body.data.map(row=>row.orderSeq),[1006,1006]);
    assert.ok(body.data.every(row=>row.address.roadAddress==='출발 도로 6'));
  });
  await t.test('invalid parameters, duplicate filters, period/phone bounds and cookies preserve exact errors',async()=> {
    for(const query of ['?from=2030-02-02T00:00:00Z&to=2030-02-01T00:00:00Z','?from=2030-02-01T00:00:00+99:00',
      '?customerSeq=1&customerSeq=2','?limit=101','?limit=0','?offset=-1','?status=unknown','?shipmentStatus=sent','?recipientName=','?unknown=1']) await compare('/api/orders'+query,400);
    for(const id of ['0','-1','2147483648','1.5','1e2','abc']) await compare('/api/orders/'+id,400);
    for(const call of [undefined,'','abc','0','-1','2147483648','1,2']) await compare('/api/orders',400,call===undefined?{}:ai(call));
    for(const cookie of ['dva_session=expired','dva_session='+tokens[0]+'; dva_session='+tokens[0]]) await compare('/api/orders',401,{Cookie:cookie,...ai(1011)});
    for(const query of ['', '?direction=BAD','?direction=ORIGIN&unknown=1','?direction=ORIGIN&direction=DESTINATION','?direction=ORIGIN&limit=101']) await compare('/api/customers/1/addresses'+query,400);
    for(const query of ['?statusGroup=ACCEPTED','?q='+encodeURIComponent('\0'),'?q='+'x'.repeat(201)]) await compare('/api/admin/orders'+query,400);
  });
  await t.test('more simultaneous AI reads than any owner pool finish without a callback deadlock',async()=> {
    const path='/api/orders/1001',requestId=randomUUID();
    // Sample the unchanged oracle once before saturating the MSA owner callbacks.
    const expected=await request(sides[0],path,200,ai(1011),requestId);
    await Promise.all(Array.from({length:12},async()=> {
      assert.deepEqual(await request(sides[1],path,200,ai(1011),requestId),expected,path);compared++;
    }));
  });
  await t.test('all public reads leave business rows, versions, timestamps, audit and event history unchanged',async()=> {
    for(const [owner,tables] of Object.entries(owners)) {
      assert.deepEqual(await snapshot(databases[owner],tables),before[owner],owner+' unchanged');
      assert.deepEqual(await snapshot(reference,tables),referenceBefore[owner],'monolith '+owner+' unchanged');
      assert.deepEqual(await snapshot(databases[owner],['outbox_events','inbox_events']),messageCounts[owner],owner+' query messages not persisted');
    }
  });
  await t.test('private queries reject forged tokens/sources and replay reads current state without writes',async()=> {
    const command={operation:'OrdersListed',id:null,callSessionSeq:1011,query:{limit:20,offset:0}};
    const event={eventId:randomUUID(),source:'order',eventType:'OrderReadRequested',payload:{command}};
    async function internal(base,path,body,token) {
      const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
      return {status:response.status,body:await response.json()};
    }
    const url='http://consultation-app:3004';
    assert.equal((await internal(url,'/internal/order-read',event,'wrong')).status,403);
    assert.equal((await internal(url,'/internal/order-read',{...event,source:'customer'},process.env.CUSTOMER_AUTH_TOKEN)).status,422);
    const first=await internal(url,'/internal/order-read',event,process.env.CUSTOMER_AUTH_TOKEN);
    assert.equal(first.status,200);assert.equal(first.body.eventId,event.eventId);
    assert.deepEqual(await internal(url,'/internal/order-read',event,process.env.CUSTOMER_AUTH_TOKEN),first);
    await databases.customer.query("UPDATE customers SET status='WITHDRAWN' WHERE customer_seq=1");
    assert.equal((await internal(url,'/internal/order-read',event,process.env.CUSTOMER_AUTH_TOKEN)).status,403);
    await databases.customer.query("UPDATE customers SET status='ACTIVE' WHERE customer_seq=1");
    for(const [base,path,token] of [[sides[1].base,'/internal/order-read',process.env.CUSTOMER_AUTH_TOKEN],
      ['http://customer-app:3001','/internal/order-read/call',process.env.CONSULTATION_AUTH_TOKEN]]) {
      assert.equal((await internal(base,path,event,'wrong')).status,403);
      assert.equal((await internal(base,path,event,token)).status,422);
    }
  });
  await t.test('one local snapshot keeps version and parcels together during a real concurrent edit',async()=> {
    const pool=databases.order,repository=new OrdersRepository();
    await pool.query("INSERT INTO order_parcels(order_seq,parcel_position,origin_name) VALUES(1001,1,'수정 전')");
    const original=repository.detail.bind(repository);
    repository.detail=async(...args)=> { await pool.query("UPDATE order_parcels SET origin_name='동시 수정' WHERE order_seq=1001");return original(...args); };
    const database={transaction:async work=> { const c=await pool.connect();try { await c.query('BEGIN');const value=await work(c);await c.query('COMMIT');return value; } catch(error) { await c.query('ROLLBACK');throw error; } finally { c.release(); } }};
    const service=new OrdersService(database,repository,{});
    const old=(await pool.query('SELECT version FROM orders WHERE order_seq=1001')).rows[0].version;
    const detail=await service.detail(1,1001);assert.equal(detail.version,old);assert.equal(detail.parcels[0].origin.name,'수정 전');
    const current=await original(pool,1001,null);assert.ok(current.version>old);assert.equal(current.parcels[0].origin.name,'동시 수정');
  });
  await t.test('call end and customer withdrawal wait until the authorized order snapshot is read',async()=> {
    // Expired-row checks are finished; their table locks must not block this deliberate gate.
    for(const client of retention.splice(0)) { await client.query('ROLLBACK');client.release(); }
    const blocker=await databases.order.connect();let pending;
    async function blocked(db,pattern) { for(let i=0;i<200;i++) { if((await db.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE $1) AS blocked",[pattern])).rows[0].blocked) return;await pause(10); }assert.fail('query was not blocked: '+pattern); }
    try {
      await blocker.query('BEGIN');await blocker.query("SET LOCAL lock_timeout='2s'");
      await blocker.query('LOCK TABLE orders IN ACCESS EXCLUSIVE MODE');
      pending=fetch(sides[1].base+'/api/orders/1001',{headers:ai(1011),signal:AbortSignal.timeout(20000)});
      await blocked(databases.order,'SELECT jsonb_build_object%');
      const ended=databases.consultation.query("UPDATE call_sessions SET ended_at='2030-01-02T00:00:00Z',started_at='2030-01-01T00:00:00Z' WHERE call_session_seq=1011");
      const withdrawn=databases.customer.query("UPDATE customers SET status='WITHDRAWN' WHERE customer_seq=1");
      await blocked(databases.consultation,'UPDATE call_sessions SET ended_at%');await blocked(databases.customer,'UPDATE customers SET status=%');
      await blocker.query('COMMIT');
      const response=await pending;assert.equal(response.status,200);assert.equal((await response.json()).data.orderSeq,1001);
      await Promise.all([ended,withdrawn]);
      const denied=await fetch(sides[1].base+'/api/orders/1001',{headers:ai(1011)});assert.equal(denied.status,409);
      await databases.consultation.query('UPDATE call_sessions SET ended_at=NULL,started_at=NULL WHERE call_session_seq=1011');
      await databases.customer.query("UPDATE customers SET status='ACTIVE' WHERE customer_seq=1");
    } finally { await blocker.query('ROLLBACK');blocker.release();await pending?.catch(()=>{}); }
  });
  console.log('Compared HTTP requests: '+compared);
});
