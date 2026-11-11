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
      for(const db of [databases.monolith,databases.customer]){
        await db.query('DELETE FROM memberships WHERE membership_seq BETWEEN 6101 AND 6105');
        await db.query('DELETE FROM organizations WHERE organization_seq BETWEEN 6001 AND 6003');
      }
      for(const db of [databases.monolith,databases.order])await db.query('DELETE FROM organization_billing_months WHERE organization_seq BETWEEN 6001 AND 6003');
      for(const db of [databases.monolith,databases.consultation])await db.query("DELETE FROM call_sessions WHERE provider_call_id LIKE 'draft-reference-%'");
    } finally { await Promise.all(Object.values(databases).map(db=>db.end())); }
  });
  const reference=databases.monolith;
  const owners={operations:['admin_users','admin_sessions','audit_logs'],customer:['customers','personal_pins','organizations','memberships'],consultation:['call_sessions'],order:orderTables};
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
  for(const db of [reference,databases.customer]){
    for(const [id,status,deleted]of [[6001,'INACTIVE',null],[6002,'ACTIVE','2026-01-01Z'],[6003,'ACTIVE',null]])await db.query(
      "INSERT INTO organizations(organization_seq,name,status,created_at,deleted_at) OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,'2025-01-01Z',$4)",[id,'현재 기업 '+id,status,deleted]);
    for(const [id,customer,org,status,deleted]of [[6101,1,6001,'INACTIVE',null],[6102,3,6001,'ACTIVE',null],[6103,4,6001,'ACTIVE',null],[6104,2,6002,'ACTIVE',null],[6105,5,6003,'ACTIVE','2026-01-01Z']])await db.query(
      "INSERT INTO memberships(membership_seq,customer_seq,organization_seq,employee_no,status,deleted_at) OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4,$5,$6)",[id,customer,org,'00'+id,status,deleted]);
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
    for(const path of ['/api/orders','/api/orders/{id}','/api/admin/orders','/api/customers/{id}/addresses','/api/payments/requests/{id}','/api/parcel-drafts','/api/parcel-drafts/{id}']) {
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
    const counts={all:0,incomplete:0,notPaid:0,paid:0,accepted:0,submissionFailed:0,cancelled:0};
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
  await t.test('parcel draft read scopes preserve stored and anonymous callers and hold authorization locks',async()=>{
    const {createServer}=require('node:http'),{networkInterfaces}=require('node:os');
    const {requestDraftRead}=require('@dva/events/order-read.cjs');
    const {requestDraftReadCall}=require('@dva/events/parcel-drafts.cjs');
    const {requestReferences}=require('@dva/events/call-read-references.cjs');
    const address=Object.values(networkInterfaces()).flat().find(row=>row.family==='IPv4'&&!row.internal)?.address;
    const base='http://consultation-app:3004',token=process.env.CUSTOMER_AUTH_TOKEN;
    // Keep 120KB Unicode payloads without glibc comparing two long repeated Hangul prefixes.
    const longPhone='scope:'+'입'.repeat(39998);assert.equal(Buffer.byteLength(longPhone),120000);
    const cases=[[15001,1,'different stored phone',true,'2030-01-01Z',false,null,200,1],
      [15002,null,'01000000001',true,'2030-01-01Z',false,null,200,1],
      [15003,null,'unknown caller',true,'2030-01-01Z',false,null,200,null],
      [15004,3,'01000000003',true,'2030-01-01Z',false,null,403,null],
      [15005,4,'01000000004',true,'2030-01-01Z',false,null,403,null],
      [15006,null,null,true,'2030-01-01Z',false,null,403,null],
      [15007,1,'01000000001',false,'2030-01-01Z',false,null,409,null],
      [15008,1,'01000000001',true,null,false,null,404,null],
      [15009,1,'01000000001',true,'2010-01-01Z',false,null,404,null],
      [15010,1,'01000000001',true,'2030-01-01Z',true,null,200,1],
      [15011,1,'01000000001',true,'2030-01-01Z',false,'2030-01-02Z',404,null],
      [15012,null,longPhone,true,'2030-01-01Z',false,null,200,null]];
    for(const db of [reference,databases.consultation])for(const [id,customer,phone,enabled,incoming,ended,deleted]of cases)await db.query(
      `INSERT INTO call_sessions(call_session_seq,provider_call_id,customer_seq,caller_phone_number,order_intake_enabled,incoming_at,registered_at,started_at,ended_at,deleted_at)
       OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4,$5,$6,'2030-01-01Z',CASE WHEN $7 THEN '2030-01-01Z'::timestamptz ELSE NULL END,CASE WHEN $7 THEN '2030-01-02Z'::timestamptz ELSE NULL END,$8)`,
      [id,'draft-read-scope-'+id,customer,phone,enabled,incoming,ended,deleted]);
    const retained=[];for(const db of [reference,databases.consultation]){const client=await db.connect();await client.query('BEGIN');await client.query('SELECT 1 FROM call_sessions WHERE call_session_seq=15009 FOR KEY SHARE');retained.push(client);}
    let hold=false,arrivals=[],entered,release;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);let pending=[],updates=[];
    const packet=id=>({eventId:randomUUID(),source:'order',eventType:'ParcelDraftReadRequested',payload:{command:{operation:'ParcelDraftsListed',id:null,callSessionSeq:id,query:{limit:20,offset:0,status:'ALL',callSessionSeq:id??2147483647}},orderAddress:address}});
    const server=createServer(async(req,res)=>{
      try{
        assert.equal(req.url,'/internal/parcel-draft-read');assert.equal(req.headers.authorization,'Bearer '+token);
        const chunks=[];for await(const chunk of req)chunks.push(chunk);const bytes=Buffer.concat(chunks);assert.ok(bytes.length<4096);const event=JSON.parse(bytes);
        assert.equal(event.source,'customer');const id=event.payload.command.callSessionSeq;
        assert.equal(event.payload.customerSeq,id===null?null:cases.find(c=>c[0]===id)[8]);
        if(hold){arrivals.push(event.eventId);if(arrivals.length===5)entered();await gate;}
        if(id!==null){const call=await requestDraftReadCall(base+'/internal/parcel-draft-read/call',token,id,event.eventId);
          assert.equal(call.callerPhoneNumber,cases.find(c=>c[0]===id)[2]);if(hold)assert.equal(call.endedAt,null);
          await assert.rejects(requestDraftReadCall(base+'/internal/parcel-draft-read/call',token,1101,event.eventId));}
        await requestReferences('customer','http://customer-app:3001/internal/call-read-references/for-orders',token,[1],'order',event.eventId);
        res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({eventId:event.eventId,status:'processed',payload:{data:[],hasNext:false,total_count:0}}));
      }catch(error){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:String(error)}));}
    });
    await new Promise(r=>server.listen(3002,'0.0.0.0',r));
    const post=(path,event,auth=token,scope)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+auth,...(scope===undefined?{}:{'X-Msa-Read-Scope':scope})},body:JSON.stringify(event),signal:AbortSignal.timeout(30000)});
    try{
      for(const id of [null,...cases.map(c=>c[0])]){
        const expected=id===null?200:cases.find(c=>c[0]===id)[7];
        const original=await fetch(sides[0].base+'/api/parcel-drafts?status=ALL&callSessionSeq='+(id??2147483647),{headers:{Authorization:'Bearer '+process.env.PGPASSWORD,...(id===null?headers:ai(id))}});
        const oracle=await original.json();assert.equal(original.status,expected,'source context '+id);
        const response=await post('/internal/parcel-draft-read',packet(id));const body=await response.json();assert.equal(response.status,expected,'context '+id+' '+JSON.stringify(body));
        if(expected===200)assert.deepEqual(body.payload,oracle);else assert.deepEqual(body.error,oracle.error);
      }
      assert.equal((await post('/internal/parcel-draft-read',packet(15001),'wrong')).status,403);
      assert.equal((await post('/internal/parcel-draft-read',{...packet(15001),source:'customer'})).status,422);
      const lookup={eventId:randomUUID(),source:'order',eventType:'ParcelDraftReadCallRequested',payload:{callSessionSeq:15001}};
      assert.equal((await post('/internal/parcel-draft-read/call',lookup,token,randomUUID())).status,503);
      assert.equal((await post('/internal/parcel-draft-read/call',lookup,token,'invalid')).status,422);
      for(const kind of ['call','customer']){
        let oracle;
        for(const side of ['source','msa']){
          const db=kind==='call'?(side==='source'?reference:databases.consultation):(side==='source'?reference:databases.customer);
          const client=await db.connect();let reading;
          try{
            await client.query('BEGIN');
            await client.query(kind==='call'?"UPDATE call_sessions SET order_intake_enabled=false WHERE call_session_seq=15001":"UPDATE customers SET status='WITHDRAWN' WHERE customer_seq=1");
            reading=side==='source'?fetch(sides[0].base+'/api/parcel-drafts?status=ALL&callSessionSeq=15001',{headers:{Authorization:'Bearer '+process.env.PGPASSWORD,...ai(15001)}}):post('/internal/parcel-draft-read',packet(15001));
            const pattern=kind==='call'?'%FROM call_sessions WHERE %FOR SHARE%':'%FROM customers WHERE %FOR SHARE%';
            let blocked=false;for(let i=0;i<200;i++){if((await db.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE $1) AS blocked",[pattern])).rows[0].blocked){blocked=true;break;}await pause(10);}assert.ok(blocked,side+' pending '+kind+' authorization');
            await client.query('COMMIT');
            const response=await reading,body=await response.json();assert.equal(response.status,kind==='call'?409:403,side+' observes committed '+kind+' '+JSON.stringify(body));
            if(side==='source')oracle=body.error;else assert.deepEqual(body.error,oracle);
          } finally {
            await client.query('ROLLBACK');client.release();await reading?.catch(()=>{});
            await db.query(kind==='call'?"UPDATE call_sessions SET order_intake_enabled=true WHERE call_session_seq=15001":"UPDATE customers SET status='ACTIVE' WHERE customer_seq=1");
          }
        }
      }
      hold=true;pending=Array.from({length:5},()=>post('/internal/parcel-draft-read',packet(15001)));
      let timer;try{await Promise.race([ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('draft pools did not enter')),10000);})]);}finally{clearTimeout(timer);}
      updates=[databases.consultation.query("UPDATE call_sessions SET ended_at='2030-01-02Z',started_at='2030-01-01Z' WHERE call_session_seq=15001"),databases.customer.query("UPDATE customers SET status='WITHDRAWN' WHERE customer_seq=1")];
      for(const [db,pattern]of [[databases.consultation,'UPDATE call_sessions SET ended_at%'],[databases.customer,'UPDATE customers SET status=%']]){
        let blocked=false;for(let i=0;i<200;i++){if((await db.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE $1) AS blocked",[pattern])).rows[0].blocked){blocked=true;break;}await pause(10);}assert.ok(blocked,'authorization update was not blocked');
      }
      release();for(const response of await Promise.all(pending)){const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));}await Promise.all(updates);
      hold=false;assert.equal((await post('/internal/parcel-draft-read',packet(15001))).status,403);
      for(const scope of arrivals)assert.equal((await post('/internal/parcel-draft-read/call',lookup,token,scope)).status,503);
    } finally {
      release();await Promise.allSettled(pending);await Promise.allSettled(updates);await new Promise(r=>server.close(r));
      await databases.customer.query("UPDATE customers SET status='ACTIVE' WHERE customer_seq=1");
      for(const client of retained){await client.query('ROLLBACK');client.release();}
      for(const db of [reference,databases.consultation])await db.query("DELETE FROM call_sessions WHERE provider_call_id LIKE 'draft-read-scope-%'");
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
    for(const group of ['COLLECTING','notPaid','PAID','ACCEPTED','SUBMISSION_FAILED','CANCELLED']) await compare('/api/admin/orders?statusGroup='+group);
    for(const organization of [6001,6002,6003,2147483647])for(const group of ['', '&statusGroup=COLLECTING','&statusGroup=PAID','&statusGroup=CANCELLED'])await compare('/api/admin/orders?organizationSeq='+organization+group+'&limit=1&offset=1');
    for(const query of ['?organizationSeq=0','?organizationSeq=2147483648','?organizationSeq=1&organizationSeq=2'])await compare('/api/admin/orders'+query,400);
    const original=await compare('/api/admin/orders?limit=1&offset=1');
    for(const query of ['?limit=100','?limit=1&offset=999','?statusGroup=PAID','?statusGroup=COLLECTING'])assert.deepEqual((await compare('/api/admin/orders'+query)).statusCounts,original.statusCounts);
    const path='/api/admin/orders?limit=2',requestId=randomUUID(),expected=await request(sides[0],path,200,headers,requestId);
    await Promise.all(Array.from({length:12},async()=>assert.deepEqual(await request(sides[1],path,200,headers,requestId),expected)));
    await compare('/api/admin/orders',401,{});
    try {
      for(const db of [reference,databases.order])await db.query(`INSERT INTO order_parcel_drafts(draft_seq,reserved_order_seq,client_parcel_id,created_by_admin_user_seq,creation_payload,parcel_data,status,created_at,updated_at,retention_started_at)
        OVERRIDING SYSTEM VALUE SELECT 14000+n,40000+n,gen_random_uuid(),1,'{}','{"origin":{"name":"분할 초안 한글_%","phoneNumber":"01098765432"},"documentCount":2,"otherItemDescription":"메모"}'::jsonb,
        'INCOMPLETE','2030-01-01Z','2030-01-01Z','2030-01-01Z' FROM generate_series(1,251) n`);
      for(const query of ['?q='+encodeURIComponent('분할 초안 한글_%'),'','?statusGroup=COLLECTING','?q=010-9876-5432'])for(const offset of [0,249,250,251])await compare('/api/admin/orders'+(query||'?')+(query?'&':'')+'limit=1&offset='+offset);
    } finally {for(const db of [reference,databases.order])await db.query('DELETE FROM order_parcel_drafts WHERE draft_seq BETWEEN 14001 AND 14251');}

  });
  await t.test('parcel draft public reads preserve snapshots, all statuses, caller scope and filtered totals',async()=>{
    const largePhone='reads:'+'입'.repeat(39998),retained=[];assert.equal(Buffer.byteLength(largePhone),120000);
    const old=(await reference.query("SELECT to_jsonb(clock_timestamp()-interval '2 days')#>>'{}' AS instant")).rows[0].instant;
    const contexts=[
      {id:16001,customer:1,phone:'different stored phone'}, {id:16002,customer:null,phone:'01000000001'},
      {id:16003,customer:1,phone:'01000000001',ended:true}, {id:16004,customer:2,phone:'01000000002'},
      {id:16005,customer:null,phone:'anonymous repeated'}, {id:16006,customer:null,phone:'anonymous repeated'},
      {id:16007,customer:null,phone:'anonymous repeated',ended:true},{id:16008,customer:null,phone:largePhone},
      {id:16009,customer:null,phone:null},{id:16010,customer:3,phone:'01000000001'},
      {id:16011,customer:4,phone:'01000000001'},{id:16012,customer:null,phone:'01000000003'},
      {id:16013,customer:1,phone:'01000000001',enabled:false},{id:16014,customer:1,phone:'01000000001',deleted:true},
      {id:16015,customer:1,phone:'01000000001',missingIncoming:true},{id:16016,customer:1,phone:'01000000001',expired:true},
      {id:16017,customer:1,phone:'01000000001',ended:true,finalized:true},{id:16018,customer:1,phone:'01000000001',ended:true,order:1006},
    ];
    const rows=[
      {id:17001,status:'READY',call:16001},{id:17002,status:'EDITING',call:16001},{id:17003,status:'INCOMPLETE',call:16001},
      {id:17004,status:'RESUMED',call:16001},{id:17005,status:'READY',source:17004,reserved:72004},
      {id:17006,status:'CANCELLED',call:16001},{id:17007,status:'CONVERTED',call:16001,order:1006,parcel:20061,reserved:1006},
      {id:17008,status:'READY',call:16004,customer:2},{id:17009,status:'READY',call:16005,customer:null,phone:'anonymous repeated'},
      {id:17010,status:'INCOMPLETE',customer:null,phone:'anonymous repeated'}, {id:17011,status:'READY',customer:null,phone:'anonymous repeated'},
      {id:17012,status:'INCOMPLETE',call:16006,customer:null,phone:'anonymous repeated'}, {id:17013,status:'INCOMPLETE',customer:4},
      {id:17014,status:'READY',call:16003},{id:17015,status:'EDITING',customer:3},{id:17016,status:'READY',deleted:true},
      {id:17017,status:'READY',retention:'2010-01-01Z'},{id:17018,status:'INCOMPLETE',retention:old},
      {id:17020,status:'RESUMED',call:16001},{id:17019,status:'READY',source:17020,reserved:72020,retention:old},
      {id:17021,status:'READY',retention:old},{id:17022,status:'INCOMPLETE',call:1101},
      {id:17023,status:'INCOMPLETE',customer:null,phone:largePhone}, {id:17024,status:'READY',legacy:999999},
      {id:17025,status:'CONVERTED',call:16018,order:1006,parcel:20062,reserved:88001},
      {id:17026,status:'INCOMPLETE',customer:null,phone:'01000000003'},
      {id:17027,status:'READY',call:16007,customer:null,phone:'anonymous repeated'},
    ];
    const uuids=new Map(rows.map(row=>[row.id,randomUUID()]));
    const party={name:'보존 한글_%',phoneNumber:'01098765432',roadAddress:'서울 도로',jibunAddress:'서울 지번',detailAddress:null,dongName:null,postalCode:'00123'};
    try {
      for(const db of [reference,databases.consultation])for(const c of contexts)await db.query(`INSERT INTO call_sessions(call_session_seq,provider_call_id,customer_seq,caller_phone_number,order_seq,incoming_at,registered_at,started_at,ended_at,deleted_at,
        order_intake_enabled,order_intake_version,order_completion_received_at,order_completion_payload,order_finalized_at,order_finalization_result)
        OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4,$5,$6,'2032-01-01Z',CASE WHEN $7 THEN '2032-01-01Z'::timestamptz ELSE NULL END,CASE WHEN $7 THEN '2032-01-02Z'::timestamptz ELSE NULL END,$8,$9,7,
        CASE WHEN $10 THEN '2032-01-02Z'::timestamptz ELSE NULL END,CASE WHEN $10 THEN '{}'::jsonb ELSE NULL END,
        CASE WHEN $10 THEN '2032-01-03Z'::timestamptz ELSE NULL END,CASE WHEN $10 THEN '{}'::jsonb ELSE NULL END)`,
        [c.id,'draft-public-'+c.id,c.customer,c.phone,c.order??null,c.missingIncoming?null:c.expired?'2010-01-01Z':c.finalized?'2031-01-01Z':'2032-01-01Z',!!c.ended,c.deleted?'2032-01-02Z':null,c.enabled!==false,!!c.finalized]);
      for(const db of [reference,databases.consultation]){const client=await db.connect();await client.query('BEGIN');await client.query('SELECT 1 FROM call_sessions WHERE call_session_seq=16016 FOR KEY SHARE');retained.push(client);}
      for(const db of [reference,databases.order])for(const d of rows){
        const parcel={origin:party,destination:{...party,name:'Alice_100%',detailAddress:'1201호'},documentCount:1,smallBoxCount:0,mediumBoxCount:0,bigBoxCount:0,itemPrice:10000,notifiedPrice:3500,clientComment:'</script> & 보존',otherItemDescription:'문서',originPin:null};
        await db.query(`INSERT INTO order_parcel_drafts(draft_seq,reserved_order_seq,call_session_seq,customer_seq,caller_phone_number,created_by_admin_user_seq,client_parcel_id,creation_payload,parcel_data,status,version,source_draft_seq,order_seq,order_parcel_seq,legacy_order_seq,legacy_order_parcel_seq,created_at,updated_at,retention_started_at,deleted_at)
          OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4,$5,$6,$7,'{"private":"never return"}',$8,$9,23,$10,$11,$12,$13,$14,'2032-01-01Z','2032-01-02Z',$15,$16)`,
          [d.id,d.reserved??55000+d.id,d.call??null,Object.hasOwn(d,'customer')?d.customer:1,d.phone??'01000000001',d.call?null:1,uuids.get(d.id),parcel,d.status,d.source??null,d.order??null,d.parcel??null,d.legacy??null,d.legacy?888888:null,d.retention??'2032-01-01Z',d.deleted?'2032-01-03Z':null]);
      }
      for(const query of ['', '?status=ALL','?limit=1','?offset=999','?status=ALL&limit=2&offset=1','?customerSeq=1','?customerSeq=4','?callSessionSeq=16001','?legacyOrderSeq=999999',
        '?q='+encodeURIComponent('한글'),'?q=010-9876-5432','?q=%25','?q=_','?q=%27%20OR%201%3D1--','?from=2032-01-01T00:00:00Z&to=2033-01-01T00:00:00Z'])await compare('/api/parcel-drafts'+query);
      for(const status of ['READY','EDITING','INCOMPLETE','CONVERTED','CANCELLED','RESUMED'])await compare('/api/parcel-drafts?status='+status);
      for(const company of [6001,6002,6003,2147483647])await compare('/api/parcel-drafts?status=ALL&organizationSeq='+company);
      for(const row of rows)await compare('/api/parcel-drafts/'+row.id,[17016,17017,17018,17019,17022].includes(row.id)?404:200);
      const admin=await compare('/api/parcel-drafts/17013');assert.equal(admin.data.customerSeq,4);assert.equal(admin.data.intakeVersion,null);assert.ok(!Object.hasOwn(admin.data,'creationPayload'));
      for(const role of tokens)await compare('/api/parcel-drafts?status=ALL&limit=1',200,{Cookie:'dva_session='+role,call_session_seq:'ignored-for-admin'});
      for(const [call,id,status]of [[16001,17001,200],[16001,17008,404],[16001,17024,200],[16002,17001,200],
        [16003,17014,200],[16003,17001,404],[16005,17009,200],[16005,17010,200],[16005,17011,404],
        [16006,17012,200],[16007,17027,200],[16007,17010,404],[16008,17023,200],[16012,17026,200],[16017,17001,404],[16018,17025,200]]){
        const value=await compare('/api/parcel-drafts/'+id,status,ai(call));if(status===200)assert.equal(value.data.intakeVersion,7);
      }
      for(const call of [16001,16002,16003,16005,16007,16008,16012,16017,16018])await compare('/api/parcel-drafts?status=ALL',200,ai(call));
      for(const query of ['?status=ALL&customerSeq=2','?status=ALL&customerSeq=4'])await compare('/api/parcel-drafts'+query,403,ai(16001));
      await compare('/api/parcel-drafts?customerSeq=1',403,ai(16005));
      await compare('/api/parcel-drafts?status=ALL&callSessionSeq=16001',200,ai(16003));
      for(const [call,status]of [[16009,403],[16010,403],[16011,403],[16013,409],[16014,404],[16015,404],[16016,404],[2147483647,404]]){
        await compare('/api/parcel-drafts?status=ALL',status,ai(call));await compare('/api/parcel-drafts/17001',status,ai(call));
      }
      for(const query of ['?status=UNKNOWN','?status=READY&status=EDITING','?customerSeq=0','?customerSeq=1&customerSeq=2','?organizationSeq=0','?legacyOrderSeq=0','?callSessionSeq=0','?limit=101','?offset=-1','?q='+'x'.repeat(201),'?unexpected=1','?from=2032-01-01','?from=2033-01-01T00:00:00Z&to=2032-01-01T00:00:00Z'])await compare('/api/parcel-drafts'+query,400);
      await compare('/api/parcel-drafts?q='+encodeURIComponent('\0'),500);
      for(const call of [undefined,'bad','0','2147483648'])await compare('/api/parcel-drafts',400,call===undefined?{}:{call_session_seq:call});
      await compare('/api/parcel-drafts',401,{Authorization:''});await compare('/api/parcel-drafts/17001',401,{Cookie:'dva_session=bad'});
      const path='/api/parcel-drafts?status=ALL&callSessionSeq=16001&limit=1',requestId=randomUUID(),expected=await request(sides[0],path,200,ai(16001),requestId);
      await Promise.all(Array.from({length:12},async()=>assert.deepEqual(await request(sides[1],path,200,ai(16001),requestId),expected)));
      try{
        const ids=Array.from({length:251},(_,n)=>18001+n),keys=ids.map(()=>randomUUID());
        for(const db of [reference,databases.order])await db.query(`INSERT INTO order_parcel_drafts(draft_seq,reserved_order_seq,client_parcel_id,created_by_admin_user_seq,creation_payload,parcel_data,status,created_at,updated_at,retention_started_at)
          OVERRIDING SYSTEM VALUE SELECT n,200000+n,key,1,'{}','{"origin":{"name":"초안 분할 확인"}}','INCOMPLETE','2032-01-01Z','2032-01-01Z','2032-01-01Z' FROM unnest($1::int[],$2::uuid[]) AS entries(n,key)`,[ids,keys]);
        for(const offset of [0,249,250,251])await compare('/api/parcel-drafts?q='+encodeURIComponent('초안 분할 확인')+'&limit=1&offset='+offset);
      }finally{for(const db of [reference,databases.order])await db.query('DELETE FROM order_parcel_drafts WHERE draft_seq BETWEEN 18001 AND 18251');}
    } finally {
      for(const client of retained){await client.query('ROLLBACK');client.release();}
      for(const db of [reference,databases.order])await db.query('DELETE FROM order_parcel_drafts WHERE draft_seq BETWEEN 17001 AND 17027');
      for(const db of [reference,databases.consultation])await db.query("DELETE FROM call_sessions WHERE provider_call_id LIKE 'draft-public-%'");
    }
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
    for(const query of ['?statusGroup=UNKNOWN','?q='+encodeURIComponent('\0'),'?q='+'x'.repeat(201)]) await compare('/api/admin/orders'+query,400);
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
      pending=fetch(sides[1].base+'/api/orders/1001',{headers:{Authorization:'Bearer '+process.env.PGPASSWORD,...ai(1011)},signal:AbortSignal.timeout(20000)});
      await blocked(databases.order,'SELECT jsonb_build_object%');
      const ended=databases.consultation.query("UPDATE call_sessions SET ended_at='2030-01-02T00:00:00Z',started_at='2030-01-01T00:00:00Z' WHERE call_session_seq=1011");
      const withdrawn=databases.customer.query("UPDATE customers SET status='WITHDRAWN' WHERE customer_seq=1");
      await blocked(databases.consultation,'UPDATE call_sessions SET ended_at%');await blocked(databases.customer,'UPDATE customers SET status=%');
      await blocker.query('COMMIT');
      const response=await pending;assert.equal(response.status,200);assert.equal((await response.json()).data.orderSeq,1001);
      await Promise.all([ended,withdrawn]);
      const denied=await fetch(sides[1].base+'/api/orders/1001',{headers:{Authorization:'Bearer '+process.env.PGPASSWORD,...ai(1011)}});assert.equal(denied.status,409);
      await databases.consultation.query('UPDATE call_sessions SET ended_at=NULL,started_at=NULL WHERE call_session_seq=1011');
      await databases.customer.query("UPDATE customers SET status='ACTIVE' WHERE customer_seq=1");
    } finally { await blocker.query('ROLLBACK');blocker.release();await pending?.catch(()=>{}); }
  });
  await t.test('payment notification retries and workers preserve queue, audit and delivery outcomes', async () => {
    const id = n => '00000000-0000-4000-8000-'+String(n).padStart(12,'0');
    const pending=id(1), paid=id(4), expired=id(3), requests=[];
    const path=(key,completion=false)=>'/api/payments/notifications/'+key+(completion?'/completion':'')+'/retry';
    async function post(url,expected,extra={},body={}) {
      const requestId=randomUUID();
      requests.push(requestId);
      const results=[];
      for (const side of sides) {
        const response=await fetch(side.base+url,{method:'POST',signal:AbortSignal.timeout(15000),
          headers:{...headers,Origin:'http://localhost:5173','Content-Type':'application/json','X-Request-Id':requestId,...extra},
          body:JSON.stringify(body)});
        const result=await response.json();
        assert.equal(response.status,expected,side.name+' '+url+' '+JSON.stringify(result));
        results.push(result);
      }
      assert.deepEqual(results[1],results[0],url);
      return results[0].data;
    }
    const docs=await Promise.all(sides.map(async side=>(await fetch(side.base+'/api/docs-json')).json()));
    for(const route of [path('{id}'),path('{id}',true)])
      assert.deepEqual(docs[1].paths[route].post,docs[0].paths[route].post,route);
    assert.deepEqual(docs[1].components.schemas.EmptyPaymentDto,docs[0].components.schemas.EmptyPaymentDto);

    await post(path(pending),401,{Cookie:''});
    await post(path(pending),403,{Origin:'http://wrong.invalid'});
    await post(path(pending),400,{}, {unexpected:true});
    await post(path(id(999)),404);
    await post(path(expired),409);
    await post(path(pending,true),409);
    for(let repeat=0;repeat<2;repeat++) {
      assert.equal((await post(path(pending),200)).notificationStatus,'PENDING');
      assert.equal((await post(path(paid,true),200)).completionNotificationStatus,'PENDING');
    }

    const messages=[];
    const server=require('node:http').createServer(async(req,res)=>{
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const text=JSON.parse(Buffer.concat(chunks)).text;
      messages.push(text);
      res.writeHead(text.includes('/p/'+paid)?503:200);
      res.end('ok');
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const outputs=[];
    try {
      for (const [db,runtime,mono] of [[reference,'./monolith-runtime',true],[databases.order,'../dist',false]]) {
        await db.query("UPDATE order_payment_requests SET notification_status='SENDING',notification_attempted_at=clock_timestamp()-interval '46 seconds' WHERE payment_request_id=$1",[expired]);
        const database={pool:db,async transaction(work) {
          const client=await db.connect();
          try {await client.query('BEGIN');const result=await work(client);await client.query('COMMIT');return result;}
          catch(error){await client.query('ROLLBACK');throw error;}
          finally{client.release();}
        }};
        const config={get(key){return {
          ORDER_PAYMENTS_ENABLED:true, PAYMENT_PUBLIC_URL:'https://payments.example.test/api/payments',
          PAYMENT_MATTERMOST_WEBHOOK_URL:'http://127.0.0.1:'+server.address().port+'/notice',
        }[key];}};
        const {PaymentsRepository}=require(runtime+'/payments/payments.repository');
        const {PaymentsService}=require(runtime+'/payments/payments.service');
        const {PaymentsWorker}=require(runtime+'/payments/payments.worker');
        const {PaymentClient}=require(runtime+'/payments/payment.client');
        const repository=new PaymentsRepository(database);
        const client=new PaymentClient(config);
        const service=mono
          ? new PaymentsService(config,repository,client,new (require(runtime+'/orders/order-payments.repository').OrderPaymentsRepository)(undefined,database))
          : new PaymentsService(config,repository,database,undefined,client);
        const worker=new PaymentsWorker(config,service,repository);
        messages.length=0;
        const current=worker.run();
        assert.equal(worker.run(),current);
        await current;
        await worker.run();
        assert.equal(messages.length,2,'no automatic re-send of uncertain notification');
        assert.ok(messages[0].includes('/p/'+paid)&&messages[1].includes('/p/'+pending));
        outputs.push([...messages]);
        const state=(await db.query(`SELECT payment_request_id AS id,notification_status AS initial,
          completion_notification_status AS completion,notification_sent_at IS NOT NULL AS sent
          FROM order_payment_requests WHERE payment_request_id=ANY($1::uuid[]) ORDER BY payment_request_id`,[[pending,paid,expired]])).rows;
        assert.deepEqual(state,[
          {id:pending,initial:'SENT',completion:'WAITING',sent:true},
          {id:expired,initial:'UNKNOWN',completion:'WAITING',sent:false},
          {id:paid,initial:'SENT',completion:'UNKNOWN',sent:false},
        ]);
      }
    } finally { await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
    assert.deepEqual(outputs[1],outputs[0],'identical Mattermost message payloads');
    const audit=async db=>(await db.query(`SELECT request_id,action,result,target_type,target_seq,actor_type,actor_seq,metadata
      FROM audit_logs WHERE request_id=ANY($1::uuid[]) ORDER BY request_id,action`,[requests])).rows;
    const expected=await audit(reference);
    assert.deepEqual(await audit(databases.operations),expected);
    assert.deepEqual(expected.filter(row=>row.result==='SUCCESS').map(row=>row.target_seq).sort(),[1002,1006]);
    assert.equal((await post(path(paid,true),200)).completionNotificationStatus,'PENDING');
    t.diagnostic('notification HTTP pairs: '+requests.length+'; actual worker claims, stale SENDING and exact webhook messages');
  });
  await t.test('order submission retry preserves the Dver request and recovers an unacknowledged shipment', async () => {
    const path='/api/admin/orders/{id}/retry', requests=[];
    const docs=await Promise.all(sides.map(async side=>(await fetch(side.base+'/api/docs-json')).json()));
    assert.deepEqual(docs[1].paths[path].post,docs[0].paths[path].post);
    assert.deepEqual(docs[1].components.schemas.SubmittedOrderDto,docs[0].components.schemas.SubmittedOrderDto);
    async function post(id,expected,extra={}) {
      const requestId=randomUUID(), results=[];
      requests.push(requestId);
      for(const side of sides) {
        const response=await fetch(side.base+path.replace('{id}',id),{method:'POST',
          signal:AbortSignal.timeout(15000),
          headers:{...headers,Origin:'http://localhost:5173','X-Request-Id':requestId,...extra}});
        const result=await response.json();
        assert.equal(response.status,expected,side.name+' '+id+' '+JSON.stringify(result));
        results.push(result);
      }
      assert.deepEqual(results[1],results[0]);
      return results[0].data;
    }
    await post(1005,401,{Cookie:''});
    await post(1005,403,{Origin:'http://wrong.invalid'});
    await post(0,400);
    await post(99999,404);
    await post(1002,409);
    await post(1007,422);
    assert.deepEqual(await post(1004,200),{status:'SUBMITTING'});
    assert.deepEqual(await post(1006,200),{status:'ACCEPTED'});
    for(const db of [reference,databases.consultation])
      await db.query('UPDATE call_sessions SET order_seq=1005,order_intake_enabled=true WHERE call_session_seq=1011');
    await post(1005,409);
    for(const db of [reference,databases.consultation])
      await db.query('UPDATE call_sessions SET order_seq=NULL WHERE call_session_seq=1011');
    for(const db of [reference,databases.order]) {
      const client=await db.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL session_replication_role='replica'");
        await client.query("UPDATE order_parcels SET item_price=1000 WHERE order_parcel_seq=20051");
        await client.query("UPDATE order_parcels SET status='CANCELLED' WHERE order_parcel_seq=20052");
        await client.query('UPDATE orders SET total_amount=3500 WHERE order_seq=1005');
        await client.query('COMMIT');
      } catch(error) {await client.query('ROLLBACK');throw error;}
      finally {client.release();}
    }
    for(const runtime of ['./monolith-runtime','../dist']) {
      const {DverClient}=require(runtime+'/orders/dver.client');
      assert.throws(()=>new DverClient({get:()=>undefined}).ensureConfigured(),error=>error.getStatus()===503);
    }

    const providerRequests=[], deliveryRequests=[];
    let dropped=false;
    const server=require('node:http').createServer(async(req,res)=>{
      try {
        const chunks=[];
        for await(const chunk of req)chunks.push(chunk);
        const body=Buffer.concat(chunks).toString();
        if(req.url==='/parcel') {
          providerRequests.push({key:req.headers['x-api-key'],body:JSON.parse(body)});
          res.writeHead(200,{'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:true,parcelNo:'RETRY001',receivedAt:'2030-03-01T00:00:00Z'}));
          return;
        }
        assert.equal(req.url,'/internal/order-accepted');
        const ack=await fetch('http://delivery-app:3003'+req.url,{method:'POST',
          headers:{'Content-Type':'application/json',Authorization:req.headers.authorization},body});
        const result=await ack.json();
        deliveryRequests.push({event:JSON.parse(body),status:ack.status,result});
        if(!dropped && ack.ok) {dropped=true;res.destroy();return;}
        res.writeHead(ack.status,{'Content-Type':'application/json'});
        res.end(JSON.stringify(result));
      } catch {res.writeHead(500).end();}
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const delivery=new Pool({host:'delivery-db',user:'delivery_app'});
    const orderResult=async db=>(await db.query(
      'SELECT status,parcel_no,dver_received_at,paid_at,pickup_requested_at,total_amount,version FROM orders WHERE order_seq=1005',
    )).rows[0];
    const shipment=async db=>(await db.query(
      "SELECT order_parcel_seq,s.status,h.from_status,h.to_status,h.actor_type,tracking_number LIKE 'DVA-%' AS generated"+
      ' FROM shipments s JOIN shipment_status_history h USING(shipment_seq) WHERE order_parcel_seq=ANY($1::int[])',
      [[20051,20052]],
    )).rows;
    const submitId=randomUUID();
    requests.push(submitId);
    try {
      for(const [runtime,owner,mono] of [['./monolith-runtime','monolith',true],['../dist','order',false]]) {
        const local='http://127.0.0.1:'+server.address().port;
        const config={get(key){return {
          NODE_ENV:'test',DB_HOST:owner+'-db',DB_PORT:5432,DB_USER:owner+'_app',
          DB_PASSWORD:process.env.PGPASSWORD,DB_NAME:process.env.PGDATABASE,
          DVER_API_URL:local+'/parcel',DVER_API_KEY:'parity-dver-key',DELIVERY_URL:local,
          CUSTOMER_AUTH_TOKEN:process.env.CUSTOMER_AUTH_TOKEN,OPERATIONS_URL:'http://operations-app:3005',
          CONSULTATION_URL:'http://consultation-app:3004',
        }[key];}};
        const {DatabaseService}=require(runtime+'/database/database.service');
        const {AuditService}=require(runtime+'/audit/audit.service');
        const {OrdersRepository}=require(runtime+'/orders/orders.repository');
        const {OrderSubmissionRepository}=require(runtime+'/orders/order-submission.repository');
        const {OrderSubmissionService}=require(runtime+'/orders/order-submission.service');
        const {DverClient}=require(runtime+'/orders/dver.client');
        const database=new DatabaseService(config), repository=new OrdersRepository(), dver=new DverClient(config);
        try {
          if(mono) {
            const {AuditRepository}=require(runtime+'/audit/audit.repository');
            const {DeliveriesService}=require(runtime+'/deliveries/deliveries.service');
            const {DeliveriesRepository}=require(runtime+'/deliveries/deliveries.repository');
            const service=new OrderSubmissionService(database,repository,new AuditService(new AuditRepository(database)),
              new OrderSubmissionRepository(new DeliveriesService(new DeliveriesRepository())),dver);
            assert.deepEqual(await service.retry(1005,1,submitId),{status:'ACCEPTED'});
          } else {
            const {OrderDeletionCheckClient}=require(runtime+'/orders/order-deletion-check.client');
            const {OrderSubmissionWorker}=require(runtime+'/orders/order-submission.worker');
            const audit=new AuditService(database,config);
            const makeService=()=>new OrderSubmissionService(database,repository,audit,
              new OrderSubmissionRepository(),dver,new OrderDeletionCheckClient(config),config);
            assert.deepEqual(await makeService().retry(1005,1,submitId),{status:'SUBMITTING'});
            assert.equal((await orderResult(databases.order)).status,'SUBMITTING');
            assert.deepEqual(await shipment(delivery),await shipment(reference),'shipment transaction survived acknowledgement loss');
            const worker=new OrderSubmissionWorker(makeService(),config,database,repository,audit,{run:async()=>{}},{recoverPending:async()=>{}});
            await worker.run();
            await worker.run();
            assert.equal((await orderResult(databases.order)).status,'ACCEPTED');
          }
        } finally {await database.onModuleDestroy();}
      }
      assert.equal(providerRequests.length,2);
      assert.equal(providerRequests[0].body.outboundParcels.length,1);
      assert.deepEqual(providerRequests[1],providerRequests[0]);
      assert.deepEqual(await orderResult(databases.order),await orderResult(reference));
      assert.equal(deliveryRequests.length,2);
      assert.deepEqual(deliveryRequests.map(x=>[x.status,x.result.status]),[[200,'processed'],[200,'duplicate']]);
      assert.deepEqual(deliveryRequests[1].event,deliveryRequests[0].event);
      assert.deepEqual(await shipment(delivery),[{order_parcel_seq:20051,status:'paid',from_status:null,to_status:'paid',actor_type:'SYSTEM',generated:true}]);
      const {rows}=await databases.order.query('SELECT delivered_at IS NOT NULL AS confirmed FROM outbox_events WHERE event_id=$1',[deliveryRequests[0].event.eventId]);
      assert.deepEqual(rows,[{confirmed:true}]);
    } finally {
      await delivery.end();
      await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    }
    const audit=async db=>(await db.query('SELECT request_id,action,result,target_type,target_seq,actor_type,actor_seq,metadata'+
      ' FROM audit_logs WHERE request_id=ANY($1::uuid[]) ORDER BY request_id,action',[requests])).rows;
    assert.deepEqual(await audit(databases.operations),await audit(reference));
    t.diagnostic('submission HTTP pairs: '+(requests.length-1)+'; Dver request, shipment persistence and duplicate acknowledgement');
  });
  await t.test('payment approval and reconciliation preserve provider calls, paid state and delivery', async () => {
    const pending='00000000-0000-4000-8000-000000000001';
    const second='00000000-0000-4000-8000-000000000021';
    const requests=[];
    const path=(id,action)=>'/api/payments/requests/'+id+'/'+action;
    const docs=await Promise.all(sides.map(async side=>(await fetch(side.base+'/api/docs-json')).json()));
    for(const action of ['confirm','reconcile'])
      assert.deepEqual(docs[1].paths[path('{id}',action)].post,docs[0].paths[path('{id}',action)].post);
    assert.deepEqual(docs[1].components.schemas.ConfirmPaymentDto,docs[0].components.schemas.ConfirmPaymentDto);
    for(const db of [reference,databases.order]) {
      const client=await db.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL session_replication_role='replica'");
        await client.query("UPDATE order_parcels SET origin_name=COALESCE(origin_name,'발송인'),item_price=1000,notified_price=3500 WHERE order_seq=1002");
        await client.query('INSERT INTO orders(order_seq,customer_seq,payment_method_type,status,version,created_at,updated_at,creation_source,total_amount,payment_due_at,pickup_requested_at) '+
          'OVERRIDING SYSTEM VALUE SELECT 1051,customer_seq,payment_method_type,status,version,created_at,updated_at,creation_source,total_amount,payment_due_at,pickup_requested_at FROM orders WHERE order_seq=1002');
        await client.query("UPDATE orders SET payment_method_type='credit',billing_organization_seq=6001,billing_organization_name='이전 기업' WHERE order_seq=1051");
        await client.query('INSERT INTO order_parcels(order_parcel_seq,order_seq,parcel_position,origin_name,origin_phone_number,'+
          'origin_road_address,origin_jibun_address,origin_dong_name,origin_postal_code,destination_name,destination_phone_number,'+
          'destination_road_address,destination_jibun_address,destination_dong_name,destination_postal_code,document_count,item_price,notified_price) '+
          'OVERRIDING SYSTEM VALUE SELECT 20511,1051,1,origin_name,origin_phone_number,origin_road_address,origin_jibun_address,origin_dong_name,origin_postal_code,'+
          'destination_name,destination_phone_number,destination_road_address,destination_jibun_address,destination_dong_name,destination_postal_code,1,1000,7000 '+
          'FROM order_parcels WHERE order_parcel_seq=20021');
        await client.query("INSERT INTO order_payment_requests(payment_request_id,order_seq,amount,expires_at,notification_status) VALUES($1,1051,7000,'2094-01-01T00:00:00Z','SENT')",[second]);
        await client.query('COMMIT');
      } catch(error) {await client.query('ROLLBACK');throw error;}
      finally {client.release();}
    }
    const origin='https://payments.example.test';
    async function post(id,action,body,expected,extra={}) {
      const requestId=randomUUID(), results=[];
      requests.push(requestId);
      for(const side of sides) {
        const response=await fetch(side.base+path(id,action),{method:'POST',signal:AbortSignal.timeout(20000),
          headers:{Origin:origin,Cookie:'dva_session=invalid','Content-Type':'application/json','X-Request-Id':requestId,...extra},
          body:JSON.stringify(body)});
        const result=await response.json();
        assert.equal(response.status,expected,side.name+' '+action+' '+JSON.stringify(result));
        assert.equal(response.headers.get('cache-control'),'no-store');
        if(expected===200)assert.equal(response.headers.get('referrer-policy'),'no-referrer');
        results.push(result);
      }
      assert.deepEqual(results[1],results[0],action+' '+id);
      return results[0].data;
    }
    const input=(id,key)=>({orderId:id,amount:7000,paymentKey:key});
    await post(pending,'confirm',input(pending,'unused'),403,{Origin:'http://wrong.invalid'});
    await post(pending,'confirm',input(second,'unused'),400);
    await post(pending,'confirm',{...input(pending,'unused'),amount:1},409);
    await post(pending,'confirm',{...input(pending,'unused'),paymentKey:'invalid key'},400);
    await post(pending,'reconcile',{unexpected:true},400);
    await post(pending,'reconcile',{},409);
    await post(pending,'confirm',input(pending,'reject-card'),422);
    for(const db of [reference,databases.order]) {
      const {rows}=await db.query('SELECT provider_payment_key,approval_started_at FROM order_payment_requests WHERE payment_request_id=$1',[pending]);
      assert.deepEqual(rows,[{provider_payment_key:null,approval_started_at:null}]);
    }
    await post(pending,'confirm',input(pending,'approve-unknown'),502);
    await post(pending,'confirm',input(pending,'other-key'),409);
    for(const [db,runtime] of [[reference,'./monolith-runtime'],[databases.order,'../dist']]) {
      const {PaymentsRepository}=require(runtime+'/payments/payments.repository');
      const repo=new PaymentsRepository({pool:db});
      assert.deepEqual(await repo.pendingApprovals(),[{id:pending}]);
      assert.deepEqual(await repo.pendingApprovals(),[]);
    }
    const recovered=await post(pending,'reconcile',{},200);
    try {
      for(const db of [reference,databases.order])await db.query(
        "CREATE FUNCTION parity_charge_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'charge storage unavailable'; END; $$; "+
        "CREATE TRIGGER parity_charge_failure BEFORE INSERT ON order_billing_charges FOR EACH ROW WHEN(NEW.order_seq=1051) EXECUTE FUNCTION parity_charge_failure()");
      await post(second,'confirm',input(second,'approve-legacy-credit'),500);
      for(const db of [reference,databases.order]){
        const row=(await db.query("SELECT o.status,o.paid_at,r.completed_at,o.billing_organization_seq,"+
          "(SELECT count(*)::int FROM order_billing_charges b WHERE b.order_seq=o.order_seq) AS charges "+
          "FROM orders o JOIN order_payment_requests r USING(order_seq) WHERE o.order_seq=1051")).rows[0];
        assert.deepEqual(row,{status:'notPaid',paid_at:null,completed_at:null,billing_organization_seq:6001,charges:0});
      }
    } finally {
      for(const db of [reference,databases.order])await db.query(
        'DROP TRIGGER IF EXISTS parity_charge_failure ON order_billing_charges; DROP FUNCTION IF EXISTS parity_charge_failure()');
    }
    const approved=await post(second,'reconcile',{},200);
    for(const view of [recovered,approved]) {
      assert.equal(view.status,'PAID');
      assert.equal(view.orderStatus,'ACCEPTED');
      assert.equal(view.completionNotificationStatus,'PENDING');
    }
    assert.equal(recovered.approvedAt,'2030-03-01T09:01:00.000Z');
    assert.equal(recovered.pickupRequestedAt,'2030-03-02T00:00:00.000Z');
    assert.equal(approved.approvedAt,'2030-02-28T15:00:00.000Z');
    assert.equal(approved.pickupRequestedAt,'2030-03-01T00:00:00.000Z');
    assert.deepEqual(await post(pending,'reconcile',{},200),recovered);
    assert.deepEqual(await post(second,'confirm',input(second,'approve-legacy-credit'),200),approved);
    const charges=async db=>(await db.query(
      'SELECT order_seq,organization_seq,customer_seq,billing_month::text,payment_method_type,amount::float8,occurred_at '+
      'FROM order_billing_charges WHERE order_seq IN (1002,1051) ORDER BY order_seq',
    )).rows;
    const personal=await charges(reference);
    assert.deepEqual(await charges(databases.order),personal);
    assert.equal(personal.length,1);assert.equal(personal[0].order_seq,1051);
    assert.equal(personal[0].organization_seq,null);assert.equal(personal[0].billing_month,'2030-03-01');
    assert.equal(personal[0].payment_method_type,'credit');assert.equal(personal[0].amount,7000);
    assert.equal(personal[0].occurred_at.toISOString(),approved.approvedAt);
    const calls=await Promise.all(['monolith','order'].map(async owner=>{
      const response=await fetch('http://'+owner+'-app:8000/__requests',{headers:{Authorization:'Bearer '+process.env.CUSTOMER_AUTH_TOKEN}});
      assert.equal(response.status,200);
      return response.json();
    }));
    assert.deepEqual(calls[1],calls[0]);
    assert.deepEqual(calls[0].map(call=>[call.method,call.path]),[
      ['POST','/v1/payments/confirm'],['POST','/v1/payments/confirm'],['GET','/v1/payments/approve-unknown'],
      ['POST','/parcel'],['POST','/v1/payments/confirm'],['GET','/v1/payments/approve-legacy-credit'],['POST','/parcel'],
    ]);
    const stored=async db=>(await db.query(
      'SELECT r.payment_request_id,r.provider_reference,r.provider_payment_key,r.provider_approved_at,'+
      'r.approval_claim_id,r.approval_claimed_until,r.completed_at IS NOT NULL AS completed,'+
      'r.completion_notification_status,o.status,o.parcel_no,o.dver_received_at,o.paid_at,o.pickup_requested_at,o.total_amount,o.version '+
      'FROM order_payment_requests r JOIN orders o USING(order_seq) WHERE payment_request_id=ANY($1::uuid[]) ORDER BY payment_request_id',
      [[pending,second]],
    )).rows;
    assert.deepEqual(await stored(databases.order),await stored(reference));
    const audit=async db=>(await db.query('SELECT request_id,action,result,target_type,target_seq,actor_type,actor_seq,metadata'+
      ' FROM audit_logs WHERE request_id=ANY($1::uuid[]) ORDER BY request_id,action',[requests])).rows;
    const expected=await audit(reference);
    assert.deepEqual(await audit(databases.operations),expected);
    assert.equal(expected.filter(row=>row.action==='ORDER_PAYMENT_COMPLETED').length,2);
    assert.equal(expected.filter(row=>row.action.startsWith('BILLING_')).length,0);
    const delivery=new Pool({host:'delivery-db',user:'delivery_app'});
    try {
      const shipments=async db=>(await db.query(
        'SELECT order_parcel_seq,s.status,h.to_status,h.actor_type FROM shipments s JOIN shipment_status_history h USING(shipment_seq) '+
        'WHERE order_parcel_seq=ANY($1::int[]) ORDER BY order_parcel_seq',[[20021,20022,20511]],
      )).rows;
      assert.equal((await shipments(reference)).length,3);
      assert.deepEqual(await shipments(delivery),await shipments(reference));
    } finally {await delivery.end();}
    t.diagnostic('approval HTTP pairs: '+requests.length+'; provider idempotency, approval recovery, paid state and shipments');
  });
  await t.test('parcel draft writes preserve call and customer scope, versions, reservations and committed-call recovery', async () => {
    const customer=92101, other=92102, withdrawn=92103, pin=92101, oldDraft=28100;
    const call=18101, unknown=18103, faultCall=18107, requests=[], histories=[new Map(),new Map()];
    const ownSides=[{...sides[0],orders:reference,calls:reference,customers:reference,audit:reference},
      {...sides[1],orders:databases.order,calls:databases.consultation,customers:databases.customer,audit:databases.operations}];
    const at=new Date((await reference.query('SELECT clock_timestamp() AS at')).rows[0].at).getTime();
    const oldCreated=new Date(at-7200000).toISOString(), oldRetention=new Date(at-3600000).toISOString();
    const address=name=>({name,phoneNumber:'01011112222',roadAddress:'도로',jibunAddress:'지번',detailAddress:'',
      dongName:'동',postalCode:'12345'});
    const ready={origin:address('발송인'),destination:address('수령인'),originPin:{scope:'PERSONAL',pinSeq:pin},
      documentCount:1,smallBoxCount:0,mediumBoxCount:0,bigBoxCount:0,otherItemDescription:'',clientComment:'',
      itemPrice:1000,notifiedPrice:5000};
    for(const side of ownSides) {
      for(const [id,phone,status] of [[customer,'01011112222','ACTIVE'],[other,'01011112223','ACTIVE'],[withdrawn,'01011112224','WITHDRAWN']])
        await side.customers.query("INSERT INTO customers(customer_seq,name,phone_number,status) OVERRIDING SYSTEM VALUE VALUES($1,'초안 고객',$2,$3)",[id,phone,status]);
      await side.customers.query('INSERT INTO personal_pins(personal_pin_seq,customer_seq,address_data,version) OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,1)',
        [pin,customer,ready.origin]);
      for(const [id,phone,enabled,incoming,deleted] of [
        [18100,'01011112222',true,oldCreated,null],[call,'01011112222',true,new Date(at).toISOString(),null],
        [18102,'01011112223',true,new Date(at).toISOString(),null],[unknown,'01011112226',true,new Date(at).toISOString(),null],
        [18104,'01011112222',false,new Date(at).toISOString(),null],[18105,'01011112222',true,'2000-01-01T00:00:00Z',null],
        [18106,'01011112222',true,new Date(at).toISOString(),oldRetention],[faultCall,'01011112222',true,new Date(at).toISOString(),null],
      ]) await side.calls.query(
        'INSERT INTO call_sessions(call_session_seq,provider_call_id,caller_phone_number,incoming_at,registered_at,order_intake_enabled,deleted_at) '+
        "OVERRIDING SYSTEM VALUE VALUES($1,'write-call-'||$1::int::text,$2,$3,$3,$4,$5)",
        [id,phone,incoming,enabled,deleted]);
      const guard=await side.calls.connect();await guard.query('BEGIN');
      await guard.query('SELECT 1 FROM call_sessions WHERE call_session_seq=18105 FOR KEY SHARE');retention.push(guard);
      await side.orders.query(
        'INSERT INTO order_parcel_drafts(draft_seq,reserved_order_seq,call_session_seq,customer_seq,caller_phone_number,'+
        'client_parcel_id,creation_payload,parcel_data,status,version,created_at,updated_at,retention_started_at) '+
        "OVERRIDING SYSTEM VALUE VALUES($1,38000,18100,$2,'01011112222',$3,'{}',$4,'INCOMPLETE',1,$5,$5,$6)",
        [oldDraft,customer,'00000000-0000-4000-8000-000000028100',
          {...ready,originPin:{scope:'COMPANY',pinSeq:99013}},oldCreated,oldRetention]);
      await side.orders.query("SELECT setval('order_parcel_drafts_draft_seq_seq',28101,false),setval('orders_order_seq_seq',38001,false)");
    }
    for(const history of histories) history.set(oldDraft,{createdAt:oldCreated,updatedAt:oldCreated,retentionStartedAt:oldRetention,
      retentionTag:'retention:'+oldDraft,version:1});
    const windows=new Map();
    function bounded(value,start,end,label) {
      const time=Date.parse(value);
      assert.ok(Number.isFinite(time)&&time>=start-1000&&time<=end+1000,label+' '+value);
    }
    function normalize(data,side,start,end) {
      const old=histories[side].get(data.draftSeq), source=histories[side].get(data.sourceDraftSeq);
      if(old) {
        assert.equal(data.createdAt,old.createdAt,'created snapshot');
        assert.equal(data.retentionStartedAt,old.retentionStartedAt,'retention snapshot');
        if(data.version===old.version)assert.equal(data.updatedAt,old.updatedAt,'idempotent update timestamp');
        else {
          const range=windows.get(data.draftSeq)??{start,end};
          bounded(data.updatedAt,range.start,range.end,'updated timestamp');
        }
      } else {
        bounded(data.createdAt,start,end,'created timestamp');
        bounded(data.updatedAt,start,end,'initial updated timestamp');
        if(source)assert.equal(data.retentionStartedAt,source.retentionStartedAt,'resumed retention');
        else bounded(data.retentionStartedAt,start,end,'initial retention');
      }
      const retentionTag=old?.retentionTag??source?.retentionTag??('retention:'+data.draftSeq);
      histories[side].set(data.draftSeq,{createdAt:data.createdAt,updatedAt:data.updatedAt,retentionStartedAt:data.retentionStartedAt,
        retentionTag,version:data.version});
      return {...data,createdAt:'created:'+data.draftSeq,updatedAt:'updated:'+data.draftSeq+':'+data.version,retentionStartedAt:retentionTag};
    }
    let writes=0;
    async function send(side,method,path,input,expected,requestId,options={}) {
      const response=await fetch(side.base+path,{method,signal:AbortSignal.timeout(25000),headers:{
        'X-Request-Id':requestId,...(input===undefined?{}:{'Content-Type':'application/json'}),
        ...(options.admin===undefined?{Authorization:'Bearer '+process.env.PGPASSWORD,
          ...(options.noCall?{}:{call_session_seq:String(options.call??call)})}:
          {Cookie:'dva_session='+tokens[options.admin-1],Origin:'http://localhost:5173'}),
        ...options.headers,
      },...(input===undefined?{}:{body:JSON.stringify(input)})});
      const body=await response.json();
      assert.equal(response.status,expected,side.name+' '+method+' '+path+' '+JSON.stringify(body));
      assert.equal(response.headers.get('cache-control'),'no-store');
      assert.equal(response.headers.get('x-request-id'),requestId);
      return body;
    }
    async function pair(method,path,input,expected,options={}) {
      const requestId=randomUUID(),start=Date.now(),bodies=[];
      requests.push(requestId);
      for(const side of ownSides)bodies.push(await send(side,method,path,input,expected,requestId,options));
      const end=Date.now();
      if(input?.sourceDraftSeq)windows.set(input.sourceDraftSeq,{start,end});
      const normalized=bodies.map((body,index)=>expected<300?{...body,data:normalize(body.data,index,start,end)}:body);
      assert.deepEqual(normalized[1],normalized[0],method+' '+path);writes++;
      return bodies[0].data;
    }
    const create=input=>pair('POST','/api/parcel-drafts',input,201);
    const edit=(id,input,status=200)=>pair('PATCH','/api/parcel-drafts/'+id,input,status);
    const draftInput={clientParcelId:randomUUID(),status:'EDITING',parcel:{origin:{name:'초안 발송인'},documentCount:1}};
    await pair('POST','/api/parcel-drafts',draftInput,401,{headers:{Authorization:''}});
    await pair('POST','/api/parcel-drafts',draftInput,400,{noCall:true});
    await pair('POST','/api/parcel-drafts',{clientParcelId:randomUUID(),status:'EDITING'},400,{noCall:true});
    await pair('POST','/api/parcel-drafts',{...draftInput,unexpected:1},400);
    for(const [id,status] of [[999999,404],[18104,409],[18105,404],[18106,404]])
      await pair('POST','/api/parcel-drafts',draftInput,status,{call:id});
    await pair('POST','/api/parcel-drafts',{...draftInput,customerSeq:other},403);
    const first=await create(draftInput);
    assert.equal(first.customerSeq,customer);assert.equal(first.intakeVersion,2);
    assert.deepEqual(await create(draftInput),first);
    await pair('POST','/api/parcel-drafts',{...draftInput,parcel:{documentCount:2}},409);
    await edit(first.draftSeq,{expectedVersion:1,action:'SAVE',status:'READY',parcel:{...ready,originPin:{scope:'PERSONAL',pinSeq:2}}},403);
    await edit(first.draftSeq,{expectedVersion:1,action:'SAVE',status:'READY'},422);
    const saved=await edit(first.draftSeq,{expectedVersion:1,action:'SAVE',status:'READY',parcel:ready});
    assert.equal(saved.version,2);assert.equal(saved.intakeVersion,3);
    await edit(first.draftSeq,{expectedVersion:1,action:'SAVE',status:'READY',parcel:ready},409);
    const cleared=await edit(first.draftSeq,{expectedVersion:2,action:'START_EDIT',clearFields:['origin','items','itemPrice']});
    assert.equal(cleared.version,3);assert.equal(cleared.intakeVersion,4);
    assert.ok(Object.values(cleared.parcel.origin).every(value=>value===null));
    assert.equal(cleared.parcel.originPin,null);assert.equal(cleared.parcel.notifiedPrice,null);
    assert.equal(cleared.parcel.documentCount,0);assert.equal(cleared.parcel.itemPrice,null);
    await edit(first.draftSeq,{expectedVersion:3,action:'SAVE',status:'READY',parcel:ready});
    const cancelled=await edit(first.draftSeq,{expectedVersion:4,action:'CANCEL'});
    assert.equal(cancelled.status,'CANCELLED');assert.equal(cancelled.intakeVersion,6);
    await edit(first.draftSeq,{expectedVersion:5,action:'CANCEL'},409);
    await pair('POST','/api/parcel-drafts',{...draftInput,clientParcelId:randomUUID(),status:'READY',parcel:ready},403,{call:unknown});
    const anonymous=await pair('POST','/api/parcel-drafts',{...draftInput,clientParcelId:randomUUID()},201,{call:unknown});
    assert.equal(anonymous.customerSeq,null);assert.equal(anonymous.intakeVersion,2);
    const standalone={clientParcelId:randomUUID(),customerSeq:customer,status:'READY',parcel:ready};
    const manual=await pair('POST','/api/parcel-drafts',standalone,201,{admin:1});
    assert.equal(manual.intakeVersion,null);assert.equal(manual.callSessionSeq,null);
    await pair('POST','/api/parcel-drafts',standalone,403,{admin:2});
    await pair('POST','/api/parcel-drafts',{...standalone,clientParcelId:randomUUID(),customerSeq:withdrawn},404,{admin:1});
    await pair('PATCH','/api/parcel-drafts/'+first.draftSeq,{expectedVersion:5,action:'CANCEL'},409,{admin:1});
    await pair('GET','/api/parcel-drafts/'+oldDraft,undefined,200);
    const resumed=await create({clientParcelId:randomUUID(),sourceDraftSeq:oldDraft,status:'READY'});
    assert.equal(resumed.reservedOrderSeq,38000);
    assert.equal(resumed.parcel.originPin.scope,'COMPANY');
    assert.equal((await pair('GET','/api/parcel-drafts/'+oldDraft,undefined,200)).status,'RESUMED');

    const {createServer}=require('node:http'),{networkInterfaces}=require('node:os');
    const addressIp=Object.values(networkInterfaces()).flat().find(row=>row.family==='IPv4'&&!row.internal)?.address;
    assert.ok(addressIp);
    let committed;
    const proxy=createServer(async(req,res)=>{
      try {
        assert.equal(req.url,'/internal/parcel-draft-write');
        const chunks=[];for await(const chunk of req)chunks.push(chunk);
        const response=await fetch('http://order-app:3002'+req.url,{method:'POST',
          headers:{Authorization:req.headers.authorization,'Content-Type':'application/json'},body:Buffer.concat(chunks)});
        committed=await response.json();
        assert.equal(response.status,200,JSON.stringify(committed));
        res.destroy();
      } catch(error) {res.writeHead(500).end(String(error));}
    });
    await new Promise(resolve=>proxy.listen(3002,'0.0.0.0',resolve));
    const faultInput={clientParcelId:randomUUID(),status:'EDITING',parcel:{origin:{name:'응답 유실 초안'}}};
    const requestId=randomUUID(),start=Date.now();requests.push(requestId);
    try {
      const expected=await send(ownSides[0],'POST','/api/parcel-drafts',faultInput,201,requestId,{call:faultCall});
      const packet={eventId:randomUUID(),source:'order',eventType:'ParcelDraftWriteRequested',payload:{
        orderAddress:addressIp,command:{operation:'ParcelDraftCreated',id:null,adminId:null,callSessionSeq:faultCall,input:faultInput,requestId}}};
      const response=await fetch('http://consultation-app:3004/internal/parcel-draft-write',{method:'POST',signal:AbortSignal.timeout(25000),
        headers:{Authorization:'Bearer '+process.env.CUSTOMER_AUTH_TOKEN,'Content-Type':'application/json'},body:JSON.stringify(packet)});
      assert.equal(response.status,503,JSON.stringify(await response.json()));
      assert.ok(committed?.payload?.receipt,'the order committed a durable call mutation');
      const end=Date.now();
      assert.deepEqual(normalize(committed.payload.data,1,start,end),normalize(expected.data,0,start,end));
      const incomplete=(await databases.consultation.query('SELECT customer_seq,order_intake_version FROM call_sessions WHERE call_session_seq=$1',[faultCall])).rows[0];
      assert.deepEqual(incomplete,{customer_seq:null,order_intake_version:1});
      await pair('POST','/api/parcel-drafts',faultInput,201,{call:faultCall});
      const {ParcelDraftWriteWorker}=require('../dist/orders/parcel-draft-write.worker');
      const {DatabaseService}=require('../dist/database/database.service');
      const config={get:key=>({NODE_ENV:'test',DB_HOST:'order-db',DB_PORT:5432,DB_USER:'order_app',DB_PASSWORD:process.env.PGPASSWORD,
        DB_NAME:process.env.PGDATABASE,CUSTOMER_URL:'http://customer-app:3001',CONSULTATION_URL:'http://consultation-app:3004',CUSTOMER_AUTH_TOKEN:process.env.CUSTOMER_AUTH_TOKEN})[key]};
      const db=new DatabaseService(config),worker=new ParcelDraftWriteWorker(db,config);
      try {
        const current=worker.run();assert.equal(worker.run(),current);await current;
        for(let count=0;count<30;count++){if(!(await worker.run()))break;assert.ok(count<29,'draft relay did not drain');}
        await worker.onModuleDestroy();
      } finally{await db.onModuleDestroy();}
      const marker=await databases.order.query('SELECT delivered_at IS NOT NULL AS delivered FROM outbox_events WHERE event_id=$1',[committed.payload.receipt.eventId]);
      assert.deepEqual(marker.rows,[{delivered:true}]);
    } finally{proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));}
    const callRows=async db=>(await db.query(
      'SELECT call_session_seq,customer_seq,order_intake_version FROM call_sessions WHERE call_session_seq IN (18101,18103,18107) ORDER BY call_session_seq',
    )).rows;
    assert.deepEqual(await callRows(databases.consultation),await callRows(reference));
    const auditRows=async db=>(await db.query(
      'SELECT request_id,action,result,target_type,target_seq,actor_type,actor_seq,metadata FROM audit_logs '+
      'WHERE request_id=ANY($1::uuid[]) ORDER BY request_id,audit_log_seq',[requests],
    )).rows;
    assert.deepEqual(await auditRows(databases.operations),await auditRows(reference));
    const docs=await Promise.all(sides.map(async side=>(await fetch(side.base+'/api/docs-json')).json()));
    for(const [path,method] of [['/api/parcel-drafts','post'],['/api/parcel-drafts/{id}','patch']]) {
      assert.deepEqual(docs[1].paths[path][method],docs[0].paths[path][method]);
      const visit=(value,seen=new Set())=>{
        for(const match of JSON.stringify(value).matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g)) {
          const name=match[1];if(seen.has(name))continue;seen.add(name);
          assert.deepEqual(docs[1].components.schemas[name],docs[0].components.schemas[name],name);
          visit(docs[0].components.schemas[name],seen);
        }
      };
      visit(docs[0].paths[path][method]);
    }
    t.diagnostic('draft write HTTP pairs: '+writes+'; call/customer/PIN locks, stored versions and order-commit response loss recovered');
  });
  await t.test('metrics preserve the plain scrape contract and bounded database failures', async () => {
    for(const client of retention.splice(0)){await client.query('ROLLBACK');client.release();}
    const samples=text=>Object.fromEntries(text.split('\n').filter(line=>line&&!line.startsWith('#')).map(line=>{
      const at=line.lastIndexOf(' ');return [line.slice(0,at),Number(line.slice(at+1))];
    }));
    const scrape=async side=>{
      const response=await fetch(side.base+'/internal/metrics',{headers:{Cookie:'dva_session=invalid',Authorization:'invalid'}});
      assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
      const text=await response.text();
      assert.match(response.headers.get('content-type'),/^text\/plain;.*version=0\.0\.4/);
      assert.ok(text.endsWith('\n'));assert.ok(!text.includes('"meta"'));
      const values=samples(text);
      for(const [name,value] of Object.entries(values))assert.ok(Number.isFinite(value)&&value>=0,name);
      return {text,values};
    };
    const healthy=await Promise.all(sides.map(scrape));
    const attention=values=>Object.fromEntries(Object.entries(values).filter(([key])=>
      key.startsWith('dva_orders_attention{')||key==='dva_orders_stale_submitting'));
    assert.deepEqual(attention(healthy[1].values),attention(healthy[0].values));
    for(const result of healthy){
      assert.equal(result.values.dva_database_up,1);assert.equal(result.values.dva_order_metrics_success,1);
      assert.equal(Object.keys(attention(result.values)).length,6);
    }
    const locks=[];
    try {
      for(const db of [reference,databases.order]){
        const client=await db.connect();locks.push(client);await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout='1s'");
        await client.query('LOCK TABLE orders IN ACCESS EXCLUSIVE MODE');
      }
      const start=Date.now(),blocked=await Promise.all(sides.map(scrape));
      assert.ok(Date.now()-start<5000,'metrics statement timeout did not bound the scrape');
      for(const result of blocked){
        assert.equal(result.values.dva_database_up,1);assert.equal(result.values.dva_order_metrics_success,0);
        assert.deepEqual(attention(result.values),{});
        assert.ok(!result.text.includes('SELECT status'));
      }
    } finally{for(const client of locks){await client.query('ROLLBACK');client.release();}}
    for(const result of await Promise.all(sides.map(scrape)))assert.equal(result.values.dva_order_metrics_success,1);
    t.diagnostic('metrics HTTP pairs: 3; plain text, attention counts, real database timeout and recovery');
  });
  await t.test('dashboard home preserves previews, current-day counts, performance and read-only owner snapshots', async () => {
    const homeSides=[sides[0],{...sides[1],base:'http://consultation-app:3004'}];
    let pairs=0;
    const home=async(extra={},expected=200)=>{
      const requestId=randomUUID(),start=Date.now();
      const results=await Promise.all(homeSides.map(async side=>{
        const response=await fetch(side.base+'/api/dashboard/home',{headers:{...headers,'X-Request-Id':requestId,...extra}});
        const body=await response.json();assert.equal(response.status,expected,side.name+' '+JSON.stringify(body));
        if(expected===200){
          assert.ok(Date.parse(body.data.observedAt)>=start-2000&&Date.parse(body.data.observedAt)<=Date.now()+2000);
          body.data.observedAt='<snapshot>';
        }
        return body;
      }));
      assert.deepEqual(results[1],results[0]);pairs++;return results[1].data;
    };
    await home({Cookie:''},401);await home({Cookie:'dva_session=invalid'},401);
    await home({Cookie:'',Authorization:'Bearer '+process.env.AI_BUSINESS_TOKEN},401);
    const initial=await home();
    const now=new Date((await reference.query('SELECT clock_timestamp() AS at')).rows[0].at);
    const day=new Date(now.getTime()+9*3600000).toISOString().slice(0,10);
    const first=Date.parse(day+'T00:00:00+09:00'),next=first+86400000;
    const times=[first-1,first,next-1,next,first,first];
    for(const db of [reference,databases.customer])
      await db.query("INSERT INTO customers(customer_seq,name,phone_number,status) OVERRIDING SYSTEM VALUE "+
        "VALUES(92150,'홈 고객','01092150000','ACTIVE')");
    for(let i=0;i<times.length;i++)for(const db of [reference,databases.order])
      await db.query("INSERT INTO orders(order_seq,customer_seq,status,created_at,updated_at,deleted_at) "+
        "OVERRIDING SYSTEM VALUE VALUES($1,1,'COLLECTING',$2,$2,$3)",
        [46000+i,new Date(times[i]),i===4?now:null]);
    for(let i=0;i<15;i++){
      const id=18500+i,uuid=randomUUID(),at=new Date(now.getTime()-60000-i*1000),end=new Date(at.getTime()+500);
      for(const db of [reference,databases.consultation]){
        await db.query("INSERT INTO call_sessions(call_session_seq,provider_call_id,customer_seq,caller_phone_number,incoming_at,started_at,ended_at,registered_at) "+
          "OVERRIDING SYSTEM VALUE VALUES($1,'home-'||$1::int::text,92150,'01092150000',$2,$2,$3,$2)",[id,at,end]);
        const complaints=i<4?[{type:['UNSUPPORTED_ANSWER','DISSATISFACTION_EXPRESSION','INFORMATION_RECOGNITION_ERROR','DISSATISFACTION_EXPRESSION'][i],
          target:i===1?'price_policy':i===3?'ai_service':null,level:i===1||i===3?'mild':null,offsetSeconds:0,evidenceText:'홈 품질 기준'}]:[];
        await db.query("INSERT INTO call_analyses(call_session_seq,ai_started_at,ai_ended_at,has_complaint,complaints,payload_hash,is_new_customer,registered_parcel_count) "+
          "VALUES($1,$2,$3,$4,$5,repeat('a',64),$6,$7)",[id,at,end,complaints.length>0,JSON.stringify(complaints),i%2===0,i%3]);
        await db.query("INSERT INTO unanswered_questions(unanswered_question_seq,event_id,call_session_seq,question_text,occurred_at,payload_hash) "+
          "OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,'홈 미답변 '||$3::int::text,$4,repeat('b',64))",[28500+i,uuid,id,at]);
      }
      const key=randomUUID();
      for(const db of [reference,databases.order])
        await db.query("INSERT INTO order_parcel_drafts(draft_seq,customer_seq,created_by_admin_user_seq,client_parcel_id,creation_payload,parcel_data,status,reserved_order_seq,created_at,updated_at,retention_started_at,legacy_order_seq) "+
          "OVERRIDING SYSTEM VALUE VALUES($1,92150,1,$2,'{}','{}','INCOMPLETE',$3,$4,$4,$6,$5)",
          [28500+i,key,47000+i,at,i===0?46005:null,now]);
    }
    const stored=await Promise.all(Object.entries(owners).map(([owner,tables])=>snapshot(databases[owner],tables)));
    const original=await snapshot(reference,[...orderTables,'call_sessions','call_analyses','unanswered_questions']);
    const populated=await home();
    assert.equal(populated.todayOrderCount,initial.todayOrderCount+2);
    assert.equal(populated.todayCallCount,initial.todayCallCount+15);
    assert.equal(populated.pendingWork.incomplete,initial.pendingWork.incomplete+15);
    assert.equal(populated.pendingWork.unansweredQuestions,15);
    for(const key of ['recentCalls','incompleteDrafts','unansweredQuestions'])assert.equal(populated[key].length,11);
    assert.ok(populated.unansweredQuestions.every(row=>row.customerName==='홈 고객'));
    for(const cookie of tokens.slice(1).map(token=>'dva_session='+token))await home({Cookie:cookie});
    assert.deepEqual(await Promise.all(Object.entries(owners).map(([owner,tables])=>snapshot(databases[owner],tables))),stored);
    assert.deepEqual(await snapshot(reference,[...orderTables,'call_sessions','call_analyses','unanswered_questions']),original);
    const docs=await Promise.all(homeSides.map(async side=>(await fetch(side.base+'/api/docs-json')).json()));
    const operation=docs[0].paths['/api/dashboard/home'].get;
    assert.deepEqual(docs[1].paths['/api/dashboard/home'].get,operation);
    const visit=(value,seen=new Set())=>{
      for(const match of JSON.stringify(value).matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g)){
        const name=match[1];if(seen.has(name))continue;seen.add(name);
        assert.deepEqual(docs[1].components.schemas[name],docs[0].components.schemas[name],name);
        visit(docs[0].components.schemas[name],seen);
      }
    };
    visit(operation);
    const event={eventId:randomUUID(),source:'consultation',eventType:'HomeOrdersReadRequested',
      payload:{observedAt:now.toISOString(),consultationAddress:null}};
    const internal=async(token,body,scope)=>fetch('http://order-app:3002/internal/home-orders',{
      method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token,
        ...(scope?{'X-Msa-Read-Scope':scope}:{})},body:JSON.stringify(body),
    });
    assert.equal((await internal('invalid',event,randomUUID())).status,403);
    assert.equal((await internal(process.env.CUSTOMER_AUTH_TOKEN,event)).status,422);
    assert.equal((await internal(process.env.CUSTOMER_AUTH_TOKEN,{...event,source:'order'},randomUUID())).status,422);
    t.diagnostic('home HTTP pairs: '+pairs+'; KST boundaries, 11-item previews, three roles, owner immutability and schemas');
  });
  await t.test(
    'maintenance expires bounded unpaid batches while preserving held and approving orders',
    async () => {
      const now = new Date(),
        created = new Date(now.getTime() - 7200000),
        due = new Date(now.getTime() - 1000);
      const future = new Date(now.getTime() + 60000),
        approval = new Date(now.getTime() - 300000),
        past = new Date(now.getTime() - 500);
      const ids = Array.from({ length: 121 }, (_, i) => ({
        order_seq: 50000 + i,
        id: randomUUID(),
      }));
      for (const db of [reference, databases.order]) {
        const client = await db.connect();
        try {
          await client.query('BEGIN');
          // Seed persisted payment states before exercising the normal trigger-protected worker.
          await client.query("SET LOCAL session_replication_role='replica'");
          await client.query(
            'INSERT INTO orders(order_seq,customer_seq,payment_method_type,status,creation_source,total_amount,payment_due_at,created_at,updated_at,deleted_at,paid_at) ' +
              "OVERRIDING SYSTEM VALUE SELECT 50000+n,1,'billing',CASE WHEN n=120 THEN 'PAID' ELSE 'notPaid' END,'AI',1000," +
              'CASE WHEN n=118 THEN $3::timestamptz ELSE $2::timestamptz END,$1,$1,CASE WHEN n=119 THEN $4::timestamptz END,' +
              'CASE WHEN n=120 THEN $4::timestamptz END FROM generate_series(0,120)n',
            [created, due, future, now],
          );
          await client.query(
            'INSERT INTO order_parcels(order_parcel_seq,order_seq,parcel_position,status,document_count,notified_price) ' +
              "OVERRIDING SYSTEM VALUE SELECT 60000+n,50000+n,1,'ACTIVE',1,1000 FROM generate_series(0,120)n",
          );
          await client.query(
            'INSERT INTO order_payment_requests(payment_request_id,order_seq,amount,expires_at,created_at,notification_status,' +
              'approval_started_at,provider_payment_key,invalidated_at,completed_at,provider_reference,provider_approved_at) ' +
              "SELECT id,order_seq,1000,CASE WHEN order_seq=50118 THEN $4::timestamptz ELSE $3::timestamptz END,$2,'SENT'," +
              'CASE WHEN order_seq IN(50002,50003,50004,50120) THEN $5::timestamptz END,' +
              "CASE WHEN order_seq IN(50002,50003,50004,50120) THEN 'fixture-key-'||order_seq::text END," +
              'CASE WHEN order_seq=50003 THEN $6::timestamptz END,' +
              'CASE WHEN order_seq IN(50004,50120) THEN $6::timestamptz END,' +
              "CASE WHEN order_seq IN(50004,50120) THEN 'fixture-completed-'||order_seq::text END," +
              'CASE WHEN order_seq IN(50004,50120) THEN $6::timestamptz END ' +
              'FROM jsonb_to_recordset($1::jsonb)r(order_seq int,id uuid) WHERE order_seq<>50005',
            [JSON.stringify(ids), created, due, future, approval, past],
          );
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      }
      const clients = [],
        workers = [];
      const hold = async (db, sql) => {
        const client = await db.connect();
        clients.push(client);
        await client.query('BEGIN');
        await client.query(sql);
        return client;
      };
      const release = async (client) => {
        await client.query('ROLLBACK');
        client.release();
        clients.splice(clients.indexOf(client), 1);
      };
      const cancelled = async (db) =>
        Number(
          (
            await db.query(
              "SELECT count(*) FROM orders WHERE order_seq BETWEEN 50000 AND 50120 AND status='CANCELLED'",
            )
          ).rows[0].count,
        );
      const started = Date.now();
      try {
        for (const [owner, runtime] of [
          ['monolith', './monolith-runtime'],
          ['order', '../dist'],
        ]) {
          const { DatabaseService } = require(
            runtime + '/database/database.service',
          );
          const { AuditService } = require(runtime + '/audit/audit.service');
          const { OrdersRepository } = require(
            runtime + '/orders/orders.repository',
          );
          const config = {
            get: (key) =>
              ({
                NODE_ENV: 'test',
                DB_HOST: owner + '-db',
                DB_PORT: 5432,
                DB_USER: owner + '_app',
                DB_PASSWORD: process.env.PGPASSWORD,
                DB_NAME: process.env.PGDATABASE,
                OPERATIONS_URL: 'http://operations-app:3005',
                CUSTOMER_AUTH_TOKEN: process.env.CUSTOMER_AUTH_TOKEN,
              })[key],
          };
          const database = new DatabaseService(config);
          let audit;
          if (owner === 'monolith') {
            const { AuditRepository } = require(
              runtime + '/audit/audit.repository',
            );
            audit = new AuditService(new AuditRepository(database));
          } else {
            audit = new AuditService(database, config);
          }
          const repository = new OrdersRepository(database);
          const jobs = [];
          const transaction = database.transaction.bind(database);
          database.transaction = (work) => {
            jobs.push('expiry');
            return transaction(work);
          };
          const recover = {
            recoverPending: async () => jobs.push('pending'),
            recoverPaid: async () => jobs.push('paid'),
            submitPaidOrder: async () => jobs.push('paid'),
          };
          let worker;
          if (owner === 'monolith') {
            // Intake recovery is injected below; its constructor metadata also imports S3 playback.
            const intakePath = require.resolve(
              runtime + '/orders/order-intake.service',
            );
            const cachedIntake = require.cache[intakePath];
            require.cache[intakePath] = {
              loaded: true,
              exports: { OrderIntakeService: class {} },
            };
            let OrderMaintenanceWorker;
            try {
              ({ OrderMaintenanceWorker } = require(
                runtime + '/orders/order-maintenance.worker',
              ));
            } finally {
              if (cachedIntake) require.cache[intakePath] = cachedIntake;
              else delete require.cache[intakePath];
            }
            const { OrderPaymentsRepository } = require(
              runtime + '/orders/order-payments.repository',
            );
            worker = new OrderMaintenanceWorker(
              database,
              audit,
              { rollover: async () => jobs.push('billing') },
              recover,
              repository,
              new OrderPaymentsRepository(undefined, database),
              config,
              { recoverPending: async () => jobs.push('intake') },
            );
          } else {
            const { OrderSubmissionWorker } = require(
              runtime + '/orders/order-submission.worker',
            );
            worker = new OrderSubmissionWorker(
              recover,
              config,
              database,
              repository,
              audit,
              { run: async () => jobs.push('billing') },
              {recoverPending:async()=>jobs.push('intake')},
            );
          }
          worker.onApplicationBootstrap();
          assert.deepEqual(jobs, []);
          workers.push({ owner, database, audit, worker, jobs });
        }
        const run = async (expectedBatches) => {
          for (const item of workers) {
            item.jobs.length = 0;
            const first = item.worker.run(now);
            assert.equal(item.worker.run(now), first);
            await first;
            assert.equal(
              item.jobs.filter((job) => job === 'expiry').length,
              expectedBatches,
            );
            assert.deepEqual(
              item.jobs.slice(0,3),
              ['intake','pending','billing'],
            );
            assert.ok(
              item.jobs.lastIndexOf('paid') > item.jobs.lastIndexOf('billing'),
            );
          }
        };
        const gates = [];
        for (const db of [reference, databases.order])
          gates.push(
            await hold(db, 'SELECT pg_advisory_xact_lock(20261030,140)'),
          );
        await run(1);
        for (const db of [reference, databases.order])
          assert.equal(await cancelled(db), 0);
        for (const gate of gates) await release(gate);
        const rows = [];
        for (const db of [reference, databases.order])
          rows.push(
            await hold(
              db,
              'SELECT 1 FROM orders WHERE order_seq=50000 FOR UPDATE',
            ),
          );
        await run(10);
        for (const db of [reference, databases.order]) {
          assert.equal(await cancelled(db), 100);
          assert.deepEqual(
            (
              await db.query(
                'SELECT order_seq,status FROM orders WHERE order_seq IN(50000,50002) ORDER BY order_seq',
              )
            ).rows,
            [
              { order_seq: 50000, status: 'notPaid' },
              { order_seq: 50002, status: 'notPaid' },
            ],
          );
        }
        for (const row of rows) await release(row);
        await run(2);
        for (const db of [reference, databases.order]) {
          assert.equal(await cancelled(db), 117);
          await db.query(
            'UPDATE order_payment_requests SET approval_started_at=NULL,provider_payment_key=NULL WHERE order_seq=50002',
          );
        }
        await run(1);
        for (const db of [reference, databases.order])
          assert.equal(await cancelled(db), 118);
        const normalizeTime = (value) => {
          if (value === null) return null;
          assert.ok(
            value.getTime() >= started - 2000 &&
              value.getTime() <= Date.now() + 2000,
          );
          return '<changed>';
        };
        const state = async (db) => {
          const orders = (
            await db.query(
              'SELECT order_seq,status,total_amount,version,created_at,updated_at,closed_at,deleted_at,payment_due_at ' +
                'FROM orders WHERE order_seq BETWEEN 50000 AND 50120 ORDER BY order_seq',
            )
          ).rows.map((row) =>
            row.status === 'CANCELLED'
              ? {
                  ...row,
                  updated_at: normalizeTime(row.updated_at),
                  closed_at: normalizeTime(row.closed_at),
                }
              : row,
          );
          const parcels = (
            await db.query(
              'SELECT order_seq,order_parcel_seq,status FROM order_parcels WHERE order_seq BETWEEN 50000 AND 50120 ORDER BY order_seq',
            )
          ).rows;
          const requests = (
            await db.query(
              'SELECT payment_request_id,order_seq,amount,expires_at,approval_started_at,provider_payment_key,completed_at,invalidated_at ' +
                'FROM order_payment_requests WHERE order_seq BETWEEN 50000 AND 50120 ORDER BY order_seq',
            )
          ).rows.map((row) =>
            row.invalidated_at !== null && row.order_seq !== 50003
              ? { ...row, invalidated_at: normalizeTime(row.invalidated_at) }
              : row,
          );
          return { orders, parcels, requests };
        };
        assert.deepEqual(await state(databases.order), await state(reference));
        const audits = async (db) =>
          (
            await db.query(
              'SELECT actor_type,actor_seq,action,result,target_type,target_seq,metadata FROM audit_logs ' +
                "WHERE action='ORDER_CANCELLED' AND target_seq BETWEEN 50000 AND 50120 ORDER BY target_seq",
            )
          ).rows;
        const expected = await audits(reference);
        assert.equal(expected.length, 118);
        assert.ok(
          expected.every(
            (row) =>
              row.actor_type === 'SYSTEM' &&
              row.actor_seq === null &&
              row.metadata.reason === 'PAYMENT_EXPIRED',
          ),
        );
        assert.deepEqual(await audits(databases.operations), expected);
        await run(1);
        assert.deepEqual(await audits(databases.operations), expected);
        const packet = {
          eventId: randomUUID(),
          source: 'order',
          eventType: 'AuditPrepared',
          payload: {
            transactionId: randomUUID(),
            occurredAt: now.toISOString(),
            result: 'SUCCESS',
            audit: {
              actorId: null,
              actorType: 'SYSTEM',
              action: 'ORDER_CANCELLED',
              targetType: 'ORDER',
              targetId: 50000,
              requestId: randomUUID(),
              metadata: {
                amountBefore: 1000,
                amountAfter: 0,
                reason: 'PAYMENT_EXPIRED',
              },
            },
          },
        };
        for (const mutate of [
          (event) => (event.payload.audit.metadata.reason = 'user_request'),
          (event) => (event.payload.audit.metadata.amountAfter = 1),
          (event) => (event.payload.audit.actorName = 'forged'),
        ]) {
          const event = structuredClone(packet);
          event.eventId = randomUUID();
          mutate(event);
          const response = await fetch(
            'http://operations-app:3005/internal/events',
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer ' + process.env.CUSTOMER_AUTH_TOKEN,
              },
              body: JSON.stringify(event),
            },
          );
          assert.equal(response.status, 422);
        }
        t.diagnostic(
          'expiry 118 orders; 100-per-tick limit, advisory/row locks, approval protection, stored cancellation and exact system audits',
        );
      } finally {
        for (const client of [...clients]) await release(client);
        for (const item of workers) {
          await item.worker.onModuleDestroy();
          if (item.audit.onModuleDestroy) await item.audit.onModuleDestroy();
          await item.database.onModuleDestroy();
        }
      }
    },
  );
  await t.test(
    'billing charges preserve personal and organization principal, month totals and transactional audits',
    async () => {
      const requestId = randomUUID();
      for (const db of [reference, databases.customer])
        await db.query(
          "INSERT INTO organizations(organization_seq,name,status) OVERRIDING SYSTEM VALUE VALUES(6200,'청구 검증 기업','ACTIVE')",
        );
      for (const db of [reference, databases.order]) {
        const client = await db.connect();
        try {
          await client.query('BEGIN');
          await client.query("SET LOCAL session_replication_role='replica'");
          await client.query(
            'INSERT INTO orders(order_seq,customer_seq,payment_method_type,status,creation_source,total_amount,paid_at,billing_organization_seq,billing_organization_name) ' +
              'OVERRIDING SYSTEM VALUE SELECT 52000+n,CASE WHEN n=5 THEN NULL ELSE 1 END, ' +
              "CASE WHEN n IN(2,6) THEN 'groupBilling' WHEN n=3 THEN 'billing' ELSE 'credit' END, " +
              "CASE WHEN n=4 THEN 'COLLECTING' ELSE 'PAID' END,'AI',7000+n*1000, " +
              "CASE WHEN n<>4 THEN '2036-02-29T15:00:00Z'::timestamptz END, " +
              "CASE WHEN n IN(1,2) THEN 6200 END,CASE WHEN n IN(1,2) THEN '청구 검증 기업' END FROM generate_series(0,6)n",
          );
          await client.query(
            'INSERT INTO organization_billing_months(organization_seq,billing_month,organization_name,monthly_amount,group_billing_amount) ' +
              "VALUES(6200,'2036-02-01','이전 기업명',12345,678)",
          );
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      }
      const services = [];
      try {
        for (const [owner, runtime] of [
          ['monolith', './monolith-runtime'],
          ['order', '../dist'],
        ]) {
          const { DatabaseService } = require(
            runtime + '/database/database.service',
          );
          const { AuditService } = require(runtime + '/audit/audit.service');
          const config = {
            get: (key) =>
              ({
                NODE_ENV: 'test',
                DB_HOST: owner + '-db',
                DB_PORT: 5432,
                DB_USER: owner + '_app',
                DB_PASSWORD: process.env.PGPASSWORD,
                DB_NAME: process.env.PGDATABASE,
                OPERATIONS_URL: 'http://operations-app:3005',
                CUSTOMER_AUTH_TOKEN: process.env.CUSTOMER_AUTH_TOKEN,
              })[key],
          };
          const database = new DatabaseService(config);
          let audit, service;
          if (owner === 'monolith') {
            const { AuditRepository } = require(
              runtime + '/audit/audit.repository',
            );
            const { OrganizationBillingService } = require(
              runtime + '/organizations/organization-billing.service',
            );
            const { OrganizationBillingRepository } = require(
              runtime + '/organizations/organization-billing.repository',
            );
            audit = new AuditService(new AuditRepository(database));
            service = new OrganizationBillingService(
              database,
              new OrganizationBillingRepository(database),
              audit,
            );
          } else {
            const { BillingService } = require(
              runtime + '/billing/billing.service',
            );
            audit = new AuditService(database, config);
            service = new BillingService(database, audit, config);
          }
          services.push({ database, audit, service });
        }
        const snapshot = async (db) => ({
          charges: (
            await db.query(
              'SELECT order_seq,organization_seq,customer_seq,billing_month::text,payment_method_type,amount,occurred_at::text ' +
                'FROM order_billing_charges WHERE order_seq BETWEEN 52000 AND 52006 ORDER BY order_seq',
            )
          ).rows,
          months: (
            await db.query(
              'SELECT organization_seq,billing_month::text,organization_name,monthly_amount::text,group_billing_amount::text ' +
                'FROM organization_billing_months WHERE organization_seq=6200 ORDER BY billing_month',
            )
          ).rows,
        });
        for (const db of [reference, databases.order]) {
          await db.query(
            "CREATE FUNCTION charge_fixture_failure() RETURNS trigger LANGUAGE plpgsql AS $fixture$ BEGIN RAISE EXCEPTION 'test-only month failure'; END $fixture$",
          );
          await db.query(
            'CREATE TRIGGER charge_fixture_failure BEFORE INSERT ON organization_billing_months FOR EACH ROW EXECUTE FUNCTION charge_fixture_failure()',
          );
        }
        try {
          for (const { database, service } of services)
            await assert.rejects(
              database.transaction((client) =>
                service.recordCharge(client, 52001, requestId),
              ),
            );
          for (const db of [reference, databases.order])
            assert.equal((await snapshot(db)).charges.length, 0);
        } finally {
          for (const db of [reference, databases.order]) {
            await db.query(
              'DROP TRIGGER charge_fixture_failure ON organization_billing_months',
            );
            await db.query('DROP FUNCTION charge_fixture_failure()');
          }
        }
        for (const { database, service } of services) {
          // The same order lock used by approval/submission serializes concurrent retries.
          const record = (id) =>
            database.transaction(async (client) => {
              await client.query(
                'SELECT 1 FROM orders WHERE order_seq=$1 FOR UPDATE',
                [id],
              );
              await service.recordCharge(client, id, requestId);
            });
          for (let id = 52000; id <= 52006; id++) await record(id);
          await Promise.all([record(52001), record(52001), record(52002)]);
        }
        const stored = await snapshot(reference);
        assert.deepEqual(await snapshot(databases.order), stored);
        assert.deepEqual(
          stored.charges.map((row) => [
            row.order_seq,
            row.organization_seq,
            row.customer_seq,
            row.billing_month,
            row.amount,
          ]),
          [
            [52000, null, 1, '2036-03-01', 7000],
            [52001, 6200, null, '2036-03-01', 8000],
            [52002, 6200, null, '2036-03-01', 9000],
          ],
        );
        assert.deepEqual(stored.months[1], {
          organization_seq: 6200,
          billing_month: '2036-03-01',
          organization_name: '청구 검증 기업',
          monthly_amount: '8000',
          group_billing_amount: '9000',
        });
        const logs = async (db) =>
          (
            await db.query(
              'SELECT action,result,target_type,target_seq,actor_type,actor_seq,metadata FROM audit_logs WHERE request_id=$1 ORDER BY audit_log_seq',
              [requestId],
            )
          ).rows;
        const original = await logs(reference);
        for (let n = 0; n < 100; n++) {
          if ((await logs(databases.operations)).length === original.length)
            break;
          await pause(25);
        }
        assert.deepEqual(await logs(databases.operations), original);
        assert.deepEqual(
          original.map((row) => [
            row.action,
            row.metadata.paymentMethodType,
            row.metadata.amountBefore,
            row.metadata.amountAfter,
          ]),
          [
            ['BILLING_MONTH_INITIALIZED', 'credit', 12345, 0],
            ['BILLING_MONTH_INITIALIZED', 'groupBilling', 678, 0],
            ['BILLING_AMOUNT_INCREASED', 'credit', 0, 8000],
            ['BILLING_AMOUNT_INCREASED', 'groupBilling', 0, 9000],
          ],
        );
        const packet = {
          eventId: randomUUID(),
          source: 'order',
          eventType: 'AuditPrepared',
          payload: {
            transactionId: randomUUID(),
            occurredAt: new Date().toISOString(),
            result: 'SUCCESS',
            audit: {
              actorId: null,
              actorType: 'SYSTEM',
              action: 'BILLING_AMOUNT_INCREASED',
              targetType: 'ORGANIZATION',
              targetId: 6200,
              requestId,
              metadata: {
                billingMonth: '2036-03',
                paymentMethodType: 'credit',
                amountBefore: 0,
                amountAfter: 8000,
              },
            },
          },
        };
        for (const mutate of [
          (e) => (e.payload.audit.actorType = 'AI'),
          (e) => (e.payload.audit.targetType = 'ORDER'),
          (e) => (e.payload.audit.metadata.amountAfter = -1),
          (e) => (e.payload.audit.metadata.amountAfter = 2147483648),
          (e) => (e.payload.audit.metadata.paymentMethodType = 'billing'),
          (e) => (e.payload.audit.actorName = 'forged'),
        ]) {
          const event = structuredClone(packet);
          event.eventId = randomUUID();
          mutate(event);
          const response = await fetch(
            'http://operations-app:3005/internal/events',
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer ' + process.env.CUSTOMER_AUTH_TOKEN,
              },
              body: JSON.stringify(event),
            },
          );
          assert.equal(response.status, 422);
        }
        t.diagnostic(
          'billing principal 7 states; source rollback, concurrent replay, KST month boundary and four exact audits',
        );
      } finally {
        for (const { database, audit } of services) {
          if (audit.onModuleDestroy) await audit.onModuleDestroy();
          await database.onModuleDestroy();
        }
        for (const db of [reference, databases.order]) {
          await db.query(
            'DELETE FROM order_billing_charges WHERE order_seq BETWEEN 52000 AND 52006',
          );
          await db.query(
            'DELETE FROM orders WHERE order_seq BETWEEN 52000 AND 52006',
          );
          await db.query(
            'DELETE FROM organization_billing_months WHERE organization_seq=6200',
          );
        }
        for (const db of [reference, databases.customer])
          await db.query(
            'DELETE FROM organizations WHERE organization_seq=6200',
          );
      }
    },
  );
  await t.test(
    'intake completion preserves sealing, PBX waits, conversion, payment policy and retries',
    async () => {
      const started = Date.now(),
        requests = [],
        uuidMaps = [new Map(), new Map()];
      let pairs = 0;
      const intakeSides = [
        {
          ...sides[0],
          calls: reference,
          orders: reference,
          customers: reference,
          audit: reference,
        },
        {
          ...sides[1],
          base: 'http://consultation-app:3004',
          calls: databases.consultation,
          orders: databases.order,
          customers: databases.customer,
          audit: databases.operations,
        },
      ];
      const sourceSpec=await(await fetch(sides[0].base+'/api/docs-json')).json();
      const candidateSpec=await(await fetch('http://consultation-app:3004/consultation/docs-json')).json();
      const {schema}=require('./final-parity.cjs');
      const completePath='/api/calls/{id}/order-intake/complete';
      assert.deepEqual(schema(candidateSpec.paths[completePath].post,candidateSpec),schema(sourceSpec.paths[completePath].post,sourceSpec));
      const at = new Date().toISOString();
      for (const side of intakeSides) {
        for (let n = 0; n < 10; n++)
          await side.calls.query(
            'INSERT INTO call_sessions(call_session_seq,provider_call_id,caller_phone_number,customer_seq,incoming_at,registered_at,order_intake_enabled,ended_at,started_at) ' +
              "OVERRIDING SYSTEM VALUE VALUES($1,'intake-current-'||$1::int::text,'01000000006',6,$2,$2,$3,$4,$4)",
            [53000 + n, at, n !== 6, [1, 3, 4, 7, 8].includes(n) ? at : null],
          );
        await side.orders.query(
          "SELECT setval('order_parcel_drafts_draft_seq_seq',54000,false),setval('orders_order_seq_seq',55000,false),setval('order_parcels_order_parcel_seq_seq',56000,false)",
        );
      }
      const ready = {
        origin: {
          name: '발송인',
          phoneNumber: '01000000006',
          roadAddress: '서울 도로',
          jibunAddress: '서울 지번',
          detailAddress: '1층',
          dongName: '동',
          postalCode: '12345',
        },
        destination: {
          name: '수령인',
          phoneNumber: '01011112222',
          roadAddress: '부산 도로',
          jibunAddress: '부산 지번',
          detailAddress: '2층',
          dongName: '동',
          postalCode: '45678',
        },
        documentCount: 1,
        smallBoxCount: 0,
        mediumBoxCount: 0,
        bigBoxCount: 0,
        otherItemDescription: '',
        clientComment: '',
        itemPrice: 1000,
        notifiedPrice: 5000,
      };
      const normalize = (value, side, key = '') => {
        if (value === null) return null;
        if (value instanceof Date) value = value.toISOString();
        if (
          [
            'paymentRequestId',
            'payment_request_id',
            'creation_request_id',
          ].includes(key)
        ) {
          assert.match(value, /^[0-9a-f-]{36}$/i);
          const map = uuidMaps[side];
          if (!map.has(value)) map.set(value, 'generated-uuid-' + map.size);
          return map.get(value);
        }
        if (
          [
            'paymentDueAt',
            'expiresAt',
            'payment_due_at',
            'expires_at',
          ].includes(key)
        ) {
          assert.ok(
            Date.parse(value) >= started + 86400000 - 2000 &&
              Date.parse(value) <= Date.now() + 86400000 + 2000,
          );
          return '<new deadline>';
        }
        if (
          [
            'createdAt',
            'updatedAt',
            'retentionStartedAt',
            'completionReceivedAt',
            'finalizedAt',
            'created_at',
            'updated_at',
            'paid_at',
            'order_completion_received_at',
            'order_finalized_at',
            'order_finalization_attempted_at',
            'submission_first_attempt_at','submission_last_attempt_at','closed_at',
          ].includes(key)
        ) {
          const time = Date.parse(value);
          assert.ok(
            time >= started - 1000 && time <= Date.now() + 1000,
            key + ' ' + value,
          );
          return '<generated ' + key + '>';
        }
        if(value&&typeof value==='object'&&value.paid_at&&value.pickup_requested_at&&Date.parse(value.pickup_requested_at)<started+259200000) {
        const paid=Date.parse(value.paid_at),local=new Date(paid+32400000);
        const day=Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate())-32400000;
        const expected=paid+3600000>day+17*3600000?day+33*3600000:Math.max(paid+3600000,day+9*3600000);
        assert.equal(Date.parse(value.pickup_requested_at),expected,'source paid pickup policy');
        value={...value,pickup_requested_at:'<validated paid pickup>'};
      }
      if (Array.isArray(value))
          return value.map((item) => normalize(item, side));
        if (typeof value === 'object')
          return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [
              key,
              normalize(item, side, key),
            ]),
          );
        return value;
      };
      async function pair(method, path, input, status, options = {}) {
        const requestId = randomUUID(),
          bodies = [];
        requests.push(requestId);
        for (const [index, side] of intakeSides.entries()) {
          const base =
            index === 1 && !path.startsWith('/api/calls')
              ? 'http://order-app:3002'
              : side.base;
          const response = await fetch(base + path, {
            method,
            signal: AbortSignal.timeout(30000),
            headers: {
              'Content-Type': 'application/json',
              'X-Request-Id': requestId,
              Authorization: 'Bearer ' + process.env.CUSTOMER_AUTH_TOKEN,
              ...options.headers,
            },
            ...(input === undefined ? {} : { body: JSON.stringify(input) }),
          });
          const body = await response.json();
          assert.equal(
            response.status,
            status,
            index + ' ' + method + ' ' + path + ' ' + JSON.stringify(body),
          );
          assert.equal(response.headers.get('cache-control'), 'no-store');
          bodies.push(require('./final-parity.cjs').envelope(body, requestId));
        }
        assert.deepEqual(
          normalize(bodies[1], 1),
          normalize(bodies[0], 0),
          method + ' ' + path,
        );
        pairs++;
        return bodies[0].data;
      }
      const complete = (id, input, status = 200, options) =>
        pair(
          'POST',
          '/api/calls/' + id + '/order-intake/complete',
          input,
          status,
          options,
        );
      const detail = (id) =>
        pair('GET', '/api/calls/' + id + '/order-intake', undefined, 200);
      const draft = (id, status = 'READY', parcel = ready) =>
        pair(
          'POST',
          '/api/parcel-drafts',
          { clientParcelId: randomUUID(), customerSeq: 6, status, parcel },
          201,
          { headers: { call_session_seq: String(id) } },
        );
      const end = async (id) => {
        for (const side of intakeSides)
          await side.calls.query(
            'UPDATE call_sessions SET ended_at=$2,started_at=$2 WHERE call_session_seq=$1',
            [id, at],
          );
      };
      await complete(53000, { expectedIntakeVersion: 1 }, 401, {
        headers: { Authorization: '', ...headers },
      });
      for (const input of [
        {},
        { expectedIntakeVersion: 0 },
        { expectedIntakeVersion: '1' },
        { expectedIntakeVersion: 1, paymentMethodType: null },
        { expectedIntakeVersion: 1, pickupRequestedAt: '2026-02-30T12:00:00Z' },
        { expectedIntakeVersion: 1, actorId: 1 },
      ])
        await complete(53000, input, 400);
      await complete(999999, { expectedIntakeVersion: 1 }, 404);
      await complete(53006, { expectedIntakeVersion: 1 }, 409);
      assert.equal(
        (await complete(53000, { expectedIntakeVersion: 1 })).status,
        'WAITING_PBX',
      );
      await end(53000);
      assert.equal(
        (await complete(53000, { expectedIntakeVersion: 1 })).status,
        'NO_ORDER',
      );
      await complete(53000, { expectedIntakeVersion: 2 }, 409);
      const editing = await draft(53001, 'EDITING', {
        origin: { name: '입력 중' },
        documentCount: 1,
      });
      assert.equal(
        (
          await complete(53001, {
            expectedIntakeVersion: editing.intakeVersion,
          })
        ).status,
        'NO_ORDER',
      );
      const first = await draft(53002);
      await complete(
        53002,
        { expectedIntakeVersion: 1, paymentMethodType: 'billing' },
        409,
      );
      await complete(
        53002,
        { expectedIntakeVersion: first.intakeVersion },
        422,
      );
      await complete(
        53002,
        {
          expectedIntakeVersion: first.intakeVersion,
          paymentMethodType: 'credit',
        },
        403,
      );
      const billing = {
        expectedIntakeVersion: first.intakeVersion,
        paymentMethodType: 'billing',
        pickupRequestedAt: '2030-02-01T10:00:00+09:00',
      };
      assert.equal(
        (
          await complete(53002, billing, 200, {
            headers: { call_session_seq: 'invalid' },
          })
        ).status,
        'WAITING_PBX',
      );
      await pair(
        'PATCH',
        '/api/parcel-drafts/' + first.draftSeq,
        { expectedVersion: first.version, action:'CANCEL' },
        409,
        { headers: { call_session_seq: '53002' } },
      );
      await end(53002);
      const bill = await complete(53002, billing);
      assert.equal(bill.status, 'FINALIZED');
      assert.equal(bill.order.status, 'notPaid');
      assert.equal(bill.order.totalAmount, 5000);
      assert.equal(bill.parcelMappings.length, 1);
      const before = [];
      for (const side of intakeSides)
        before.push(
          (
            await side.calls.query(
              'SELECT to_jsonb(c) AS data FROM call_sessions c WHERE call_session_seq=53002',
            )
          ).rows[0].data,
        );
      await complete(53002, {
        ...billing,
        pickupRequestedAt: '2030-02-01T01:00:00Z',
      });
      for (const [index, side] of intakeSides.entries())
        assert.deepEqual(
          (
            await side.calls.query(
              'SELECT to_jsonb(c) AS data FROM call_sessions c WHERE call_session_seq=53002',
            )
          ).rows[0].data,
          before[index],
        );
      const multi1 = await draft(53003),
        multi2 = await draft(53003, 'READY', { ...ready, notifiedPrice: 7000 }),
        multi3 = await draft(53003, 'EDITING', { documentCount: 1 });
      const multi = await complete(53003, {
        expectedIntakeVersion: multi3.intakeVersion,
        paymentMethodType: 'billing',
      });
      assert.deepEqual(
        multi.parcelMappings.map((row) => row.draftSeq),
        [multi1.draftSeq, multi2.draftSeq],
      );
      assert.equal(multi.order.totalAmount, 12000);
      for (const side of intakeSides)
        await side.customers.query(
          'UPDATE customers SET monthly_billing_enabled=true WHERE customer_seq=6',
        );
      const personal = await draft(53007, 'READY', {
        ...ready,
        clientComment: 'intake-delayed-dver',
      });
      const submissionStarted=Date.now();
      const paid = await complete(53007, {
        expectedIntakeVersion: personal.intakeVersion,
        paymentMethodType: 'credit',
      });
      assert.equal(paid.order.status, 'ACCEPTED');
      assert.ok(Date.now()-submissionStarted>=11000,'both servers await the six-second Dver response');
      for (const side of intakeSides) {
        await side.customers.query(
          "INSERT INTO organizations(organization_seq,name,status,monthly_billing_enabled) OVERRIDING SYSTEM VALUE VALUES(6500,'접수 기업','ACTIVE',true)",
        );
        await side.customers.query(
          "INSERT INTO departments(department_seq,organization_seq,name,group_billing_enabled) OVERRIDING SYSTEM VALUE VALUES(6500,6500,'접수 부서',true)",
        );
        await side.customers.query(
          "INSERT INTO memberships(membership_seq,customer_seq,organization_seq,department_seq,employee_no,status) OVERRIDING SYSTEM VALUE VALUES(6500,6,6500,6500,'intake','ACTIVE')",
        );
      }
      const group = await draft(53008);
      const grouped = await complete(53008, {
        expectedIntakeVersion: group.intakeVersion,
        paymentMethodType: 'groupBilling',
      });
      assert.equal(grouped.order.status, 'ACCEPTED');
      const late = await draft(53009);
      const lateInput = {
        expectedIntakeVersion: late.intakeVersion,
        paymentMethodType: 'credit',
      };
      assert.equal((await complete(53009, lateInput)).status, 'WAITING_PBX');
      for (const side of intakeSides)
        await side.customers.query(
          "UPDATE memberships SET status='INACTIVE' WHERE membership_seq=6500",
        );
      await end(53009);
      const failed = await complete(53009, lateInput);
      assert.equal(failed.status, 'FAILED');
      assert.equal(failed.errorCode, 'FORBIDDEN');
      assert.equal(failed.orderSeq, null);
      for (const side of intakeSides)
        await side.customers.query(
          "UPDATE memberships SET status='ACTIVE' WHERE membership_seq=6500",
        );
      const recovered = await complete(53009, lateInput);
      assert.equal(recovered.order.status, 'ACCEPTED');
      await detail(53009);
      const stored = async (side) => ({
        calls: (
          await side.calls.query(
            'SELECT call_session_seq,customer_seq,order_seq,order_intake_version,order_completion_received_at,order_completion_payload,order_finalized_at,order_finalization_result,order_finalization_error_code,order_finalization_attempted_at ' +
              'FROM call_sessions WHERE call_session_seq BETWEEN 53000 AND 53009 ORDER BY call_session_seq',
          )
        ).rows,
        orders: (
          await side.orders.query(
            'SELECT to_jsonb(o) AS data FROM orders o WHERE order_seq BETWEEN 55000 AND 55020 ORDER BY order_seq',
          )
        ).rows,
        parcels: (
          await side.orders.query(
            'SELECT to_jsonb(p) AS data FROM order_parcels p WHERE order_seq BETWEEN 55000 AND 55020 ORDER BY order_parcel_seq',
          )
        ).rows,
        drafts: (
          await side.orders.query(
            'SELECT draft_seq,status,version,order_seq,order_parcel_seq FROM order_parcel_drafts WHERE draft_seq>=54000 ORDER BY draft_seq',
          )
        ).rows,
        charges: (
          await side.orders.query(
            'SELECT order_seq,organization_seq,customer_seq,billing_month::text,payment_method_type,amount FROM order_billing_charges WHERE order_seq BETWEEN 55000 AND 55020 ORDER BY order_seq',
          )
        ).rows,
        months: (
          await side.orders.query(
            'SELECT organization_seq,billing_month::text,organization_name,monthly_amount::text,group_billing_amount::text FROM organization_billing_months WHERE organization_seq=6500',
          )
        ).rows,
      });
      const source = await stored(intakeSides[0]),
        candidate = await stored(intakeSides[1]);
      assert.deepEqual(normalize(candidate, 1), normalize(source, 0));
      const logs = async (db) =>
        (
          await db.query(
            'SELECT request_id,action,result,target_type,target_seq,actor_type,actor_seq,metadata FROM audit_logs WHERE request_id=ANY($1::uuid[]) ORDER BY audit_log_seq',
            [requests],
          )
        ).rows;
      const expected = await logs(reference);
      for (let n = 0; n < 100; n++) {
        if ((await logs(databases.operations)).length === expected.length)
          break;
        await pause(25);
      }
      assert.deepEqual(await logs(databases.operations), expected);
  await complete(53005, { expectedIntakeVersion: 1 });
  await end(53005);
  for (const side of intakeSides)
    await side.calls.query(
      'UPDATE call_sessions SET order_finalization_attempted_at=clock_timestamp() WHERE call_session_seq=53005',
    );
  const {
    OrderIntakeRepository,
  } = require('./monolith-runtime/orders/order-intake.repository');
  const originalCandidates = new OrderIntakeRepository({ pool: reference });
  assert.ok(!(await originalCandidates.candidates()).includes(53005));
  const recoverEvent = () => ({
    eventId: randomUUID(),
    source: 'order',
    eventType: 'OrderIntakeRecoveryRequested',
    payload: {},
  });
  const recover = async () => {
    const response = await fetch(
      'http://consultation-app:3004/internal/parcel-draft-write/recover',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + process.env.CUSTOMER_AUTH_TOKEN,
        },
        body: JSON.stringify(recoverEvent()),
      },
    );
    assert.equal(response.status, 200, await response.text());
  };
  await recover();
  assert.equal((await detail(53005)).status, 'FINALIZING');
  for (const side of intakeSides)
    await side.calls.query(
      "UPDATE call_sessions SET order_finalization_attempted_at=clock_timestamp()-interval '61 seconds' WHERE call_session_seq=53005",
    );
  assert.ok((await originalCandidates.candidates()).includes(53005));
  const sourceRecovery = await fetch(
    sides[0].base + '/api/calls/53005/order-intake/complete',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + process.env.CUSTOMER_AUTH_TOKEN,
      },
      body: JSON.stringify({ expectedIntakeVersion: 1 }),
    },
  );
  assert.equal(sourceRecovery.status, 200);
  await recover();
  assert.equal((await detail(53005)).status, 'NO_ORDER');
  await databases.consultation.query(
    "INSERT INTO call_sessions(call_session_seq,provider_call_id,caller_phone_number,customer_seq,incoming_at,registered_at,order_intake_enabled,started_at,ended_at) OVERRIDING SYSTEM VALUE VALUES(53010,'intake-recovery','01000000006',6,$1,$1,true,$1,$1)",
    [at],
  );
  const aiHeaders = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + process.env.CUSTOMER_AUTH_TOKEN,
  };
  const createdResponse = await fetch(
    'http://order-app:3002/api/parcel-drafts',
    {
      method: 'POST',
      headers: { ...aiHeaders, call_session_seq: '53010' },
      body: JSON.stringify({
        clientParcelId: randomUUID(),
        customerSeq: 6,
        status: 'READY',
        parcel: ready,
      }),
    },
  );
  assert.equal(createdResponse.status, 201);
  const createdDraft = (await createdResponse.json()).data;
  const faultInput = {
      expectedIntakeVersion: createdDraft.intakeVersion,
      paymentMethodType: 'billing',
    },
    faultRequest = randomUUID();
  await databases.consultation.query(
    "CREATE FUNCTION intake_owner_fixture_failure() RETURNS trigger LANGUAGE plpgsql AS $fixture$ BEGIN IF NEW.call_session_seq=53010 AND NEW.order_finalized_at IS DISTINCT FROM OLD.order_finalized_at THEN RAISE EXCEPTION 'test-only owner finalization failure'; END IF; RETURN NEW; END $fixture$",
  );
  await databases.consultation.query(
    'CREATE TRIGGER intake_owner_fixture_failure BEFORE UPDATE ON call_sessions FOR EACH ROW EXECUTE FUNCTION intake_owner_fixture_failure()',
  );
  let committed;
  try {
    const response = await fetch(
      'http://consultation-app:3004/api/calls/53010/order-intake/complete',
      {
        method: 'POST',
        headers: { ...aiHeaders, 'X-Request-Id': faultRequest },
        body: JSON.stringify(faultInput),
      },
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.status, 'FAILED');
    const { finalizationId } = require('@dva/events/order-intake-write.cjs');
    committed = (
      await databases.order.query(
        "SELECT payload->'result'->'data'->'finalization' AS data FROM inbox_events WHERE event_id=$1",
        [finalizationId(53010)],
      )
    ).rows[0].data;
    assert.equal(committed.requestId, faultRequest);
    assert.equal(committed.parcelMappings.length, 1);
    assert.equal(
      (
        await databases.order.query(
          'SELECT status FROM order_parcel_drafts WHERE draft_seq=$1',
          [createdDraft.draftSeq],
        )
      ).rows[0].status,
      'CONVERTED',
    );
    assert.equal(
      (
        await databases.consultation.query(
          'SELECT order_finalized_at FROM call_sessions WHERE call_session_seq=53010',
        )
      ).rows[0].order_finalized_at,
      null,
    );
  } finally {
    await databases.consultation.query(
      'DROP TRIGGER intake_owner_fixture_failure ON call_sessions',
    );
    await databases.consultation.query(
      'DROP FUNCTION intake_owner_fixture_failure()',
    );
  }
  const retry = await fetch(
    'http://consultation-app:3004/api/calls/53010/order-intake/complete',
    { method: 'POST', headers: aiHeaders, body: JSON.stringify(faultInput) },
  );
  assert.equal(retry.status, 200);
  const repaired = (await retry.json()).data;
  assert.equal(repaired.status, 'FINALIZED');
  assert.equal(repaired.orderSeq, committed.orderSeq);
  assert.deepEqual(repaired.parcelMappings, committed.parcelMappings);
  const receipt = {
    eventId: committed.eventId,
    source: 'order',
    eventType: 'OrderIntakeFinalized',
    payload: { callSessionSeq: 53010 },
  };
  const duplicate = await fetch(
    'http://consultation-app:3004/internal/parcel-draft-write/events',
    { method: 'POST', headers: aiHeaders, body: JSON.stringify(receipt) },
  );
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).status, 'duplicate');
  const finalized = (
    await databases.operations.query(
      "SELECT request_id FROM audit_logs WHERE action='ORDER_INTAKE_FINALIZED' AND target_seq=53010",
    )
  ).rows;
  assert.deepEqual(finalized, [{ request_id: faultRequest }]);
  t.diagnostic(
    'intake recovery preserves committed order and mapping after a real owner rollback; duplicate receipt has one original-request audit',
  );

  const batchParcel = { ...multi1.parcel, clientComment: '' };
  for (const side of intakeSides) {
    await side.calls.query(
      'INSERT INTO call_sessions(call_session_seq,provider_call_id,caller_phone_number,customer_seq,incoming_at,registered_at,order_intake_enabled,order_intake_version,started_at,ended_at) ' +
        "OVERRIDING SYSTEM VALUE SELECT 53100+n,'intake-batch-'||n::text,'01000000006',6,$1,$1,true,2,$1,$1 FROM generate_series(0,19)n",
      [at],
    );
    await side.orders.query(
      'INSERT INTO order_parcel_drafts(draft_seq,reserved_order_seq,call_session_seq,customer_seq,caller_phone_number,client_parcel_id,creation_payload,parcel_data,status) ' +
        "OVERRIDING SYSTEM VALUE SELECT 57000+n,58000+n,53100+n,6,'01000000006',gen_random_uuid(),'{}'::jsonb,$1::jsonb,'READY' FROM generate_series(0,19)n",
      [batchParcel],
    );
  }
  const batchRequests = Array.from({ length: 20 }, () => randomUUID());
  const batchResults = [];
  for (const side of intakeSides) {
    const results = await Promise.all(
      batchRequests.map(async (requestId, n) => {
        const response = await fetch(
          side.base + '/api/calls/' + (53100 + n) + '/order-intake/complete',
          {
            method: 'POST',
            signal: AbortSignal.timeout(60000),
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer ' + process.env.CUSTOMER_AUTH_TOKEN,
              'X-Request-Id': requestId,
            },
            body: JSON.stringify({
              expectedIntakeVersion: 2,
              paymentMethodType: 'credit',
            }),
          },
        );
        const body = await response.json();
        return {
          id: 53100 + n,
          httpStatus: response.status,
          status: body.data?.status,
          orderSeq: body.data?.orderSeq,
          orderStatus: body.data?.order?.status,
          error: body.error?.code,
        };
      }),
    );
    batchResults.push(results);
  }
  for (const results of batchResults)
    assert.deepEqual(
      results.map(
        ({ id, httpStatus, status, orderSeq, orderStatus, error }) => ({
          id,
          httpStatus,
          status,
          orderSeq,
          orderStatus,
          error,
        }),
      ),
      Array.from({ length: 20 }, (_, n) => ({
        id: 53100 + n,
        httpStatus: 200,
        status: 'FINALIZED',
        orderSeq: 58000 + n,
        orderStatus: 'ACCEPTED',
        error: undefined,
      })),
    );
  t.diagnostic(
    'twenty concurrent completions preserve initial FINALIZED/ACCEPTED responses and distinct reserved orders',
  );
      t.diagnostic(
        'intake completion HTTP pairs: ' +
          pairs +
          '; READY conversion, immutable sealing, PBX wait, all payment methods and policy repair',
      );
    },
  );
  await t.test(
    'order updates preserve legacy caller bounds, all administrator states, pins, totals and payment requests',
    async () => {
      const original = sides[0].base,
        candidate = sides[1].base,
        started = Date.now(),
        at = new Date().toISOString(),
        due = new Date(Date.now() + 3600000).toISOString();
      const owners = [
        {
          ...sides[0],
          calls: reference,
          orders: reference,
          customers: reference,
          audit: reference,
        },
        {
          ...sides[1],
          calls: databases.consultation,
          orders: databases.order,
          customers: databases.customer,
          audit: databases.operations,
        },
      ];
      const address = (name) => ({
        name,
        phoneNumber: '01070707070',
        roadAddress: '수정 도로',
        jibunAddress: '수정 지번',
        detailAddress: '101호',
        dongName: '동',
        postalCode: '12345',
      });
      const origin = address('발송인'),
        destination = address('수령인');
      const methods = [
        'COLLECTING',
        'notPaid',
        'PAID',
        'SUBMITTING',
        'SUBMITTING_FAILED',
        'ACCEPTED',
        'SUBMISSION_FAILED',
        'CANCELLED',
      ];
      const keys = [randomUUID(), randomUUID()];
      for (const side of owners) {
        for (const [id, status, deleted] of [
          [97001, 'ACTIVE', null],
          [97002, 'ACTIVE', null],
          [97003, 'WITHDRAWN', null],
          [97004, 'ACTIVE', at],
        ])
          await side.customers.query(
            'INSERT INTO customers(customer_seq,name,phone_number,status,deleted_at) OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4,$5)',
            [
              id,
              '수정 고객 ' + id,
              '0107070707' + (id - 97001),
              status,
              deleted,
            ],
          );
        for (const [id, customer] of [
          [97001, 97001],
          [97002, 97002],
        ])
          await side.customers.query(
            'INSERT INTO personal_pins(personal_pin_seq,customer_seq,address_data) OVERRIDING SYSTEM VALUE VALUES($1,$2,$3)',
            [id, customer, origin],
          );
        for (let n = 1; n <= 11; n++)
          await side.calls.query(
            'INSERT INTO call_sessions(call_session_seq,provider_call_id,caller_phone_number,customer_seq,order_seq,incoming_at,registered_at,order_intake_enabled,deleted_at,started_at,ended_at) ' +
              "OVERRIDING SYSTEM VALUE VALUES($1,'update-call-'||$1::int::text,$2,$3,$4,$5,$5,$6,$7,$8,$8)",
            [
              97000 + n,
              n === 8 ? null : n === 7 ? '01070707071' : '01070707070',
              n === 1 ? null : 97001,
              null,
              [1, 10].includes(n)
                ? null
                : [5, 9].includes(n)
                  ? '2000-01-01T00:00:00Z'
                  : at,
              n === 5,
              [5, 6].includes(n) ? at : null,
              [3, 4].includes(n) ? at : null,
            ],
          );
        const held = await side.calls.connect();
        await held.query('BEGIN');
        await held.query(
          'SELECT 1 FROM call_sessions WHERE call_session_seq IN(97005,97006,97009) FOR KEY SHARE',
        );
        retention.push(held);
        const client = await side.orders.connect();
        try {
          await client.query('BEGIN');
          await client.query("SET LOCAL session_replication_role='replica'");
          for (let n = 0; n < 16; n++) {
            const status =
              n < 8 ? methods[n] : n === 12 ? 'notPaid' : 'COLLECTING';
            await client.query(
              'INSERT INTO orders(order_seq,customer_seq,payment_method_type,status,total_amount,creation_source,version,created_at,updated_at,payment_due_at,paid_at,pickup_requested_at,parcel_no,dver_received_at,closed_at,deleted_at) ' +
                "OVERRIDING SYSTEM VALUE VALUES($1,$2,'billing',$3,$4,'ADMIN',1,$5,$5,$6,$7,'2030-02-01T00:00:00Z',$8,$9,$10,$11)",
              [
                61000 + n,
                n === 8 ? 97003 : n === 9 ? null : n === 15 ? 97004 : 97001,
                status,
                n === 7 ? 0 : 5000,
                at,
                [1, 12].includes(n) ? due : null,
                [
                  'PAID',
                  'SUBMITTING',
                  'SUBMITTING_FAILED',
                  'ACCEPTED',
                  'SUBMISSION_FAILED',
                ].includes(status)
                  ? at
                  : null,
                n === 5 ? 'EDIT0052' : null,
                n === 5 ? at : null,
                [5, 7].includes(n) ? at : null,
                n === 11 ? at : null,
              ],
            );
            const columns = Object.fromEntries(
              ['origin', 'destination'].flatMap((side) =>
                Object.entries(side === 'origin' ? origin : destination).map(
                  ([name, value]) => [
                    side +
                      '_' +
                      name.replace(
                        /[A-Z]/g,
                        (letter) => '_' + letter.toLowerCase(),
                      ),
                    value,
                  ],
                ),
              ),
            );
            const parcel = {
              ...columns,
              order_parcel_seq: 72000 + n,
              order_seq: 61000 + n,
              parcel_position: 1,
              status: n === 7 ? 'CANCELLED' : 'ACTIVE',
              document_count: 1,
              small_box_count: 0,
              medium_box_count: 0,
              big_box_count: 0,
              other_item_description: '',
              client_comment: '기존 메모',
              item_price: 1000,
              notified_price: 5000,
              origin_pin_scope: n === 13 ? 'COMPANY' : null,
              origin_pin_seq: n === 13 ? 99913 : null,
              created_at: at,
              updated_at: at,
            };
            await client.query(
              'INSERT INTO order_parcels OVERRIDING SYSTEM VALUE SELECT * FROM jsonb_populate_record(NULL::order_parcels,$1::jsonb)',
              [parcel],
            );
          }
          await client.query(
            'INSERT INTO order_parcels OVERRIDING SYSTEM VALUE SELECT (jsonb_populate_record(NULL::order_parcels,to_jsonb(p)||$1::jsonb)).* FROM order_parcels p WHERE order_parcel_seq=72000',
            [
              {
                order_parcel_seq: 72016,
                parcel_position: 2,
                status: 'CANCELLED',
              },
            ],
          );
          for (const [n, index] of [
            [1, 0],
            [12, 1],
          ])
            await client.query(
              'INSERT INTO order_payment_requests(payment_request_id,order_seq,amount,expires_at,created_at,approval_started_at,provider_payment_key) VALUES($1,$2,5000,$3,$4,$5,$6)',
              [
                keys[index],
                61000 + n,
                due,
                at,
                n === 12 ? at : null,
                n === 12 ? 'update-approval-key' : null,
              ],
            );
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
        await side.calls.query(
          'UPDATE call_sessions SET order_seq=CASE WHEN call_session_seq IN(97002,97011) THEN 61001 ELSE 61000 END WHERE call_session_seq IN(97002,97003,97011)',
        );
        await side.orders.query(
          "SELECT setval('order_parcels_order_parcel_seq_seq',73000,false)",
        );
        await side.orders.query(
          'INSERT INTO order_parcel_drafts(draft_seq,reserved_order_seq,customer_seq,client_parcel_id,creation_payload,parcel_data,status,legacy_order_seq,legacy_order_parcel_seq) ' +
            "OVERRIDING SYSTEM VALUE VALUES(58000,99000,97001,$1,'{}',$2,'INCOMPLETE',61010,72010)",
          [
            randomUUID(),
            {
              ...origin,
              origin,
              destination,
              originPin: null,
              documentCount: 1,
            },
          ],
        );
      }
      const sourceSpec = await (
          await fetch(original + '/api/docs-json')
        ).json(),
        targetSpec = await (await fetch(candidate + '/order/docs-json')).json();
      const {
        schema,
        envelope,
        generatedTimes,
      } = require('./final-parity.cjs');
      assert.deepEqual(
        schema(targetSpec.paths['/api/orders/{id}'].patch, targetSpec),
        schema(sourceSpec.paths['/api/orders/{id}'].patch, sourceSpec),
      );
      let pairs = 0;
      const requestIds = [];
      const version = async (id) =>
        (
          await reference.query(
            'SELECT version FROM orders WHERE order_seq=$1',
            [id],
          )
        ).rows[0].version;
      async function pair(id, input, status = 200, options = {}) {
        const requestId = randomUUID(),
          bodies = [];
        requestIds.push(requestId);
        const authorization = options.ai
          ? {
              Authorization: 'Bearer ' + process.env.CUSTOMER_AUTH_TOKEN,
              call_session_seq: String(options.call ?? 97001),
            }
          : {
              Cookie: 'dva_session=' + tokens[(options.admin ?? 1) - 1],
              Origin: 'http://localhost:5173',
            };
        for (const side of owners) {
          const response = await fetch(side.base + '/api/orders/' + id, {
            method: 'PATCH',
            signal: AbortSignal.timeout(30000),
            headers: {
              'Content-Type': 'application/json',
              'X-Request-Id': requestId,
              ...authorization,
              ...options.headers,
            },
            body: JSON.stringify(input),
          });
          const body = await response.json();
          assert.equal(
            response.status,
            status,
            side.name + ' PATCH ' + id + ' ' + JSON.stringify(body),
          );
          assert.equal(response.headers.get('cache-control'), 'no-store');
          bodies.push(envelope(body, requestId));
          if (status === 200)
            assert.equal(
              body.data.version,
              (
                await side.orders.query(
                  'SELECT version FROM orders WHERE order_seq=$1',
                  [id],
                )
              ).rows[0].version,
            );
        }
        assert.deepEqual(bodies[1], bodies[0], 'PATCH ' + id);
        pairs++;
        return bodies[0].data;
      }
      await pair(61000, { expectedVersion: 1, pickupRequestedAt: null }, 401, {
        ai: true,
        headers: { Authorization: '' },
      });
      for (const input of [
        {},
        { expectedVersion: 1 },
        { expectedVersion: '1', totalAmount: 5 },
        { expectedVersion: 1, customerSeq: 97001 },
        { expectedVersion: 1, pickupRequestedAt: '2026-02-30T00:00:00Z' },
        { expectedVersion: 1, parcels: [{ orderParcelSeq: 72000 }] },
        {
          expectedVersion: 1,
          parcels: [
            { orderParcelSeq: 72000, clientComment: 'a' },
            { orderParcelSeq: 72000, clientComment: 'b' },
          ],
        },
        {
          expectedVersion: 1,
          removeParcelSeqs: [72000],
          parcels: [{ orderParcelSeq: 72000, clientComment: 'a' }],
        },
      ])
        await pair(61000, input, 400);
      await pair(
        61000,
        { expectedVersion: 1, removeParcelSeqs: [72000] },
        403,
        { ai: true, headers: { call_session_seq: 'invalid' } },
      );
      await pair(61000, { expectedVersion: 1, pickupRequestedAt: null }, 400, {
        ai: true,
        headers: { call_session_seq: 'invalid' },
      });
      for (const [call, status] of [
        [97002, 409],
        [97004, 409],
        [97005, 409],
        [97006, 404],
        [97007, 403],
        [97008, 403],
        [97009, 404],
        [999999, 404],
      ])
        await pair(
          61000,
          { expectedVersion: 1, pickupRequestedAt: null },
          status,
          { ai: true, call },
        );
      await pair(61008, { expectedVersion: 1, pickupRequestedAt: null }, 403);
      await pair(61009, { expectedVersion: 1, pickupRequestedAt: null }, 403);
      await pair(61010, { expectedVersion: 1, pickupRequestedAt: null }, 409);
      await pair(61011, { expectedVersion: 1, pickupRequestedAt: null }, 404);
      await pair(61015, { expectedVersion: 1, pickupRequestedAt: null }, 404);
      await pair(999999, { expectedVersion: 1, pickupRequestedAt: null }, 404);
      await pair(61000, { expectedVersion: 2, pickupRequestedAt: null }, 409);
      await pair(
        61000,
        {
          expectedVersion: 1,
          parcels: [{ orderParcelSeq: 72016, destination: { name: '금지' } }],
        },
        409,
        { ai: true },
      );
      await pair(
        61000,
        {
          expectedVersion: 1,
          parcels: [
            {
              orderParcelSeq: 72000,
              originPin: { scope: 'PERSONAL', pinSeq: 97002 },
            },
          ],
        },
        403,
        { ai: true },
      );
      await pair(
        61000,
        {
          expectedVersion: 1,
          parcels: [
            {
              orderParcelSeq: 72000,
              originPin: { scope: 'PERSONAL', pinSeq: 97001 },
              destination: { detailAddress: null },
              clientComment: 'AI 수정',
            },
          ],
          pickupRequestedAt: null,
        },
        200,
        { ai: true },
      );
      await pair(61000, { expectedVersion: 1, pickupRequestedAt: null }, 409, {
        ai: true,
      });
      await pair(61001, { expectedVersion: 1, pickupRequestedAt: null }, 409, {
        ai: true,
        call: 97011,
      });
      await pair(
        61000,
        { expectedVersion: await version(61000), removeParcelSeqs: [72001] },
        404,
      );
      await pair(
        61000,
        {
          expectedVersion: await version(61000),
          parcels: [
            {
              originPin: { scope: 'COMPANY', pinSeq: 99913 },
              documentCount: 1,
            },
          ],
        },
        400,
      );
      await pair(
        61013,
        {
          expectedVersion: 1,
          parcels: [
            { orderParcelSeq: 72013, origin: { detailAddress: '금지 변경' } },
          ],
        },
        400,
      );
      await pair(61013, {
        expectedVersion: 1,
        parcels: [
          { orderParcelSeq: 72013, destination: { name: '기업 기록 유지' } },
        ],
      });
      await pair(61013, {
        expectedVersion: await version(61013),
        parcels: [{ orderParcelSeq: 72013, originPin: null }],
      });
      for (const [header, status] of [
        ['ignored', 400],
        ['97002', 409],
        ['97005', 404],
        ['97007', 403],
      ])
        await pair(
          61000,
          { expectedVersion: await version(61000), pickupRequestedAt: null },
          status,
          {
            headers: { call_session_seq: header },
          },
        );
      await pair(
        61000,
        { expectedVersion: await version(61000), pickupRequestedAt: null },
        200,
        {
          headers: { call_session_seq: '97003' },
        },
      );
      for (let n = 0; n < 8; n++)
        await pair(
          61000 + n,
          {
            expectedVersion: await version(61000 + n),
            parcels: [
              {
                orderParcelSeq: 72000 + n,
                destination: { detailAddress: '관리자 ' + n },
              },
            ],
          },
          200,
          { admin: (n % 3) + 1 },
        );
      await pair(
        61002,
        { expectedVersion: await version(61002), paymentMethodType: 'credit' },
        409,
      );
      await pair(
        61012,
        {
          expectedVersion: 1,
          parcels: [{ orderParcelSeq: 72012, clientComment: '진행 중' }],
        },
        409,
      );
      await pair(61001, {
        expectedVersion: await version(61001),
        parcels: [{ orderParcelSeq: 72001, notifiedPrice: 6000 }],
      });
      await pair(
        61001,
        { expectedVersion: await version(61001), totalAmount: 6001 },
        422,
      );
      await pair(61000, {
        expectedVersion: await version(61000),
        parcels: [{ documentCount: 2, notifiedPrice: 7000, itemPrice: 1000 }],
        paymentMethodType: 'credit',
      });
      await pair(61000, {
        expectedVersion: await version(61000),
        removeParcelSeqs: [72000],
      });
      const uuidMaps = [new Map(), new Map()];
      const normalize = (value, index, key = '') => {
        if (value === null) return null;
        if (value instanceof Date) value = value.toISOString();
        if (key === 'payment_request_id') {
          assert.match(value, /^[0-9a-f-]{36}$/i);
          const map = uuidMaps[index];
          if (!map.has(value)) map.set(value, 'payment-' + map.size);
          return map.get(value);
        }
        if (key === 'invalidated_at') {
          assert.ok(
            Date.parse(value) >= started - 1000 &&
              Date.parse(value) <= Date.now() + 1000,
          );
          return '<new invalidation>';
        }
        if (Array.isArray(value))
          return value.map((item) => normalize(item, index));
        if (typeof value === 'object')
          return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [
              key,
              normalize(item, index, key),
            ]),
          );
        return value;
      };
      const stored = async (side) => ({
        orders: (
          await side.orders.query(
            'SELECT to_jsonb(o) AS data FROM orders o WHERE order_seq BETWEEN 61000 AND 61015 ORDER BY order_seq',
          )
        ).rows,
        parcels: (
          await side.orders.query(
            'SELECT to_jsonb(p) AS data FROM order_parcels p WHERE order_seq BETWEEN 61000 AND 61015 ORDER BY order_seq,parcel_position',
          )
        ).rows,
        calls: (
          await side.calls.query(
            'SELECT call_session_seq,order_seq,customer_seq,order_intake_version FROM call_sessions WHERE call_session_seq BETWEEN 97001 AND 97011 ORDER BY call_session_seq',
          )
        ).rows,
        payments: (
          await side.orders.query(
            'SELECT to_jsonb(p) AS data FROM order_payment_requests p WHERE order_seq BETWEEN 61000 AND 61015 ORDER BY order_seq,created_at,payment_request_id',
          )
        ).rows,
        charges: (
          await side.orders.query(
            'SELECT * FROM order_billing_charges WHERE order_seq BETWEEN 61000 AND 61015',
          )
        ).rows,
      });
      const before = await stored(owners[0]),
        after = await stored(owners[1]);
      assert.deepEqual(
        normalize(generatedTimes(after, started - 1000, Date.now() + 1000), 1),
        normalize(generatedTimes(before, started - 1000, Date.now() + 1000), 0),
      );
      assert.equal(after.charges.length, 0);
      const paymentRows = after.payments
        .map((row) => row.data)
        .filter((row) => row.order_seq === 61001);
      assert.equal(paymentRows.length, 2);
      assert.equal(
        paymentRows.filter((row) => row.invalidated_at === null)[0].amount,
        6000,
      );
      assert.ok(paymentRows.some((row) => row.invalidated_at !== null));
      assert.equal(after.calls[0].order_seq, 61000);
      assert.equal(after.calls[0].customer_seq, 97001);
      assert.equal(after.calls[0].order_intake_version, 1);
      const logs = async (db) =>
        (
          await db.query(
            'SELECT request_id,action,result,target_type,target_seq,actor_type,actor_seq,metadata FROM audit_logs WHERE request_id=ANY($1::uuid[]) ORDER BY audit_log_seq',
            [requestIds],
          )
        ).rows;
      const audits = await logs(reference);
      for (let n = 0; n < 100; n++) {
        if ((await logs(databases.operations)).length === audits.length) break;
        await pause(25);
      }
      assert.deepEqual(await logs(databases.operations), audits);
      const aiHeaders = {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + process.env.CUSTOMER_AUTH_TOKEN,
        call_session_seq: '97010',
      };
      const faultInput = {
        expectedVersion: 1,
        parcels: [{ orderParcelSeq: 72014, clientComment: '커밋된 수정' }],
      };
      await databases.consultation.query(
        "CREATE FUNCTION order_link_fixture_failure() RETURNS trigger LANGUAGE plpgsql AS $fixture$ BEGIN IF NEW.event_type='OrderCallLinked' AND (NEW.payload->>'callSessionSeq')::int=97010 THEN RAISE EXCEPTION 'test-only call link acknowledgement failure'; END IF; RETURN NEW; END $fixture$",
      );
      await databases.consultation.query(
        'CREATE TRIGGER order_link_fixture_failure BEFORE INSERT ON inbox_events FOR EACH ROW EXECUTE FUNCTION order_link_fixture_failure()',
      );
      let receipt, committedVersion;
      try {
        const response = await fetch(candidate + '/api/orders/61014', {
          method: 'PATCH',
          headers: aiHeaders,
          body: JSON.stringify(faultInput),
        });
        assert.equal(response.status, 500);
        await response.body.cancel();
        committedVersion = (
          await databases.order.query(
            'SELECT version FROM orders WHERE order_seq=61014',
          )
        ).rows[0].version;
        assert.ok(committedVersion > 1);
        assert.equal(
          (
            await databases.order.query(
              'SELECT client_comment FROM order_parcels WHERE order_parcel_seq=72014',
            )
          ).rows[0].client_comment,
          '커밋된 수정',
        );
        assert.equal(
          (
            await databases.consultation.query(
              'SELECT order_seq FROM call_sessions WHERE call_session_seq=97010',
            )
          ).rows[0].order_seq,
          null,
        );
        receipt = (
          await databases.order.query(
            "SELECT event_id,payload FROM outbox_events WHERE destination='consultation' AND event_type='OrderCallLinked' AND aggregate_seq=97010 ORDER BY outbox_seq",
          )
        ).rows[0];
        assert.equal(receipt.payload.orderSeq, 61014);
      } finally {
        await databases.consultation.query(
          'DROP TRIGGER order_link_fixture_failure ON inbox_events',
        );
        await databases.consultation.query(
          'DROP FUNCTION order_link_fixture_failure()',
        );
      }
      const event = {
        eventId: receipt.event_id,
        source: 'order',
        eventType: 'OrderCallLinked',
        payload: receipt.payload,
      };
      for (let n = 0; n < 2; n++) {
        const response = await fetch(
          'http://consultation-app:3004/internal/parcel-draft-write/events',
          { method: 'POST', headers: aiHeaders, body: JSON.stringify(event) },
        );
        assert.equal(response.status, 200);
        assert.ok(
          ['processed', 'duplicate'].includes((await response.json()).status),
        );
      }
      assert.deepEqual(
        (
          await databases.consultation.query(
            'SELECT order_seq,customer_seq,order_intake_version FROM call_sessions WHERE call_session_seq=97010',
          )
        ).rows,
        [{ order_seq: 61014, customer_seq: 97001, order_intake_version: 1 }],
      );
      const retry = await fetch(candidate + '/api/orders/61014', {
        method: 'PATCH',
        headers: aiHeaders,
        body: JSON.stringify(faultInput),
      });
      assert.equal(retry.status, 409);
      assert.equal((await retry.json()).error.code, 'VERSION_CONFLICT');
      assert.equal(
        (
          await databases.order.query(
            'SELECT version FROM orders WHERE order_seq=61014',
          )
        ).rows[0].version,
        committedVersion,
      );
      assert.equal(
        (
          await databases.consultation.query(
            'SELECT count(*)::int AS n FROM inbox_events WHERE event_id=$1',
            [receipt.event_id],
          )
        ).rows[0].n,
        1,
      );
      t.diagnostic(
        'committed order edit restores its legacy call after a real owner acknowledgement rollback and duplicate event replay',
      );
      t.diagnostic(
        'order update HTTP pairs: ' +
          pairs +
          '; legacy/new calls, all administrator states, personal/company pins, retained cancellation, totals and payment replacement',
      );
    },
  );

  await t.test(
    'order submission preserves caller scope, all states, recipient pins and payment preparation',
    async () => {
      const started = Date.now(),
        at = new Date().toISOString(),
        stale = new Date(started - 120000).toISOString();
      const delivery = new Pool({ host: 'delivery-db', user: 'delivery_app' });
      t.after(() => delivery.end());
      const owners = [
        {
          ...sides[0],
          orders: reference,
          calls: reference,
          customers: reference,
          shipments: reference,
          audit: reference,
        },
        {
          ...sides[1],
          orders: databases.order,
          calls: databases.consultation,
          customers: databases.customer,
          shipments: delivery,
          audit: databases.operations,
        },
      ];
      const address = (name) => ({
        name,
        phoneNumber: '01080808080',
        roadAddress: '접수 도로',
        jibunAddress: '접수 지번',
        detailAddress: '101호',
        dongName: '동',
        postalCode: '12345',
      });
      const states = new Map([
        [7, 'notPaid'],
        [8, 'PAID'],
        [9, 'SUBMITTING'],
        [10, 'SUBMITTING'],
        [11, 'SUBMISSION_FAILED'],
        [12, 'CANCELLED'],
      ]);
      for (const side of owners) {
        await side.customers.query(
          "INSERT INTO customers(customer_seq,name,phone_number,status,monthly_billing_enabled,deleted_at) OVERRIDING SYSTEM VALUE VALUES(98001,'접수 개인','01080808080','ACTIVE',true,NULL),(98002,'탈퇴','01080808081','WITHDRAWN',false,NULL),(98003,'삭제','01080808082','ACTIVE',false,$1),(98004,'소속','01080808083','ACTIVE',false,NULL),(98005,'일반','01080808084','ACTIVE',false,NULL)",
          [at],
        );
        await side.customers.query(
          "INSERT INTO organizations(organization_seq,name,status,monthly_billing_enabled) OVERRIDING SYSTEM VALUE VALUES(9800,'일반 접수 기업','ACTIVE',true)",
        );
        await side.customers.query(
          "INSERT INTO departments(department_seq,organization_seq,name,group_billing_enabled) OVERRIDING SYSTEM VALUE VALUES(9800,9800,'접수 부서',true)",
        );
        await side.customers.query(
          "INSERT INTO memberships(membership_seq,customer_seq,organization_seq,department_seq,employee_no,status) OVERRIDING SYSTEM VALUE VALUES(9800,98004,9800,9800,'submit','ACTIVE')",
        );
        await side.customers.query(
          "SELECT setval(pg_get_serial_sequence('personal_pins','personal_pin_seq'),200000,true)",
        );
        const client = await side.orders.connect();
        try {
          await client.query('BEGIN');
          await client.query("SET LOCAL session_replication_role='replica'");
          for (let n = 0; n <= 24; n++) {
            const status = states.get(n) ?? 'COLLECTING',
              customer =
                n === 4
                  ? 98002
                  : n === 5
                    ? 98003
                    : n === 6
                      ? null
                      : n === 3
                        ? 98004
                        : n === 17
                          ? 98005
                          : 98001;
            await client.query(
              "INSERT INTO orders(order_seq,customer_seq,payment_method_type,status,total_amount,creation_source,version,created_at,updated_at,payment_due_at,paid_at,pickup_requested_at,submission_first_attempt_at,submission_last_attempt_at,closed_at) OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4,$5,$6,1,$7,$7,$8,$9,'2030-02-01T00:00:00Z',$10,$11,$12)",
              [
                62000 + n,
                customer,
                [2, 17].includes(n)
                  ? 'credit'
                  : n === 3
                    ? 'groupBilling'
                    : 'billing',
                status,
                n === 12 ? 0 : n === 24 ? 180 * 5000 : n === 1 ? 10000 : 5000,
                n === 0 ? 'AI' : 'ADMIN',
                at,
                n === 7 ? new Date(started + 3600000).toISOString() : null,
                ['PAID', 'SUBMITTING', 'SUBMISSION_FAILED'].includes(status)
                  ? at
                  : null,
                [9, 10].includes(n) ? stale : null,
                n === 9
                  ? new Date(started + 300000).toISOString()
                  : n === 10
                    ? stale
                    : null,
                n === 12 ? at : null,
              ],
            );
            const origin = address('발송인'),
              destination = address('수령인 ' + n),
              columns = Object.fromEntries(
                ['origin', 'destination'].flatMap((prefix) =>
                  Object.entries(
                    prefix === 'origin' ? origin : destination,
                  ).map(([key, value]) => [
                    prefix +
                      '_' +
                      key.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase()),
                    value,
                  ]),
                ),
              );
            const parcel = {
              ...columns,
              order_parcel_seq: 76000 + n,
              order_seq: 62000 + n,
              parcel_position: 1,
              status: n === 12 ? 'CANCELLED' : 'ACTIVE',
              document_count: 1,
              small_box_count: 0,
              medium_box_count: 0,
              big_box_count: 0,
              other_item_description: '',
              client_comment: '접수 검증',
              item_price: 1000,
              notified_price: n === 14 ? 4000 : 5000,
              origin_pin_scope: n === 16 ? 'PERSONAL' : null,
              origin_pin_seq: n === 16 ? 97002 : null,
              created_at: at,
              updated_at: at,
            };
            await client.query(
              'INSERT INTO order_parcels OVERRIDING SYSTEM VALUE SELECT * FROM jsonb_populate_record(NULL::order_parcels,$1::jsonb)',
              [parcel],
            );
          }
          await client.query(
            'INSERT INTO order_parcels OVERRIDING SYSTEM VALUE SELECT (jsonb_populate_record(NULL::order_parcels,to_jsonb(p)||$1::jsonb)).* FROM order_parcels p WHERE order_parcel_seq=76001',
            [{ order_parcel_seq: 76100, parcel_position: 2 }],
          );
          await client.query(
            "UPDATE order_parcels SET destination_detail_address=repeat('대',2000) WHERE order_seq=62024",
          );
          await client.query(
            "INSERT INTO order_parcels OVERRIDING SYSTEM VALUE SELECT (jsonb_populate_record(NULL::order_parcels,to_jsonb(p)||jsonb_build_object('order_parcel_seq',77000+n,'parcel_position',n+1))).* FROM order_parcels p CROSS JOIN generate_series(1,179) n WHERE p.order_parcel_seq=76024",
          );
          await client.query(
            "INSERT INTO order_parcel_drafts(draft_seq,reserved_order_seq,customer_seq,client_parcel_id,creation_payload,parcel_data,status,legacy_order_seq,legacy_order_parcel_seq) OVERRIDING SYSTEM VALUE SELECT 59000,9900000,98001,'00000000-0000-4000-8000-000000059000','{}',parcel_data,'INCOMPLETE',62013,76013 FROM order_parcel_drafts WHERE draft_seq=58000",
          );
          await client.query(
            "SELECT setval(pg_get_serial_sequence('order_parcels','order_parcel_seq'),78000,true)",
          );
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
        for (let n = 1; n <= 9; n++)
          await side.calls.query(
            'INSERT INTO call_sessions(call_session_seq,provider_call_id,caller_phone_number,customer_seq,order_seq,incoming_at,registered_at,order_intake_enabled,deleted_at,started_at,ended_at) OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9,$9)',
            [
              98000 + n,
              'order-submit-' + n,
              n === 4
                ? '01080808084'
                : n === 7
                  ? '010-8080-8080'
                  : '01080808080',
              n === 2 || n === 9 ? 62007 : n === 8 ? 62002 : null,
              n === 1 ? null : [5, 6].includes(n) ? '2000-01-01T00:00:00Z' : at,
              at,
              n === 5,
              [5, 6].includes(n) ? at : null,
              [2, 3, 9].includes(n) ? at : null,
            ],
          );
        const guard = await side.calls.connect();
        await guard.query('BEGIN');
        await guard.query(
          'SELECT 1 FROM call_sessions WHERE call_session_seq IN(98005,98006) FOR KEY SHARE',
        );
        retention.push(guard);
        await side.shipments.query(
          "INSERT INTO shipments(order_parcel_seq,tracking_number,status) VALUES(76015,'submit-already-exists','received')",
        );
      }
      const schemas = [];
      for (const side of owners) {
        const response = await fetch(
          side.base +
            (side.name === 'monolith' ? '/api' : '/order') +
            '/docs-json',
        );
        schemas.push(await response.json());
      }
      const { envelope, schema } = require('./final-parity.cjs');
      assert.deepEqual(
        schema(schemas[1].paths['/api/orders/{id}/submit'].post, schemas[1]),
        schema(schemas[0].paths['/api/orders/{id}/submit'].post, schemas[0]),
      );
      const requestIds = [];
      let pairs = 0;
      async function pair(
        id,
        input = { expectedVersion: 1 },
        status = 200,
        options = {},
      ) {
        const requestId = randomUUID(),
          bodies = [];
        requestIds.push(requestId);
        const auth = options.ai
          ? {
              Authorization: 'Bearer ' + process.env.CUSTOMER_AUTH_TOKEN,
              call_session_seq: String(options.call ?? 98001),
            }
          : {
              Cookie: 'dva_session=' + tokens[(options.admin ?? 1) - 1],
              Origin: 'http://localhost:5173',
            };
        for (const side of owners) {
          const response = await fetch(
              side.base + '/api/orders/' + id + '/submit',
              {
                method: 'POST',
                signal: AbortSignal.timeout(30000),
                headers: {
                  'Content-Type': 'application/json',
                  'X-Request-Id': requestId,
                  ...auth,
                  ...options.headers,
                },
                body: JSON.stringify(input),
              },
            ),
            body = await response.json();
          assert.equal(
            response.status,
            status,
            side.name + ' submit ' + id + ' ' + JSON.stringify(body),
          );
          assert.equal(response.headers.get('cache-control'), 'no-store');
          assert.equal(
            response.headers.get('location'),
            status === 202 ? '/api/orders/' + id : null,
          );
          if (status < 300)
            assert.deepEqual(Object.keys(body.data), ['status']);
          bodies.push(envelope(body, requestId));
        }
        assert.deepEqual(bodies[1], bodies[0], 'submit ' + id);
        pairs++;
        return bodies[0].data;
      }
      await pair(62000, {}, 400);
      await pair(62000, { expectedVersion: '1' }, 400);
      await pair(62000, { expectedVersion: 1, extra: true }, 400);
      await pair(62000, { expectedVersion: 1 }, 401, {
        ai: true,
        headers: { Authorization: '' },
      });
      await pair(62000, { expectedVersion: 1 }, 403, {
        headers: { Origin: 'http://invalid.example' },
      });
      await pair(62000, { expectedVersion: 1 }, 400, {
        headers: { call_session_seq: 'ignored' },
      });
      for (const [call, status] of [
        [98003, 409],
        [98004, 404],
        [98005, 409],
        [98006, 404],
        [98007, 403],
        [98008, 409],
        [9999999, 404],
      ])
        await pair(62000, { expectedVersion: 1 }, status, { ai: true, call });
      for (const [id, status] of [
        [62004, 403],
        [62005, 404],
        [62006, 403],
        [62012, 409],
        [62013, 409],
        [62014, 422],
        [62015, 409],
        [62016, 403],
        [62017, 403],
        [9999999, 404],
      ])
        await pair(id, { expectedVersion: 1 }, status);
      await pair(62000, { expectedVersion: 2 }, 409);
      assert.deepEqual(
        await pair(62000, { expectedVersion: 1 }, 200, { ai: true }),
        { status: 'notPaid' },
      );
      assert.deepEqual(
        await pair(62000, { expectedVersion: 1 }, 200, { ai: true }),
        { status: 'notPaid' },
      );
      assert.deepEqual(
        await pair(62007, { expectedVersion: 999 }, 200, {
          ai: true,
          call: 98002,
        }),
        { status: 'notPaid' },
      );
      await pair(62009, { expectedVersion: 999 }, 202);
      assert.deepEqual(await pair(62010), { status: 'SUBMITTING_FAILED' });
      assert.deepEqual(await pair(62011, { expectedVersion: 999 }), {
        status: 'SUBMISSION_FAILED',
      });
      assert.deepEqual(await pair(62001), { status: 'notPaid' });
      await pair(62001, { expectedVersion: 999 });
      assert.deepEqual(await pair(62002), { status: 'ACCEPTED' });
      assert.deepEqual(
        await pair(62003, { expectedVersion: 1 }, 200, { admin: 2 }),
        { status: 'ACCEPTED' },
      );
      assert.deepEqual(
        await pair(62008, { expectedVersion: 999 }, 200, { admin: 3 }),
        { status: 'ACCEPTED' },
      );
      assert.deepEqual(
        await pair(62020, { expectedVersion: 1 }, 200, {
          headers: { call_session_seq: '9999999' },
        }),
        { status: 'notPaid' },
      );
      assert.deepEqual(
        await pair(62021, { expectedVersion: 1 }, 200, {
          headers: { call_session_seq: '98007' },
        }),
        { status: 'notPaid' },
      );
      assert.deepEqual(await pair(62024), { status: 'notPaid' });
      const uuidMaps = [new Map(), new Map()];
      function normalize(value, index, key = '') {
        if (value === null) return null;
        if (value instanceof Date) value = value.toISOString();
        if (key === 'payment_request_id') {
          assert.match(value, /^[0-9a-f-]{36}$/i);
          const map = uuidMaps[index];
          if (!map.has(value)) map.set(value, 'uuid-' + map.size);
          return map.get(value);
        }
        if (
          ['payment_due_at', 'expires_at'].includes(key) &&
          Date.parse(value) > started + 23 * 3600000
        ) {
          assert.ok(
            Date.parse(value) >= started + 86400000 - 1000 &&
              Date.parse(value) <= Date.now() + 86400000 + 1000,
          );
          return '<24-hour deadline>';
        }
        if (
          typeof value === 'string' &&
          [
            'created_at',
            'updated_at',
            'paid_at',
            'occurred_at',
            'status_changed_at',
            'submission_first_attempt_at',
            'submission_last_attempt_at',
            'closed_at',
          ].includes(key) &&
          Date.parse(value) >= started - 1000 &&
          Date.parse(value) <= Date.now() + 1000
        )
          return '<generated ' + key + '>';
        if (Array.isArray(value))
          return value.map((item) => normalize(item, index));
        if (typeof value === 'object')
          return Object.fromEntries(
            Object.entries(value).map(([k, item]) => [
              k,
              normalize(item, index, k),
            ]),
          );
        return value;
      }
      const stored = async (side) => ({
        orders: (
          await side.orders.query(
            'SELECT to_jsonb(o) data FROM orders o WHERE order_seq BETWEEN 62000 AND 62024 ORDER BY order_seq',
          )
        ).rows,
        parcels: (
          await side.orders.query(
            'SELECT to_jsonb(p) data FROM order_parcels p WHERE order_seq BETWEEN 62000 AND 62024 ORDER BY order_seq,parcel_position',
          )
        ).rows,
        calls: (
          await side.calls.query(
            'SELECT call_session_seq,order_seq,customer_seq,order_intake_version FROM call_sessions WHERE call_session_seq BETWEEN 98001 AND 98009 ORDER BY call_session_seq',
          )
        ).rows,
        payments: (
          await side.orders.query(
            'SELECT to_jsonb(p) data FROM order_payment_requests p WHERE order_seq BETWEEN 62000 AND 62024 ORDER BY order_seq',
          )
        ).rows,
        charges: (
          await side.orders.query(
            'SELECT order_seq,organization_seq,customer_seq,billing_month::text,payment_method_type,amount,occurred_at FROM order_billing_charges WHERE order_seq BETWEEN 62000 AND 62024 ORDER BY order_seq',
          )
        ).rows,
        pins: (
          await side.customers.query(
            'SELECT personal_pin_seq,customer_seq,label,address_data,version FROM personal_pins WHERE personal_pin_seq>200000 ORDER BY personal_pin_seq',
          )
        ).rows,
      });
      const before = await stored(owners[0]),
        after = await stored(owners[1]);
      assert.deepEqual(normalize(after, 1), normalize(before, 0));
      assert.equal(
        after.pins.filter((pin) => pin.label === '수령인 1').length,
        1,
      );
      assert.equal(
        after.pins.filter((pin) => pin.label === '수령인 0').length,
        0,
      );
      assert.equal(
        after.pins.filter((pin) => pin.label === '수령인 24').length,
        1,
      );
      assert.equal(after.charges.length, 2);
      const logs = async (db) =>
        (
          await db.query(
            'SELECT actor_type,actor_seq,actor_name,action,result,target_type,target_seq,metadata,request_id FROM audit_logs WHERE request_id=ANY($1::uuid[]) ORDER BY request_id,audit_log_seq',
            [requestIds],
          )
        ).rows;
      const originalAudits = await logs(reference);
      for (let n = 0; n < 100; n++) {
        if ((await logs(databases.operations)).length === originalAudits.length)
          break;
        await pause(25);
      }
      assert.deepEqual(await logs(databases.operations), originalAudits);
      const faultRequestId = randomUUID(),
        faultHeaders = {
          Cookie: 'dva_session=' + tokens[0],
          Origin: 'http://localhost:5173',
          'Content-Type': 'application/json',
          'X-Request-Id': faultRequestId,
        };
      await databases.customer.query(
        "CREATE FUNCTION recipient_fixture_failure() RETURNS trigger LANGUAGE plpgsql AS $fixture$ BEGIN IF NEW.event_type='OrderRecipientPinsWritten' AND (NEW.payload->>'orderSeq')::int=62018 THEN RAISE EXCEPTION 'test-only recipient acknowledgement failure'; END IF; RETURN NEW; END $fixture$",
      );
      await databases.customer.query(
        'CREATE TRIGGER recipient_fixture_failure BEFORE INSERT ON inbox_events FOR EACH ROW EXECUTE FUNCTION recipient_fixture_failure()',
      );
      let event;
      try {
        const response = await fetch(
          owners[1].base + '/api/orders/62018/submit',
          {
            method: 'POST',
            headers: faultHeaders,
            body: JSON.stringify({ expectedVersion: 1 }),
          },
        );
        assert.equal(response.status, 500);
        await response.body.cancel();
        assert.equal(
          (
            await databases.order.query(
              'SELECT status FROM orders WHERE order_seq=62018',
            )
          ).rows[0].status,
          'notPaid',
        );
        assert.equal(
          (
            await databases.customer.query(
              "SELECT 1 FROM personal_pins WHERE customer_seq=98001 AND label='수령인 18'",
            )
          ).rowCount,
          0,
        );
        const row = (
          await databases.order.query(
            "SELECT event_id,payload FROM outbox_events WHERE destination='customer' AND event_type='OrderRecipientPinsWritten' AND aggregate_seq=62018",
          )
        ).rows[0];
        event = {
          eventId: row.event_id,
          source: 'order',
          eventType: 'OrderRecipientPinsWritten',
          payload: row.payload,
        };
      } finally {
        await databases.customer.query(
          'DROP TRIGGER recipient_fixture_failure ON inbox_events',
        );
        await databases.customer.query(
          'DROP FUNCTION recipient_fixture_failure()',
        );
      }
      const forged = await fetch(
        'http://customer-app:3001/internal/call-read-references/parcel-draft-write/events',
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + process.env.CUSTOMER_AUTH_TOKEN,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            ...event,
            payload: { ...event.payload, writeEventId: randomUUID() },
          }),
        },
      );
      assert.equal(forged.status, 409);
      await forged.body.cancel();
      for (let n = 0; n < 2; n++) {
        const response = await fetch(
          'http://customer-app:3001/internal/call-read-references/parcel-draft-write/events',
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer ' + process.env.CUSTOMER_AUTH_TOKEN,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(event),
          },
        );
        assert.equal(response.status, 200);
        assert.ok(
          ['processed', 'duplicate'].includes((await response.json()).status),
        );
      }
      const pins = await databases.customer.query(
        "SELECT personal_pin_seq FROM personal_pins WHERE customer_seq=98001 AND label='수령인 18'",
      );
      assert.equal(pins.rowCount, 1);
      for (let n = 0; n < 100; n++) {
        if (
          (
            await databases.operations.query(
              "SELECT 1 FROM audit_logs WHERE request_id=$1 AND action='PERSONAL_PIN_CREATED'",
              [faultRequestId],
            )
          ).rowCount === 1
        )
          break;
        await pause(25);
      }
      assert.equal(
        (
          await databases.operations.query(
            "SELECT 1 FROM audit_logs WHERE request_id=$1 AND action='PERSONAL_PIN_CREATED' AND target_seq=$2",
            [faultRequestId, pins.rows[0].personal_pin_seq],
          )
        ).rowCount,
        1,
      );
      t.diagnostic(
        'order submit HTTP pairs: ' +
          pairs +
          '; all states, caller permissions, card/month/group, recipient deduplication, stored addresses over 256KiB and real customer rollback recovery',
      );
    },
  );

  await t.test(
    'administrator draft submission preserves standalone conversion, payment policy and replay',
    async () => {
      const started = Date.now(),
        at = new Date().toISOString(),
        owners = [
          {
            ...sides[0],
            orders: reference,
            calls: reference,
            customers: reference,
            audit: reference,
          },
          {
            ...sides[1],
            orders: databases.order,
            calls: databases.consultation,
            customers: databases.customer,
            audit: databases.operations,
          },
        ];
      for (const side of owners) {
        for (const [table, column, value] of [
          ['orders', 'order_seq', 70000],
          ['order_parcel_drafts', 'draft_seq', 60000],
          ['order_parcels', 'order_parcel_seq', 90000],
        ])
          await side.orders.query(
            'SELECT setval(pg_get_serial_sequence($1,$2),$3,true)',
            [table, column, value],
          );
        await side.customers.query(
          "SELECT setval(pg_get_serial_sequence('personal_pins','personal_pin_seq'),300000,true)",
        );
        await side.calls.query(
          "INSERT INTO call_sessions(call_session_seq,provider_call_id,caller_phone_number,customer_seq,incoming_at,registered_at,order_intake_enabled) OVERRIDING SYSTEM VALUE VALUES(99001,'admin-submit-call','01080808080',98001,$1,$1,true)",
          [at],
        );
      }
      const maps = [new Map(), new Map()],
        requests = [];
      let pairs = 0;
      function normalize(value, index, key = '') {
        if (value === null) return null;
        if (value instanceof Date) value = value.toISOString();
        if (
          [
            'paymentRequestId',
            'payment_request_id',
            'creation_request_id',
          ].includes(key)
        ) {
          assert.match(value, /^[0-9a-f-]{36}$/i);
          const map = maps[index];
          if (!map.has(value)) map.set(value, 'uuid-' + map.size);
          return map.get(value);
        }
        if (
          [
            'expiresAt',
            'paymentDueAt',
            'expires_at',
            'payment_due_at',
          ].includes(key)
        ) {
          assert.ok(
            Date.parse(value) >= started + 86400000 - 1000 &&
              Date.parse(value) <= Date.now() + 86400000 + 1000,
          );
          return '<24-hour deadline>';
        }
        if (
          [
            'createdAt',
            'updatedAt',
            'retentionStartedAt',
            'created_at',
            'updated_at',
            'retention_started_at',
            'paid_at',
            'closed_at',
            'submission_first_attempt_at',
            'submission_last_attempt_at',
            'deleted_at',
            'occurred_at',
          ].includes(key)
        ) {
          assert.ok(
            Date.parse(value) >= started - 1000 &&
              Date.parse(value) <= Date.now() + 1000,
            key + ' ' + value,
          );
          return '<generated ' + key + '>';
        }
        if (Array.isArray(value))
          return value.map((item) => normalize(item, index));
        if (typeof value === 'object')
          return Object.fromEntries(
            Object.entries(value).map(([name, item]) => [
              name,
              normalize(item, index, name),
            ]),
          );
        return value;
      }
      const { envelope, schema } = require('./final-parity.cjs');
      const specs = [];
      for (const side of owners)
        specs.push(
          await (
            await fetch(
              side.base +
                (side.name === 'monolith' ? '/api' : '/order') +
                '/docs-json',
            )
          ).json(),
        );
      const submitPath = '/api/admin/parcel-drafts/{id}/submit';
      assert.deepEqual(
        schema(specs[1].paths[submitPath].post, specs[1]),
        schema(specs[0].paths[submitPath].post, specs[0]),
      );
      async function pair(method, path, input, status = 200, options = {}) {
        const requestId = randomUUID(),
          bodies = [];
        requests.push(requestId);
        for (const [index, side] of owners.entries()) {
          const response = await fetch(side.base + path, {
            method,
            signal: AbortSignal.timeout(30000),
            headers: {
              'Content-Type': 'application/json',
              'X-Request-Id': requestId,
              ...(options.ai
                ? {
                    Authorization: 'Bearer ' + process.env.CUSTOMER_AUTH_TOKEN,
                    call_session_seq: '99001',
                  }
                : {
                    Cookie: 'dva_session=' + tokens[(options.admin ?? 1) - 1],
                    Origin: 'http://localhost:5173',
                  }),
              ...options.headers,
            },
            ...(input === undefined ? {} : { body: JSON.stringify(input) }),
          });
          const body = status === 204 ? null : await response.json();
          assert.equal(
            response.status,
            status,
            side.name + ' ' + method + ' ' + path + ' ' + JSON.stringify(body),
          );
          assert.equal(response.headers.get('cache-control'), 'no-store');
          bodies.push(normalize(envelope(body, requestId), index));
        }
        assert.deepEqual(bodies[1], bodies[0], method + ' ' + path);
        pairs++;
        return bodies[0]?.data;
      }
      const address = (name) => ({
        name,
        phoneNumber: '01080808080',
        roadAddress: '관리자 접수 도로',
        jibunAddress: '관리자 접수 지번',
        detailAddress: '101호',
        dongName: '동',
        postalCode: '12345',
      });
      const create = (
        label,
        customerSeq = 98001,
        status = 'READY',
        options = {},
      ) =>
        pair(
          'POST',
          '/api/parcel-drafts',
          {
            clientParcelId: randomUUID(),
            customerSeq,
            status,
            parcel: {
              origin: address('발송인'),
              destination: address(label),
              documentCount: 1,
              itemPrice: 1000,
              notifiedPrice: 5000,
            },
          },
          201,
          options,
        );
      const submit = (
        id,
        input = { expectedVersion: 1, paymentMethodType: 'billing' },
        status = 200,
        options = {},
      ) =>
        pair(
          'POST',
          '/api/admin/parcel-drafts/' + id + '/submit',
          input,
          status,
          options,
        );
      await submit(9999999, {}, 400);
      await submit(9999999, { expectedVersion: 1 }, 404);
      await submit(0, { expectedVersion: 1 }, 400);
      await submit(9999999, { expectedVersion: 1 }, 401, {
        ai: true,
        headers: { Origin: 'http://localhost:5173' },
      });
      await submit(9999999, { expectedVersion: 1 }, 403, {
        headers: { Origin: 'http://invalid.example' },
      });
      const editing = await create('미완료 관리자', 98001, 'EDITING');
      await submit(editing.draftSeq, undefined, 409);
      const linked = await create('통화 배송', 98001, 'READY', { ai: true });
      await submit(linked.draftSeq, undefined, 409);
      const ordinary = await create('카드 수령인');
      await submit(
        ordinary.draftSeq,
        { expectedVersion: 1, unknown: true },
        400,
      );
      await submit(
        ordinary.draftSeq,
        { expectedVersion: 2, paymentMethodType: 'billing' },
        409,
      );
      await submit(ordinary.draftSeq, { expectedVersion: 1 }, 422);
      await submit(
        ordinary.draftSeq,
        { expectedVersion: 1, paymentMethodType: 'cash' },
        400,
      );
      await submit(
        ordinary.draftSeq,
        {
          expectedVersion: 1,
          paymentMethodType: 'billing',
          pickupRequestedAt: '2026-02-30T00:00:00Z',
        },
        400,
      );
      const billed = await submit(ordinary.draftSeq);
      assert.equal(billed.status, 'notPaid');
      assert.equal(billed.orderSeq, ordinary.reservedOrderSeq);
      assert.equal(billed.callSessionSeq, null);
      assert.deepEqual(
        await submit(ordinary.draftSeq, {
          expectedVersion: 999,
          paymentMethodType: 'credit',
        }),
        billed,
      );
      const credit = await create('월결제 수령인');
      const paid = await submit(
        credit.draftSeq,
        {
          expectedVersion: 1,
          paymentMethodType: 'credit',
          pickupRequestedAt: '2035-02-01T00:00:00Z',
        },
        200,
        { admin: 2 },
      );
      assert.equal(paid.status, 'ACCEPTED');
      assert.deepEqual(
        await submit(credit.draftSeq, { expectedVersion: 999 }, 200, {
          admin: 3,
        }),
        paid,
      );
      const group = await create('그룹 수령인', 98004);
      assert.equal(
        (
          await submit(group.draftSeq, {
            expectedVersion: 1,
            paymentMethodType: 'groupBilling',
            pickupRequestedAt: '2035-02-01T00:00:00Z',
          })
        ).status,
        'ACCEPTED',
      );
      const ineligible = await create('일반 수령인', 98005);
      await submit(
        ineligible.draftSeq,
        { expectedVersion: 1, paymentMethodType: 'credit' },
        403,
      );
      const withdrawn = await create('접수 전 탈퇴');
      for (const side of owners)
        await side.customers.query(
          "UPDATE customers SET status='WITHDRAWN' WHERE customer_seq=98001",
        );
      try {
        await submit(withdrawn.draftSeq, undefined, 404);
      } finally {
        for (const side of owners)
          await side.customers.query(
            "UPDATE customers SET status='ACTIVE' WHERE customer_seq=98001",
          );
      }
      const deleted = await create('삭제 초안');
      await pair(
        'DELETE',
        '/api/parcel-drafts/' + deleted.draftSeq,
        undefined,
        204,
      );
      await submit(deleted.draftSeq, undefined, 404);
      for (const side of owners) {
        const client = await side.orders.connect();
        try {
          await client.query('BEGIN');
          await client.query("SET LOCAL session_replication_role='replica'");
          await client.query(
            'UPDATE orders SET deleted_at=$2 WHERE order_seq=$1',
            [billed.orderSeq, at],
          );
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      }
      await submit(ordinary.draftSeq, undefined, 409);
      const stored = async (side) => ({
        drafts: (
          await side.orders.query(
            'SELECT to_jsonb(d) data FROM order_parcel_drafts d WHERE draft_seq>60000 AND draft_seq<60100 ORDER BY draft_seq',
          )
        ).rows,
        orders: (
          await side.orders.query(
            'SELECT to_jsonb(o) data FROM orders o WHERE order_seq>70000 AND order_seq<70100 ORDER BY order_seq',
          )
        ).rows,
        parcels: (
          await side.orders.query(
            'SELECT to_jsonb(p) data FROM order_parcels p WHERE order_seq>70000 AND order_seq<70100 ORDER BY order_seq,parcel_position',
          )
        ).rows,
        payments: (
          await side.orders.query(
            'SELECT to_jsonb(p) data FROM order_payment_requests p WHERE order_seq>70000 AND order_seq<70100 ORDER BY order_seq',
          )
        ).rows,
        charges: (
          await side.orders.query(
            'SELECT order_seq,organization_seq,customer_seq,billing_month::text,payment_method_type,amount,occurred_at FROM order_billing_charges WHERE order_seq>70000 AND order_seq<70100 ORDER BY order_seq',
          )
        ).rows,
        pins: (
          await side.customers.query(
            'SELECT personal_pin_seq,customer_seq,label,address_data,version FROM personal_pins WHERE personal_pin_seq>300000 ORDER BY personal_pin_seq',
          )
        ).rows,
        calls: (
          await side.calls.query(
            'SELECT call_session_seq,order_seq,customer_seq,order_intake_version FROM call_sessions WHERE call_session_seq=99001',
          )
        ).rows,
      });
      const original = await stored(owners[0]),
        candidate = await stored(owners[1]);
      assert.deepEqual(normalize(candidate, 1), normalize(original, 0));
      assert.equal(candidate.orders.length, 3);
      assert.equal(candidate.pins.length, 3);
      assert.equal(candidate.charges.length, 2);
      const logs = async (db) =>
        (
          await db.query(
            'SELECT request_id,action,result,target_type,target_seq,actor_type,actor_seq,metadata FROM audit_logs WHERE request_id=ANY($1::uuid[]) ORDER BY request_id,audit_log_seq',
            [requests],
          )
        ).rows;
      const sourceLogs = await logs(reference);
      for (let n = 0; n < 100; n++) {
        if ((await logs(databases.operations)).length === sourceLogs.length)
          break;
        await pause(25);
      }
      assert.deepEqual(await logs(databases.operations), sourceLogs);
      t.diagnostic(
        'administrator draft HTTP pairs: ' +
          pairs +
          '; standalone/call scope, expected version, all three payment methods, current-order replay, deleted orders and exact pins/audits',
      );
    },
  );

  await t.test(
    'order customer preparation preserves identities across owner rollback, pending work and concurrent public writes',
    async (case48) => {
      const {
        DatabaseService: CustomerDatabase,
      } = require('./customer-runtime/database/database.service');
      const {
        AuditService: CustomerAudit,
      } = require('./customer-runtime/audit/audit.service');
      const {
        OrderRecipientPinsService,
      } = require('./customer-runtime/customers/order-recipient-pins.service');
      const {
        OrderCustomerWritesService,
      } = require('./customer-runtime/customers/order-customer-writes.service');
      const {
        CustomersRepository: OriginalCustomers,
      } = require('./monolith-runtime/customers/customers.repository');
      const {
        AuditService: OriginalAudit,
      } = require('./monolith-runtime/audit/audit.service');
      const {
        AuditRepository: OriginalAuditRepository,
      } = require('./monolith-runtime/audit/audit.repository');
      const {
        ORDER_CREATION_LOCK,
        customerPreparationId,
      } = require('@dva/events/order-customer-write.cjs');
      const config = {
        get: (key) =>
          ({
            NODE_ENV: 'test',
            DB_HOST: 'customer-db',
            DB_PORT: 5432,
            DB_USER: 'customer_app',
            DB_PASSWORD: process.env.PGPASSWORD,
            DB_NAME: process.env.PGDATABASE,
            ORDER_URL: 'http://order-app:3002',
            OPERATIONS_URL: 'http://operations-app:3005',
            CUSTOMER_AUTH_TOKEN: process.env.CUSTOMER_AUTH_TOKEN,
          })[key],
      };
      const database = new CustomerDatabase(config),
        audit = new CustomerAudit(database, config),
        pins = new OrderRecipientPinsService(audit),
        preparations = new OrderCustomerWritesService(
          database,
          config,
          audit,
          pins,
        );
      const originalRepository = new OriginalCustomers({ pool: reference }),
        originalAudit = new OriginalAudit(
          new OriginalAuditRepository({ pool: reference }),
        );
      const leases=new Set();
      async function lease(pool){const client=await pool.connect();leases.add(client);return client;}
      function release(client){assert.ok(leases.delete(client),'fixture lease must be tracked');client.release();}
      case48.after(async () => {
        for(const client of leases){try{await client.query('ROLLBACK');}finally{client.release();}}
        leases.clear();
        await preparations.onModuleDestroy();
        await audit.onModuleDestroy();
        await database.onModuleDestroy();
      });
      for (const db of [reference, databases.customer])
        await db.query(
          "SELECT setval(pg_get_serial_sequence('customers','customer_seq'),400000,true)",
        );
      const requestIds = [],
        headers = {
          'Content-Type': 'application/json',
          Cookie: 'dva_session=' + tokens[0],
          Origin: 'http://localhost:5173',
        };
      const address = {
        roadAddress: '고객 도로',
        jibunAddress: '고객 지번',
        detailAddress: '101호',
        dongName: '동',
        postalCode: '12345',
      };
      async function originalInsert(input, requestId, commit = true) {
        const client = await reference.connect();
        try {
          await client.query('BEGIN');
          const row = await originalRepository.insertForOrder(client, input);
          assert.ok(row);
          await originalAudit.recordSuccess(
            {
              actorId: 1,
              actorType: 'ADMIN',
              action: 'CUSTOMER_CREATED',
              targetType: 'CUSTOMER',
              targetId: row.customerSeq,
              requestId,
            },
            client,
          );
          await client.query(commit ? 'COMMIT' : 'ROLLBACK');
          return row;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      }
      async function rolledBackPreparation(input, requestId, writeEventId) {
        let result;
        const lost = new Error('test-only lost customer owner acknowledgement');
        await assert.rejects(
          database.transaction(async (client) => {
            result = await preparations.prepare(
              client,
              { customer: input },
              1,
              requestId,
              writeEventId,
            );
            throw lost;
          }),
          (error) => error === lost,
        );
        assert.ok(result.created);
        return result.created;
      }
      async function ownerStart() {
        const client = await lease(databases.order),
          writeEventId = randomUUID();
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1,hashtext($2))', [
          ORDER_CREATION_LOCK,
          writeEventId,
        ]);
        return { client, writeEventId };
      }
      const receipt = (customer, writeEventId, requestId) => ({
        eventId: randomUUID(),
        payload: { writeEventId, customer, adminId: 1, requestId },
      });
      async function commitOwner(owner, customerCreationReceipt) {
        await owner.client.query(
          "INSERT INTO inbox_events(event_id,source,event_type,payload) VALUES($1,'customer','ParcelDraftWriteRequested',$2)",
          [
            owner.writeEventId,
            { result: { customerCreationReceipt, customerReceipt: null } },
          ],
        );
        await owner.client.query('COMMIT');
        release(owner.client);
      }
      async function duplicate(input, requestId, status) {
        requestIds.push(requestId);
        const responses = [];
        for (const base of [
          'http://monolith-app:3000',
          'http://customer-app:3001',
        ]) {
          const response = await fetch(base + '/api/customers', {
              method: 'POST',
              headers: { ...headers, 'X-Request-Id': requestId },
              body: JSON.stringify({ ...input, address }),
            }),
            body = await response.json();
          assert.equal(
            response.status,
            status,
            base + ' ' + JSON.stringify(body),
          );
          responses.push(
            require('./final-parity.cjs').envelope(body, requestId),
          );
        }
        assert.deepEqual(responses[1], responses[0]);
        return responses[0].data;
      }
      const first = { name: '확정 준비 고객', phoneNumber: '01090909001' },
        firstRequest = randomUUID();
      requestIds.push(firstRequest);
      const firstSource = await originalInsert(first, firstRequest),
        firstOwner = await ownerStart(),
        firstCreated = await rolledBackPreparation(
          first,
          firstRequest,
          firstOwner.writeEventId,
        );
      assert.equal(firstCreated.customerSeq, firstSource.customerSeq);
      assert.equal(
        (
          await databases.customer.query(
            'SELECT 1 FROM customers WHERE customer_seq=$1',
            [firstCreated.customerSeq],
          )
        ).rowCount,
        0,
      );
      const firstReceipt = receipt(
        firstCreated,
        firstOwner.writeEventId,
        firstRequest,
      );
      await commitOwner(firstOwner, firstReceipt);
      const event = {
        eventId: firstReceipt.eventId,
        source: 'order',
        eventType: 'OrderCustomerCreated',
        payload: {
          writeEventId: firstOwner.writeEventId,
          customerSeq: firstCreated.customerSeq,
        },
      };
      const eventUrl =
        'http://customer-app:3001/internal/call-read-references/parcel-draft-write/events';
      const forged = await fetch(eventUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + process.env.CUSTOMER_AUTH_TOKEN,
        },
        body: JSON.stringify({
          ...event,
          payload: {
            ...event.payload,
            customerSeq: firstCreated.customerSeq + 1,
          },
        }),
      });
      assert.equal(forged.status, 409);
      await forged.body.cancel();
      for (let n = 0; n < 2; n++) {
        const response = await fetch(eventUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + process.env.CUSTOMER_AUTH_TOKEN,
          },
          body: JSON.stringify(event),
        });
        assert.equal(response.status, 200);
        assert.ok(
          ['processed', 'duplicate'].includes((await response.json()).status),
        );
      }
      await duplicate(first, randomUUID(), 409);
      assert.equal(
        (
          await databases.customer.query(
            "SELECT 1 FROM outbox_events WHERE event_id=$1 AND event_type='OrderCustomerPreparationRequested'",
            [customerPreparationId(first.phoneNumber)],
          )
        ).rowCount,
        0,
      );
      const aborted = { name: '취소 준비 고객', phoneNumber: '01090909002' },
        abortedRequest = randomUUID();
      requestIds.push(abortedRequest);
      const abortedSource = await originalInsert(
          aborted,
          abortedRequest,
          false,
        ),
        abortedOwner = await ownerStart(),
        abortedCreated = await rolledBackPreparation(
          aborted,
          abortedRequest,
          abortedOwner.writeEventId,
        );
      assert.equal(abortedCreated.customerSeq, abortedSource.customerSeq);
      await abortedOwner.client.query('ROLLBACK');
      release(abortedOwner.client);
      const running = preparations.run();
      assert.equal(preparations.run(), running);
      await running;
      const replacement = await duplicate(aborted, randomUUID(), 201);
      assert.ok(replacement.customerSeq > abortedCreated.customerSeq);
      const pending = { name: '대기 준비 고객', phoneNumber: '01090909003' },
        pendingRequest = randomUUID();
      requestIds.push(pendingRequest);
      const sourceClient = await lease(reference);
      await sourceClient.query('BEGIN');
      const sourcePending = await originalRepository.insertForOrder(
        sourceClient,
        pending,
      );
      await originalAudit.recordSuccess(
        {
          actorId: 1,
          actorType: 'ADMIN',
          action: 'CUSTOMER_CREATED',
          targetType: 'CUSTOMER',
          targetId: sourcePending.customerSeq,
          requestId: pendingRequest,
        },
        sourceClient,
      );
      const pendingOwner = await ownerStart(),
        pendingCreated = await rolledBackPreparation(
          pending,
          pendingRequest,
          pendingOwner.writeEventId,
        );
      assert.equal(pendingCreated.customerSeq, sourcePending.customerSeq);
      const concurrentRequest = randomUUID();
      requestIds.push(concurrentRequest);
      const responses = [
        'http://monolith-app:3000',
        'http://customer-app:3001',
      ].map((base) =>
        fetch(base + '/api/customers', {
          method: 'POST',
          headers: { ...headers, 'X-Request-Id': concurrentRequest },
          body: JSON.stringify({ ...pending, address }),
        }),
      );
      let settled = false;
      void Promise.all(responses).then(() => {
        settled = true;
      });
      await pause(150);
      assert.equal(
        settled,
        false,
        'a pending owner must not lose its phone identity',
      );
      await sourceClient.query('COMMIT');
      release(sourceClient);
      const pendingReceipt = receipt(
        pendingCreated,
        pendingOwner.writeEventId,
        pendingRequest,
      );
      await commitOwner(pendingOwner, pendingReceipt);
      const bodies = [];
      for (const responsePromise of responses) {
        const response = await responsePromise;
        assert.equal(response.status, 409);
        bodies.push(
          require('./final-parity.cjs').envelope(
            await response.json(),
            concurrentRequest,
          ),
        );
      }
      assert.deepEqual(bodies[1], bodies[0]);
      await preparations.run();
      for (let n = 0; n < 80; n++) {
        if (
          (
            await databases.customer.query(
              'SELECT 1 FROM customers WHERE customer_seq=$1',
              [pendingCreated.customerSeq],
            )
          ).rowCount
        )
          break;
        await pause(25);
      }
      const snapshot = async (db) =>
        (
          await db.query(
            'SELECT to_jsonb(c) data FROM customers c WHERE customer_seq>400000 ORDER BY customer_seq',
          )
        ).rows;
      assert.deepEqual(
        await snapshot(databases.customer),
        await snapshot(reference),
      );
      assert.equal((await snapshot(reference)).length, 3);
      const logs = async (db) =>
        (
          await db.query(
            'SELECT request_id,action,result,target_type,target_seq,actor_type,actor_seq,metadata FROM audit_logs WHERE request_id=ANY($1::uuid[]) ORDER BY request_id,audit_log_seq',
            [requestIds],
          )
        ).rows;
      const sourceLogs = await logs(reference);
      for (let n = 0; n < 100; n++) {
        if ((await logs(databases.operations)).length === sourceLogs.length)
          break;
        await pause(25);
      }
      assert.deepEqual(await logs(databases.operations), sourceLogs);
      const tableLock = await lease(databases.order),
        blocked = [];
      try {
        await tableLock.query('BEGIN');
        await tableLock.query(
          'LOCK TABLE orders IN ACCESS EXCLUSIVE MODE',
        );
        for (let n = 0; n < 5; n++)
          blocked.push(
            fetch(
              'http://order-app:3002/api/orders/2140000000',
              { headers },
            ),
          );
        for (let n = 0; n < 60; n++) {
          const count = (
            await databases.order.query(
              "SELECT count(*)::int n FROM pg_stat_activity a WHERE datname=current_database() AND usename='order_app' AND wait_event_type='Lock' AND EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND l.relation='orders'::regclass AND l.mode='AccessShareLock' AND NOT l.granted)",
            )
          ).rows[0].n;
          if (count === 5) break;
          assert.ok(n < 59, 'five main-pool operations must block; observed '+count);
          await pause(20);
        }
        const start = Date.now(),
          response = await fetch(
            'http://order-app:3002/internal/parcel-draft-write/reference',
            {
              method: 'POST',
              signal: AbortSignal.timeout(1800),
              headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer ' + process.env.CUSTOMER_AUTH_TOKEN,
              },
              body: JSON.stringify({
                eventId: randomUUID(),
                source: 'customer',
                eventType: 'ParcelDraftWriteReferenceRequested',
                payload: {
                  operation: 'CustomerPreparationOutcomeRead',
                  input: { writeEventId: randomUUID() },
                },
              }),
            },
          );
        assert.equal(response.status, 200);
        assert.deepEqual((await response.json()).payload, {
          status: 'ABORTED',
        });
        assert.ok(Date.now() - start < 1800);
        for (const [source, operation, input, status, expected] of [
          ['consultation', 'PendingCallWritesRead', { id: 2140000000 }, 200, []],
          ['consultation', 'IntakeFinalizationRead', { id: 2140000000 }, 200, null],
          ['customer', 'RecipientReceiptRead', { eventId: randomUUID() }, 404, undefined],
        ]) {
          const response = await fetch(
            'http://order-app:3002/internal/parcel-draft-write/reference',
            {
              method: 'POST',
              signal: AbortSignal.timeout(1800),
              headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer ' + process.env.CUSTOMER_AUTH_TOKEN,
              },
              body: JSON.stringify({
                eventId: randomUUID(), source,
                eventType: 'ParcelDraftWriteReferenceRequested',
                payload: { operation, input },
              }),
            },
          );
          assert.equal(response.status, status, operation);
          const body = await response.json();
          if (status === 200) assert.deepEqual(body.payload, expected);
          else assert.equal(body.error.code, 'NOT_FOUND');
        }
      } finally {
        await tableLock.query('ROLLBACK');
        release(tableLock);
        for (const response of await Promise.all(blocked)) {
          assert.equal(response.status, 404);
          await response.body.cancel();
        }
      }
      t.diagnostic(
        'customer preparation preserves source rows and audits through committed/aborted/pending owner outcomes, duplicate events, competing public creation and five saturated order connections',
      );
    },
  );

  await t.test(
    'order creation preserves original request keys, customers and legacy outcomes',
    async (creation) => {
      const started = Date.now(),
        at = new Date(started).toISOString();
      const owners = [
        {
          ...sides[0],
          orders: reference,
          calls: reference,
          customers: reference,
          audit: reference,
        },
        {
          ...sides[1],
          orders: databases.order,
          calls: databases.consultation,
          customers: databases.customer,
          audit: databases.operations,
        },
      ];
      const origin = {
        name: '발송인',
        phoneNumber: '01011112222',
        roadAddress: '출발 도로',
        jibunAddress: '출발 지번',
        detailAddress: '',
        dongName: '출발동',
        postalCode: '00123',
      };
      const destination = {
        ...origin,
        name: '주문 생성 수령인',
        phoneNumber: '01033334444',
        roadAddress: '수령 도로',
      };
      const parcel = {
        origin,
        destination,
        documentCount: 1,
        itemPrice: 1000,
        notifiedPrice: 5000,
      };
      const complete = {
        customerSeq: 110001,
        paymentMethodType: 'billing',
        totalAmount: 5000,
        pickupRequestedAt: new Date(started + 3 * 86400000).toISOString(),
        parcels: [parcel],
      };
      const identities = new Map();
      for (let n = 1; n <= 36; n++)
        identities.set(110000 + n, {
          providerCallId: 'creation-call-' + n,
          callerPhoneNumber:
            n === 11
              ? '01092929292'
              : n === 14
                ? '01056565656'
                : n === 15
                  ? '01057575757'
                  : n === 22
                    ? '01061616161'
                    : '01051515151',
          incomingAt:
            n === 4
              ? '2000-01-01T00:00:00Z'
              : new Date(started + n * 1000).toISOString(),
        });
      for (const side of owners) {
        for (let n = 1; n <= 4; n++)
          await side.customers.query(
            'INSERT INTO customers(customer_seq,name,phone_number,status,monthly_billing_enabled,deleted_at) OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4,$5,$6)',
            [
              110000 + n,
              '주문 고객 ' + n,
              '0105151515' + n,
              n === 2 ? 'WITHDRAWN' : 'ACTIVE',
              n === 4,
              n === 3 ? at : null,
            ],
          );
        await side.customers.query(
          'INSERT INTO personal_pins(personal_pin_seq,customer_seq,label,address_data) OVERRIDING SYSTEM VALUE VALUES(110501,110001,$1,$2)',
          ['원본 출발지', origin],
        );
        await side.customers.query(
          "SELECT setval('customers_customer_seq_seq',500000,true)",
        );
        await side.customers.query(
          "SELECT setval('personal_pins_personal_pin_seq_seq',501000,true)",
        );
        await side.orders.query(
          "SELECT setval('orders_order_seq_seq',80000,true)",
        );
        await side.orders.query(
          "SELECT setval('order_parcels_order_parcel_seq_seq',100000,true)",
        );
        for (const [id, call] of identities)
          await side.calls.query(
            'INSERT INTO call_sessions(call_session_seq,provider_call_id,caller_phone_number,incoming_at,registered_at,order_intake_enabled,ended_at,started_at,customer_seq) OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8)',
            [
              id,
              call.providerCallId,
              id === 110005 ? null : call.callerPhoneNumber,
              id === 110003 ? null : call.incomingAt,
              at,
              id === 110002,
              id === 110006 ? at : null,
              id === 110013 ? 7 : null,
            ],
          );
        await side.calls.query(
          "SELECT setval('call_sessions_call_session_seq_seq',110100,true)",
        );
      }
      const guards = [];
      creation.after(async () => {
        for (const client of guards) {
          await client.query('ROLLBACK');
          client.release();
        }
      });
      for (const side of owners) {
        const client = await side.calls.connect();
        await client.query('BEGIN');
        await client.query(
          'SELECT 1 FROM call_sessions WHERE call_session_seq=110004 FOR KEY SHARE',
        );
        guards.push(client);
      }
      const { schema, envelope } = require('./final-parity.cjs');
      const specs = [];
      for (const side of owners)
        specs.push(
          await (
            await fetch(
              side.base +
                (side.name === 'monolith' ? '/api' : '/order') +
                '/docs-json',
            )
          ).json(),
        );
      assert.deepEqual(
        schema(specs[1].paths['/api/orders'].post, specs[1]),
        schema(specs[0].paths['/api/orders'].post, specs[0]),
      );
      const uuidMaps = [new Map(), new Map()],
        requests = [];
      let pairs = 0;
      function normalize(value, index, key = '') {
        if (value === null) return null;
        if (value instanceof Date) value = value.toISOString();
        if (['paymentRequestId', 'payment_request_id'].includes(key)) {
          assert.match(value, /^[0-9a-f-]{36}$/i);
          const map = uuidMaps[index];
          if (!map.has(value)) map.set(value, 'payment-' + map.size);
          return map.get(value);
        }
        if (
          [
            'paymentDueAt',
            'payment_due_at',
            'expiresAt',
            'expires_at',
          ].includes(key)
        ) {
          assert.ok(
            Date.parse(value) >= started + 86400000 - 1000 &&
              Date.parse(value) <= Date.now() + 86400000 + 1000,
          );
          return '<24-hour deadline>';
        }
        if (
          [
            'created_at',
            'updated_at',
            'occurred_at',
            'paid_at',
            'closed_at',
            'submission_first_attempt_at',
            'submission_last_attempt_at',
            'status_changed_at',
          ].includes(key) &&
          typeof value === 'string' &&
          Date.parse(value) >= started - 1000 &&
          Date.parse(value) <= Date.now() + 1000
        )
          return '<generated ' + key + '>';
        if (Array.isArray(value))
          return value.map((item) => normalize(item, index));
        if (typeof value === 'object')
          return Object.fromEntries(
            Object.entries(value).map(([name, item]) => [
              name,
              normalize(item, index, name),
            ]),
          );
        return value;
      }
      async function send(side, input, status, key, requestId, options = {}) {
        const response = await fetch(side.base + '/api/orders', {
          method: 'POST',
          signal: AbortSignal.timeout(30000),
          headers: {
            'Content-Type': 'application/json',
            'X-Request-Id': requestId,
            'Idempotency-Key': key,
            ...(options.ai
              ? { Authorization: 'Bearer ' + process.env.CUSTOMER_AUTH_TOKEN }
              : {
                  Cookie: 'dva_session=' + tokens[(options.admin ?? 1) - 1],
                  Origin: 'http://localhost:5173',
                }),
            ...options.headers,
          },
          body: JSON.stringify(input),
        });
        const body = await response.json();
        assert.equal(
          response.status,
          status,
          side.name + ' POST orders ' + JSON.stringify(body),
        );
        assert.equal(response.headers.get('cache-control'), 'no-store');
        return envelope(body, requestId);
      }
      async function pair(input, status = 201, options = {}) {
        const key = options.key ?? randomUUID(),
          requestId = randomUUID(),
          bodies = [];
        requests.push(requestId);
        for (const [index, side] of owners.entries())
          bodies.push(
            normalize(
              await send(side, input, status, key, requestId, options),
              index,
            ),
          );
        assert.deepEqual(bodies[1], bodies[0], 'POST orders ' + pairs);
        pairs++;
        return { key, data: bodies[0].data };
      }
      const legacy = (n) => identities.get(110000 + n);
      await pair({ customerSeq: 110001 }, 401, {
        ai: true,
        headers: { Authorization: '', Origin: 'http://localhost:5173' },
      });
      await pair({ customerSeq: 110001 }, 403, { headers: { Origin: '' } });
      await pair({ customerSeq: 110001 }, 400, { key: 'bad-key' });
      for (const input of [
        {},
        {
          customerSeq: 110001,
          customer: { name: '중복', phoneNumber: '01051515151' },
        },
        { customer: { name: ' ', phoneNumber: '01051515151' } },
        {
          customer: {
            name: '추가',
            phoneNumber: '01051515151',
            monthlyBillingEnabled: true,
          },
        },
        { customerSeq: '110001' },
        { customerSeq: 110001, call: legacy(1) },
        { customerSeq: 110001, outcome: 'INCOMPLETE' },
        { customerSeq: 110001, parcels: null },
      ])
        await pair(input, 400);
      await pair({ customerSeq: 110001 }, 400, { ai: true });
      await pair({ customerSeq: 110002 }, 403);
      await pair({ customerSeq: 110003 }, 404);
      await pair({ customerSeq: 2147483647 }, 404);
      const initial = await pair({
        customerSeq: 110001,
        parcels: [{ clientComment: '부분 저장' }],
      });
      assert.ok(initial.data.orderSeq > 80000);
      assert.deepEqual(
        (await pair({ customerSeq: 110002 }, 201, { key: initial.key })).data,
        initial.data,
      );
      await pair({ customerSeq: 110001 }, 403, { key: initial.key, admin: 2 });
      await pair({ customerSeq: 110001 }, 201, {
        key: '00000000-0000-0000-0000-000000000000',
      });
      await pair({
        customer: { phoneNumber: '01052525252', name: '  신규 고객  ' },
        parcels: [{}],
      });
      await pair({
        customer: { name: '다른 이름', phoneNumber: '01051515151' },
      });
      await pair(
        {
          customerSeq: 110001,
          parcels: [{ originPin: { scope: 'COMPANY', pinSeq: 1 } }],
        },
        400,
      );
      await pair(
        {
          customerSeq: 110001,
          parcels: [{ originPin: { scope: 'PERSONAL', pinSeq: 2147483647 } }],
        },
        403,
      );
      await pair({
        customerSeq: 110001,
        parcels: [{ originPin: { scope: 'PERSONAL', pinSeq: 110501 } }],
      });
      await pair({ customerSeq: 110001 }, 400, {
        headers: { call_session_seq: 'bad' },
      });
      await pair({ customerSeq: 110001 }, 404, {
        headers: { call_session_seq: '2147483647' },
      });
      await pair({ customerSeq: 110001 }, 409, {
        ai: true,
        headers: { call_session_seq: '110002' },
      });
      await pair({ customerSeq: 110001 }, 404, {
        headers: { call_session_seq: '110004' },
      });
      await pair({ customerSeq: 110001 }, 409, {
        headers: { call_session_seq: '110006' },
      });
      await pair({ customerSeq: 110001 }, 403, {
        headers: { call_session_seq: '110011' },
      });
      const headerOrder = await pair({ customerSeq: 110001 }, 201, {
        ai: true,
        headers: { call_session_seq: '110001' },
      });
      assert.deepEqual(
        (
          await pair({ customerSeq: 110001 }, 201, {
            key: headerOrder.key,
            ai: true,
            headers: { call_session_seq: '110001' },
          })
        ).data,
        headerOrder.data,
      );
      await pair({ customerSeq: 110001 }, 409, {
        ai: true,
        headers: { call_session_seq: '110001' },
      });
      await pair({ customerSeq: 110001 }, 201, {
        ai: true,
        headers: { call_session_seq: '110003' },
      });
      await pair({ customerSeq: 110001 }, 201, {
        ai: true,
        headers: { call_session_seq: '110005' },
      });
      await pair(
        { call: legacy(7), outcome: 'INCOMPLETE', customerSeq: 110001 },
        409,
        { ai: true, headers: { call_session_seq: '110008' } },
      );
      const empty = await pair(
        { call: legacy(7), outcome: 'INCOMPLETE' },
        201,
        { ai: true },
      );
      assert.equal(empty.data.status, 'NO_ORDER');
      assert.deepEqual(
        (
          await pair({ call: legacy(7), outcome: 'CANCELLED' }, 201, {
            ai: true,
            key: empty.key,
          })
        ).data,
        empty.data,
      );
      await pair({ call: legacy(7), outcome: 'INCOMPLETE' }, 409, { ai: true });
      await pair({ call: legacy(7), outcome: 'INCOMPLETE' }, 403, {
        key: empty.key,
      });
      await pair(
        { call: legacy(8), outcome: 'CANCELLED', parcels: [{}] },
        201,
        { ai: true },
      );
      await pair(
        {
          call: legacy(14),
          outcome: 'INCOMPLETE',
          customer: { name: '주문 없는 신규 고객', phoneNumber: '01056565656' },
        },
        201,
        { ai: true },
      );
      assert.equal(
        (
          await pair(
            {
              call: legacy(9),
              outcome: 'INCOMPLETE',
              parcels: [{ clientComment: '확인 중' }],
            },
            201,
            { ai: true },
          )
        ).data.status,
        'COLLECTING',
      );
      const cancelled = await pair(
        {
          call: legacy(10),
          outcome: 'CANCELLED',
          totalAmount: 6000,
          parcels: [{ notifiedPrice: 6000 }],
        },
        201,
        { ai: true },
      );
      assert.equal(cancelled.data.status, 'CANCELLED');
      assert.equal(cancelled.data.totalAmount, 0);
      await pair(
        {
          call: legacy(11),
          outcome: 'INCOMPLETE',
          parcels: [{ documentCount: 1 }],
        },
        201,
        { ai: true },
      );
      const done = await pair(
        { ...complete, call: legacy(12), outcome: 'COMPLETE' },
        201,
        { ai: true },
      );
      assert.equal(done.data.status, 'notPaid');
      await pair(
        { ...complete, call: legacy(12), outcome: 'INCOMPLETE' },
        201,
        { ai: true, key: done.key },
      );
      await pair(
        {
          ...complete,
          call: { ...legacy(16), callerPhoneNumber: '+8251515151' },
          outcome: 'COMPLETE',
        },
        409,
        { ai: true },
      );
      await pair(
        {
          ...complete,
          call: { ...legacy(16), callerPhoneNumber: '+821051515151' },
          outcome: 'COMPLETE',
        },
        201,
        { ai: true },
      );
      await pair(
        { call: legacy(17), outcome: 'COMPLETE', customerSeq: 110001 },
        422,
        { ai: true },
      );
      await pair(
        {
          ...complete,
          totalAmount: 6000,
          call: legacy(18),
          outcome: 'COMPLETE',
        },
        422,
        { ai: true },
      );
      await pair(
        {
          ...complete,
          paymentMethodType: 'credit',
          call: legacy(19),
          outcome: 'COMPLETE',
        },
        403,
        { ai: true },
      );
      for (const [n, phone, customerSeq, method] of [
        [20, '01051515154', 110004, 'credit'],
        [21, '01080808083', 98004, 'groupBilling'],
      ]) {
        for (const side of owners)
          await side.calls.query(
            'UPDATE call_sessions SET caller_phone_number=$2 WHERE call_session_seq=$1',
            [110000 + n, phone],
          );
        identities.set(110000 + n, { ...legacy(n), callerPhoneNumber: phone });
        assert.equal(
          (
            await pair(
              {
                ...complete,
                customerSeq,
                paymentMethodType: method,
                call: legacy(n),
                outcome: 'COMPLETE',
              },
              201,
              { ai: true },
            )
          ).data.status,
          'ACCEPTED',
        );
      }
      await pair(
        {
          ...complete,
          customerSeq: undefined,
          customer: { phoneNumber: '01057575757', name: '신규 완료' },
          call: legacy(15),
          outcome: 'COMPLETE',
        },
        201,
        { ai: true },
      );
      const lockKey = randomUUID(),
        hash = createHash('sha256')
          .update('orders.create:' + lockKey)
          .digest(),
        leases = [];
      try {
        for (const side of owners) {
          const client = await side.orders.connect();
          leases.push(client);
          await client.query('BEGIN');
          await client.query('SELECT pg_advisory_xact_lock($1::int,$2::int)', [
            hash.readInt32BE(0),
            hash.readInt32BE(4),
          ]);
        }
        await pair({ customerSeq: 110001 }, 409, { key: lockKey });
      } finally {
        for (const client of leases) {
          await client.query('ROLLBACK');
          client.release();
        }
      }
      const pending = {
        recordingId: 'creation-pbx',
        callFrom: legacy(22).callerPhoneNumber,
        callTo: '0211112222',
        startedAt: legacy(22).incomingAt,
        endedAt: new Date(
          Date.parse(legacy(22).incomingAt) + 60000,
        ).toISOString(),
        durationSeconds: 60,
        recordingUrl: 'https://recordings.example.test/creation.mp3',
      };
      for (const side of owners) {
        await side.calls.query(
          'UPDATE call_sessions SET caller_phone_number=$2,incoming_at=$3 WHERE call_session_seq=$1',
          [
            110023,
            pending.callFrom,
            new Date(Date.parse(pending.startedAt) + 1000).toISOString(),
          ],
        );
        await side.calls.query(
          'INSERT INTO pbx_webhooks.call_ended_events(recording_id,payload) VALUES($1,$2)',
          [pending.recordingId, pending],
        );
      }
      await pair(
        {
          call: legacy(22),
          outcome: 'INCOMPLETE',
          parcels: [{ clientComment: '종료 매칭' }],
        },
        201,
        { ai: true },
      );
      for (const side of owners)
        assert.equal(
          (
            await side.calls.query(
              'SELECT call_session_seq FROM pbx_webhooks.call_ended_events WHERE recording_id=$1',
              [pending.recordingId],
            )
          ).rows[0].call_session_seq,
          110022,
        );
      const stored = async (side) => ({
        orders: (
          await side.orders.query(
            'SELECT to_jsonb(o) AS data FROM orders o WHERE order_seq>80000 ORDER BY order_seq',
          )
        ).rows,
        parcels: (
          await side.orders.query(
            'SELECT to_jsonb(p) AS data FROM order_parcels p WHERE order_seq>80000 ORDER BY order_seq,parcel_position',
          )
        ).rows,
        payments: (
          await side.orders.query(
            'SELECT to_jsonb(p) AS data FROM order_payment_requests p WHERE order_seq>80000 ORDER BY order_seq',
          )
        ).rows,
        charges: (
          await side.orders.query(
            'SELECT order_seq,organization_seq,customer_seq,billing_month::text,payment_method_type,amount,occurred_at FROM order_billing_charges WHERE order_seq>80000 ORDER BY order_seq',
          )
        ).rows,
        empty: (
          await side.orders.query(
            'SELECT request_id,call_session_seq,actor_admin_user_seq FROM empty_ai_order_results WHERE call_session_seq BETWEEN 110001 AND 110036 ORDER BY call_session_seq',
          )
        ).rows,
        customers: (
          await side.customers.query(
            'SELECT to_jsonb(c) AS data FROM customers c WHERE customer_seq>500000 ORDER BY customer_seq',
          )
        ).rows,
        calls: (
          await side.calls.query(
            'SELECT ' +
              [
                ...callFields,
                'order_intake_enabled',
                'order_intake_version',
              ].join(',') +
              ' FROM call_sessions WHERE call_session_seq BETWEEN 110001 AND 110036 ORDER BY call_session_seq',
          )
        ).rows,
      });
      assert.deepEqual(
        normalize(await stored(owners[1]), 1),
        normalize(await stored(owners[0]), 0),
      );
      for (const [table, column, owner] of [
        ['orders', 'order_seq', 'orders'],
        ['order_parcels', 'order_parcel_seq', 'orders'],
        ['customers', 'customer_seq', 'customers'],
        ['call_sessions', 'call_session_seq', 'calls'],
      ]) {
        const values = [];
        for (const side of owners)
          values.push(
            (
              await side[owner].query(
                'SELECT last_value FROM ' + table + '_' + column + '_seq',
              )
            ).rows[0].last_value,
          );
        assert.equal(values[1], values[0], table + ' sequence');
      }
      const logs = async (db) =>
        (
          await db.query(
            'SELECT actor_type,actor_seq,actor_name,action,result,target_type,target_seq,metadata,request_id FROM audit_logs WHERE request_id=ANY($1::uuid[]) ORDER BY request_id,audit_log_seq',
            [requests],
          )
        ).rows;
      const original = await logs(reference);
      for (let n = 0; n < 100; n++) {
        if ((await logs(databases.operations)).length === original.length)
          break;
        await pause(25);
      }
      assert.deepEqual(await logs(databases.operations), original);

      const faultKey = randomUUID(),
        faultRequest = randomUUID();
      const faultCall = { ...legacy(25), callerPhoneNumber: '01062626262' };
      const faultInput = {
        call: faultCall,
        outcome: 'INCOMPLETE',
        customer: {
          name: '주문 없는 고객 복구',
          phoneNumber: faultCall.callerPhoneNumber,
        },
      };
      for (const side of owners)
        await side.calls.query(
          'UPDATE call_sessions SET caller_phone_number=$1 WHERE call_session_seq=110025',
          [faultCall.callerPhoneNumber],
        );
      const originalFault = await send(
        owners[0],
        faultInput,
        201,
        faultKey,
        faultRequest,
        { ai: true },
      );
      await databases.customer.query(
        "CREATE FUNCTION creation_customer_failure() RETURNS trigger LANGUAGE plpgsql AS $creation$ BEGIN IF NEW.event_type='OrderCustomerCreated' AND NEW.payload->'customer'->>'phoneNumber'='01062626262' THEN RAISE EXCEPTION 'test-only customer acknowledgement failure'; END IF; RETURN NEW; END $creation$",
      );
      await databases.customer.query(
        'CREATE TRIGGER creation_customer_failure BEFORE INSERT ON inbox_events FOR EACH ROW EXECUTE FUNCTION creation_customer_failure()',
      );
      try {
        await send(owners[1], faultInput, 500, faultKey, faultRequest, {
          ai: true,
        });
        assert.equal(
          (
            await databases.customer.query(
              "SELECT 1 FROM customers WHERE phone_number='01062626262'",
            )
          ).rowCount,
          0,
        );
        assert.equal(
          (
            await databases.order.query(
              'SELECT 1 FROM empty_ai_order_results WHERE request_id=$1',
              [faultKey],
            )
          ).rowCount,
          1,
        );
      } finally {
        await databases.customer.query(
          'DROP TRIGGER creation_customer_failure ON inbox_events',
        );
        await databases.customer.query(
          'DROP FUNCTION creation_customer_failure()',
        );
      }
      assert.deepEqual(
        (await pair(faultInput, 201, { key: faultKey, ai: true })).data,
        originalFault.data,
      );
      const customerEvent = (
        await databases.order.query(
          "SELECT o.event_id,o.payload FROM outbox_events o JOIN inbox_events i ON i.event_id=(o.payload->>'writeEventId')::uuid WHERE o.destination='customer' AND o.event_type='OrderCustomerCreated' AND i.payload->>'creationKey'=$1",
          [faultKey],
        )
      ).rows[0];
      for (let n = 0; n < 2; n++) {
        const response = await fetch(
          'http://customer-app:3001/internal/call-read-references/parcel-draft-write/events',
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer ' + process.env.CUSTOMER_AUTH_TOKEN,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              eventId: customerEvent.event_id,
              source: 'order',
              eventType: 'OrderCustomerCreated',
              payload: customerEvent.payload,
            }),
          },
        );
        assert.equal(response.status, 200);
        assert.equal((await response.json()).status, 'duplicate');
      }
      const callKey = randomUUID(),
        callRequest = randomUUID();
      const callInput = {
        call: legacy(24),
        outcome: 'INCOMPLETE',
        customerSeq: 110001,
        parcels: [{ clientComment: '상담 소유자 복구' }],
      };
      const recoverPending = {
        ...pending,
        recordingId: 'creation-pbx-recovery',
        callFrom: callInput.call.callerPhoneNumber,
        startedAt: callInput.call.incomingAt,
        endedAt: new Date(
          Date.parse(callInput.call.incomingAt) + 60000,
        ).toISOString(),
      };
      for (const side of owners)
        await side.calls.query(
          'INSERT INTO pbx_webhooks.call_ended_events(recording_id,payload) VALUES($1,$2)',
          [recoverPending.recordingId, recoverPending],
        );
      const originalCall = await send(
        owners[0],
        callInput,
        201,
        callKey,
        callRequest,
        { ai: true },
      );
      await databases.consultation.query(
        "CREATE FUNCTION creation_call_failure() RETURNS trigger LANGUAGE plpgsql AS $creation$ BEGIN IF NEW.event_type='LegacyOrderCallWritten' AND (NEW.payload->>'callSessionSeq')::int=110024 THEN RAISE EXCEPTION 'test-only call acknowledgement failure'; END IF; RETURN NEW; END $creation$",
      );
      await databases.consultation.query(
        'CREATE TRIGGER creation_call_failure BEFORE INSERT ON inbox_events FOR EACH ROW EXECUTE FUNCTION creation_call_failure()',
      );
      try {
        await send(owners[1], callInput, 500, callKey, callRequest, {
          ai: true,
        });
        assert.equal(
          (
            await databases.consultation.query(
              'SELECT order_seq FROM call_sessions WHERE call_session_seq=110024',
            )
          ).rows[0].order_seq,
          null,
        );
        assert.equal(
          (
            await databases.consultation.query(
              'SELECT call_session_seq FROM pbx_webhooks.call_ended_events WHERE recording_id=$1',
              [recoverPending.recordingId],
            )
          ).rows[0].call_session_seq,
          null,
        );
      } finally {
        await databases.consultation.query(
          'DROP TRIGGER creation_call_failure ON inbox_events',
        );
        await databases.consultation.query(
          'DROP FUNCTION creation_call_failure()',
        );
      }
      assert.deepEqual(
        (await pair(callInput, 201, { key: callKey, ai: true })).data,
        originalCall.data,
      );
      const callEvent = (
        await databases.order.query(
          "SELECT event_id,payload FROM outbox_events WHERE event_type='LegacyOrderCallWritten' AND aggregate_seq=110024",
        )
      ).rows[0];
      for (let n = 0; n < 2; n++) {
        const response = await fetch(
          'http://consultation-app:3004/internal/parcel-draft-write/events',
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer ' + process.env.CUSTOMER_AUTH_TOKEN,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              eventId: callEvent.event_id,
              source: 'order',
              eventType: 'LegacyOrderCallWritten',
              payload: callEvent.payload,
            }),
          },
        );
        assert.equal(response.status, 200);
        assert.equal((await response.json()).status, 'duplicate');
      }
      assert.deepEqual(
        normalize(await stored(owners[1]), 1),
        normalize(await stored(owners[0]), 0),
      );
      for (const side of owners)
        assert.equal(
          (
            await side.calls.query(
              'SELECT call_session_seq FROM pbx_webhooks.call_ended_events WHERE recording_id=$1',
              [recoverPending.recordingId],
            )
          ).rows[0].call_session_seq,
          110024,
        );
      const sequences = [];
      for (const side of owners)
        sequences.push(
          (
            await side.calls.query(
              'SELECT last_value FROM call_sessions_call_session_seq_seq',
            )
          ).rows[0].last_value,
        );
      assert.equal(
        sequences[1],
        sequences[0],
        'recovery preserves original call sequence allocation',
      );
      for (const requestId of [faultRequest, callRequest]) {
        const expected = (
          await reference.query(
            "SELECT action,target_seq FROM audit_logs WHERE request_id=$1 AND result='SUCCESS' ORDER BY audit_log_seq",
            [requestId],
          )
        ).rows;
        let actual;
        for (let n = 0; n < 100; n++) {
          actual = (
            await databases.operations.query(
              "SELECT action,target_seq FROM audit_logs WHERE request_id=$1 AND result='SUCCESS' ORDER BY audit_log_seq",
              [requestId],
            )
          ).rows;
          if (actual.length === expected.length) break;
          await pause(25);
        }
        assert.deepEqual(
          actual,
          expected,
          'original successful audit is recovered once',
        );
      }

      t.diagnostic(
        'order creation HTTP pairs: ' +
          pairs +
          '; request keys, customer identities, partial/empty/cancelled/complete calls, three payment methods, exact PBX matching and real customer/call owner rollback recovery',
      );
    },
  );
  console.log('Compared HTTP requests: '+compared);
});
