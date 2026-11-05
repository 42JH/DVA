const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {Pool}=require('pg');
const {hashPassword}=require('./seed-password.cjs');
const {enqueue}=require('@dva/events');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('customer writes preserve monolith HTTP, business rows and immediately visible audit records',async t=>{
  assert.equal(process.env.NODE_ENV,'test'); assert.equal(process.env.PGDATABASE,'dva_webhook_test');
  const started=Date.now();
  const reference=new Pool({host:'monolith-db',user:'monolith_app'});
  const customer=new Pool({host:'customer-db',user:'customer_app'});
  const operations=new Pool({host:'operations-db',user:'operations_app'});
  t.after(async()=>{await Promise.all([reference.end(),customer.end(),operations.end()]);});
  const sides=[{base:'http://monolith-app:3000',auth:'http://monolith-app:3000',db:reference,identity:reference,cookies:{}},
    {base:'http://customer-app:3001',auth:'http://operations-app:3005',db:customer,identity:operations,cookies:{}}];
  for(const base of [sides[0].base,sides[1].base,sides[1].auth])for(let retry=0;;retry++){
    try{if((await fetch(base+'/api/docs-json',{signal:AbortSignal.timeout(2000)})).ok)break;}catch{}
    assert.ok(retry<60,'test-mode application did not start');await delay(250);
  }
  const password='customer-writes-test-only-password'; const hash=await hashPassword(password);
  for(const side of sides){
    await side.db.query('TRUNCATE customers,organizations,departments,memberships RESTART IDENTITY CASCADE');
    await side.identity.query('TRUNCATE admin_users,audit_logs RESTART IDENTITY CASCADE');
    if(side===sides[1]){await customer.query('TRUNCATE outbox_events,inbox_events RESTART IDENTITY CASCADE');await operations.query('TRUNCATE customer_audit_preparations,outbox_events,inbox_events RESTART IDENTITY CASCADE');}
    await side.identity.query(`INSERT INTO admin_users(login_id,name,password_hash,role,status,created_at) VALUES
      ('root','전체 운영자',$1,'SYSTEM_ADMIN','ACTIVE','2025-01-01Z'),('writer','고객 담당자',$1,'OPERATOR','ACTIVE','2025-01-01Z')`,[hash]);
  }
  const normalize=value=>{
    if(value instanceof Date){assert.ok(Number.isFinite(value.getTime()));return value.getTime()>=started-1000&&value.getTime()<=Date.now()+1000?'<generated-time>':value.toISOString();}
    if(Array.isArray(value))return value.map(normalize);
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>{
      if(typeof item==='string'&&['createdAt','occurredAt','deletedAt','lastLoginAt'].includes(key)&&Number.isFinite(Date.parse(item)))item=new Date(item);
      return[key,normalize(item)];}));
    return value;
  };
  const queries=[
    'SELECT customer_seq,name,phone_number,status,monthly_billing_enabled,address_data,deleted_at,anonymized_at FROM customers ORDER BY customer_seq',
    'SELECT organization_seq,name,status,monthly_billing_enabled,created_at,deleted_at FROM organizations ORDER BY organization_seq',
    'SELECT department_seq,organization_seq,name,group_billing_enabled,created_at,deleted_at FROM departments ORDER BY department_seq',
    'SELECT membership_seq,customer_seq,organization_seq,department_seq,employee_no,role,status,deleted_at FROM memberships ORDER BY membership_seq',
    'SELECT company_pin_seq,organization_seq,department_seq,department_name,label,address_data,version,deleted_at FROM company_pins ORDER BY company_pin_seq',
    'SELECT personal_pin_seq,customer_seq,label,address_data,version FROM personal_pins ORDER BY personal_pin_seq'];
  const auditSQL='SELECT audit_log_seq,actor_type,actor_seq,actor_name,action,target_type,target_seq,target_admin_name,request_id,result,metadata,occurred_at FROM audit_logs ORDER BY audit_log_seq';
  async function compareState(label){
    for(const sql of queries)assert.deepEqual(normalize((await customer.query(sql)).rows),normalize((await reference.query(sql)).rows),label+' '+sql);
    assert.deepEqual(normalize((await operations.query(auditSQL)).rows),normalize((await reference.query(auditSQL)).rows),label+' audit');
    assert.equal((await operations.query('SELECT count(*)::int AS n FROM customer_audit_preparations WHERE NOT aborted')).rows[0].n,0,label+' unconfirmed audit');
  }
  let compared=0;
  async function request(method,path,body,status,actor='root',options={}){
    const id=randomUUID(),results=[];
    for(const side of sides){
      const endpoint=/^\/api\/(auth|admins|audit-logs)(\/|\?|$)/.test(path)?side.auth:side.base;
      const r=await fetch(endpoint+path,{method,signal:AbortSignal.timeout(15000),redirect:'error',
        headers:{'X-Request-Id':id,...(options.noOrigin?{}:{Origin:options.origin??'http://localhost:5173'}),
          ...(actor&&side.cookies[actor]?{Cookie:side.cookies[actor]}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
      assert.equal(r.status,status,method+' '+path+' '+side.base);assert.equal(r.headers.get('x-request-id'),id);
      assert.equal(r.headers.get('cache-control'),'no-store');
      const cookie=r.headers.get('set-cookie'); if(options.login){assert.match(cookie,/^dva_session=[a-f0-9]{64};/);side.cookies[options.login]=cookie.split(';')[0];}
      const text=await r.text(),value=text?JSON.parse(text):undefined;
      if(options.login){const expiry=Date.parse(value.data.expiresAt);assert.ok(Math.abs(expiry-Date.now()-9*3600_000)<15000);value.data.expiresAt='<nine-hours>';}
      results.push({body:normalize(value),cors:r.headers.get('access-control-allow-origin'),credentials:r.headers.get('access-control-allow-credentials'),
        cookie:cookie?.replace(/^dva_session=[^;]*/,'dva_session=<opaque>').replace(/Expires=[^;]+/,'Expires=<valid>')});
    }
    assert.deepEqual(results[1],results[0],method+' '+path+' response');await compareState(method+' '+path);compared++;return results[0].body;
  }
  for(const loginId of ['root','writer'])await request('POST','/api/auth/login',{loginId,password},200,null,{login:loginId});
  const address={roadAddress:'서울 도로 10',jibunAddress:'서울 지번 20',detailAddress:'3층',dongName:'역삼동',postalCode:'01234'};
  const person=(name,phoneNumber)=>({name,phoneNumber});
  const ai=(await request('POST','/api/customers',person('AI 고객','01011110001'),201,null)).data.customerSeq;
  await request('POST','/api/customers',person('중복','01011110001'),409,null);
  await request('POST','/api/customers',{...person('권한 없음','01011110002'),monthlyBillingEnabled:true},403,null);
  await request('POST','/api/customers',{...person('관리자 고객','01011110002'),monthlyBillingEnabled:true,address},201);
  for(const body of [{name:' ',phoneNumber:'0109'},{name:'고객',phoneNumber:'invalid'},
    {...person('고객','01011110003'),status:'ACTIVE'}])await request('POST','/api/customers',body,400,null);
  const company=(await request('POST','/api/companies',{name:' 본사 ',departments:[{name:'영업',groupBillingEnabled:true},{name:'지원'}],
    members:[{name:'이직원',phoneNumber:'01022220001',employeeNo:'0001',departmentName:'영업',address},
      {name:'김직원',phoneNumber:'01022220002',employeeNo:'0002',role:'ORG_ADMIN'}]},201)).data.organizationSeq;
  for(const path of [`/api/companies/${company}`,`/api/companies/${company}/departments`,`/api/companies/${company}/members`])await request('GET',path,undefined,200,'writer');
  await request('PATCH',`/api/companies/${company}`,{status:'INACTIVE'},204,'writer');
  await request('POST',`/api/companies/${company}/departments`,{name:'대기'},409);
  await request('POST',`/api/companies/${company}/members`,{customerSeq:ai,employeeNo:'0003',role:'MEMBER'},409);
  await request('PATCH',`/api/companies/${company}`,{name:'기업 변경',status:'ACTIVE',monthlyBillingEnabled:true},204);
  const dept=(await request('POST',`/api/companies/${company}/departments`,{name:' 신규 '},201)).data.departmentSeq;
  await request('POST',`/api/companies/${company}/departments`,{name:'신규'},409);
  await request('PATCH',`/api/departments/${dept}`,{name:'신규 이름',groupBillingEnabled:true},204);
  for(const body of [{},{groupBillingEnabled:'true'}])await request('PATCH',`/api/departments/${dept}`,body,400);
  await request('PATCH','/api/departments/99999',{name:'없음'},404);
  await request('POST',`/api/companies/${company}/members`,{customerSeq:ai,employeeNo:'0003',role:'MEMBER',departmentSeq:dept},204);
  const member=(await reference.query('SELECT membership_seq FROM memberships WHERE customer_seq=$1 AND deleted_at IS NULL',[ai])).rows[0].membership_seq;
  await request('POST',`/api/companies/${company}/members`,{customerSeq:ai,employeeNo:'duplicate-customer',role:'MEMBER'},409);
  const unmapped=(await reference.query("SELECT customer_seq FROM customers WHERE phone_number='01011110002'")).rows[0].customer_seq;
  await request('POST',`/api/companies/${company}/members`,{customerSeq:unmapped,employeeNo:'0001',role:'MEMBER'},409);
  await request('POST',`/api/companies/${company}/members`,{items:[]},400);
  await request('POST',`/api/companies/${company}/members`,{name:'잘못된 직원',phoneNumber:'0103333',employeeNo:'valid',unknown:true},400);
  await request('PATCH',`/api/members/${member}`,{role:'ORG_ADMIN',status:'INACTIVE',departmentSeq:null},204);
  await request('PATCH',`/api/members/${member}`,{status:'ACTIVE',departmentSeq:dept},204);
  await request('POST',`/api/companies/${company}/members`,{items:[{name:'변경 직원',phoneNumber:'01022220001',employeeNo:'0001',departmentSeq:dept},
    {name:'추가 직원',phoneNumber:'01022220003',employeeNo:'0004'}]},204);
  await request('POST',`/api/companies/${company}/members`,{items:[{customerSeq:ai,employeeNo:'x',role:'MEMBER'},{customerSeq:ai,employeeNo:'y',role:'MEMBER'}]},400);
  await request('POST',`/api/companies/${company}/members`,{customerSeq:ai,employeeNo:'bad\u0000',role:'MEMBER'},400);
  const other=(await request('POST','/api/companies',{name:'다른 기업',departments:[{name:'다른 부서'}]},201)).data.organizationSeq;
  await request('PATCH',`/api/companies/${other}`,{},400);
  await request('PATCH',`/api/companies/${other}`,{monthlyBillingEnabled:'true'},400);
  await request('PATCH','/api/companies/99999',{name:'없는 기업'},404);
  await request('PATCH','/api/companies/0',{name:'잘못된 번호'},400);
  const foreign=(await reference.query('SELECT department_seq FROM departments WHERE organization_seq=$1',[other])).rows[0].department_seq;
  await request('PATCH',`/api/members/${member}`,{departmentSeq:foreign},422);
  await request('DELETE',`/api/members/${member}`,undefined,204);
  await request('DELETE',`/api/members/${member}`,undefined,404);
  await request('POST',`/api/companies/${company}/members`,{customerSeq:ai,employeeNo:'0003',role:'MEMBER',departmentSeq:dept},204);
  const pinAddress={...address,name:'수신자',phoneNumber:'01011110001'};
  for(const side of sides){
    await side.db.query('INSERT INTO company_pins(organization_seq,department_seq,department_name,label,address_data) VALUES($1,$2,$3,$4,$5)',[company,dept,'신규 이름','회사 PIN',pinAddress]);
    await side.db.query('INSERT INTO personal_pins(customer_seq,label,address_data) VALUES($1,$2,$3)',[ai,'개인 PIN',pinAddress]);
  }
  await request('PATCH',`/api/departments/${dept}`,{name:'배송 부서'},204);
  assert.equal((await customer.query('SELECT version FROM company_pins WHERE company_pin_seq=1')).rows[0].version,2);
  await request('DELETE',`/api/departments/${dept}`,undefined,204);
  await request('DELETE',`/api/departments/${dept}`,undefined,404);
  await request('DELETE',`/api/companies/${company}`,undefined,204);
  await request('GET',`/api/companies/${company}`,undefined,404);
  assert.equal((await customer.query('SELECT count(*)::int AS n FROM personal_pins WHERE customer_seq=$1',[ai])).rows[0].n,1);
  for(const side of sides)await side.db.query("UPDATE customers SET status='WITHDRAWN' WHERE customer_seq=$1",[ai]);
  await request('POST','/api/companies',{name:'전체 rollback',departments:[{name:'준비 부서'}],members:[{name:'탈퇴 충돌',phoneNumber:'01011110001',employeeNo:'R001'}]},422);
  assert.equal((await customer.query("SELECT count(*)::int AS n FROM organizations WHERE name='전체 rollback'")).rows[0].n,0);
  const trigger=`CREATE FUNCTION reject_customer_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='CUSTOMER_CREATED' AND NEW.result='SUCCESS' THEN RAISE EXCEPTION 'injected audit failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_customer_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_customer_audit()`;
  for(const db of [reference,operations])await db.query(trigger);
  try{await request('POST','/api/customers',person('감사 실패','01099990001'),500);}finally{for(const db of [reference,operations])await db.query('DROP TRIGGER reject_customer_audit ON audit_logs; DROP FUNCTION reject_customer_audit()');}
  assert.equal((await customer.query("SELECT count(*)::int AS n FROM customers WHERE phone_number='01099990001'")).rows[0].n,0);
  await request('POST','/api/companies',{name:'Origin 없음'},403,'writer',{noOrigin:true});
  await request('PATCH','/api/admins/2',{status:'INACTIVE'},204);
  await request('POST','/api/companies',{name:'회수 세션'},401,'writer');
  await request('GET','/api/audit-logs?limit=100',undefined,200);
  await request('GET','/api/audit-logs?limit=1&offset=99999',undefined,200);
  const documents=await Promise.all(sides.map(async side=>(await (await fetch(side.base+'/api/docs-json')).json())));
  const seen=new Set();
  function schemas(value){if(!value||typeof value!=='object')return;
    if(typeof value.$ref==='string'){
      assert.ok(value.$ref.startsWith('#/components/schemas/'));const name=value.$ref.slice('#/components/schemas/'.length);
      if(seen.has(name))return;seen.add(name);assert.ok(documents[0].components.schemas[name]);
      assert.deepEqual(documents[1].components.schemas[name],documents[0].components.schemas[name],name+' write schema');schemas(documents[0].components.schemas[name]);
    }for(const child of Object.values(value))schemas(child);}
  for(const [path,methods] of Object.entries({'/api/customers':['post'],'/api/companies':['post'],
    '/api/companies/{id}':['patch','delete'],'/api/companies/{id}/members':['post'],'/api/companies/{id}/departments':['post'],
    '/api/members/{id}':['patch','delete'],'/api/departments/{id}':['patch','delete']}))for(const method of methods){
    assert.deepEqual(documents[1].paths[path][method],documents[0].paths[path][method],method+' '+path+' OpenAPI');schemas(documents[0].paths[path][method]);}
  t.diagnostic(`${compared} identical write/read/auth requests compared with business and audit data after each response`);

  await t.test('prepared, duplicate, aborted and delayed confirmations preserve audit visibility',async()=>{
    const token=process.env.CUSTOMER_AUTH_TOKEN;
    const send=async event=>{const r=await fetch(sides[1].auth+'/internal/events',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(event)});return{status:r.status,body:await r.json()};};
    const prepared=()=>({eventId:randomUUID(),source:'customer',eventType:'AuditPrepared',payload:{transactionId:randomUUID(),audit:{actorId:null,actorType:'AI',action:'CUSTOMER_CREATED',targetType:'CUSTOMER',targetId:ai,requestId:randomUUID()},result:'SUCCESS',occurredAt:new Date().toISOString()}});
    const first=prepared();assert.equal((await send(first)).status,200);assert.equal((await send(first)).body.status,'duplicate');
    assert.equal((await send({...first,payload:{...first.payload,result:'FAILED'}})).status,409);
    assert.equal((await operations.query('SELECT count(*)::int AS n FROM audit_logs WHERE request_id=$1',[first.payload.audit.requestId])).rows[0].n,0);
    const abort=transactionId=>({eventId:randomUUID(),source:'customer',eventType:'AuditAborted',payload:{transactionId}});
    assert.equal((await send(abort(first.payload.transactionId))).status,200);assert.equal((await send(first)).body.status,'duplicate');
    const late=prepared();assert.equal((await send(abort(late.payload.transactionId))).status,200);assert.equal((await send(late)).status,200);
    assert.equal((await operations.query('SELECT audit IS NULL AND aborted AS stopped FROM customer_audit_preparations WHERE event_id=$1',[late.payload.transactionId])).rows[0].stopped,true);
    const abandoned=prepared();assert.equal((await send(abandoned)).status,200);
    assert.equal((await fetch(sides[1].auth+'/api/audit-logs',{headers:{Cookie:sides[1].cookies.root}})).status,200);
    assert.equal((await operations.query('SELECT audit IS NULL AND aborted AS stopped FROM customer_audit_preparations WHERE event_id=$1',[abandoned.eventId])).rows[0].stopped,true);
    const confirmed=prepared(),earlier=prepared();earlier.payload.transactionId=confirmed.payload.transactionId;
    assert.equal((await send(earlier)).status,200);assert.equal((await send(confirmed)).status,200);
    const gate=await operations.connect();await gate.query('SELECT pg_advisory_lock(20261105,777)');
    await operations.query(`CREATE FUNCTION delay_confirmed_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.request_id='${confirmed.payload.audit.requestId}'::uuid THEN PERFORM pg_advisory_xact_lock(20261105,777); END IF; RETURN NEW; END $$;
      CREATE TRIGGER delay_confirmed_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION delay_confirmed_audit()`);
    let eventId,firstBatchId;
    try{
      const transaction=await customer.connect();
      try{await transaction.query('BEGIN');
        firstBatchId=await enqueue(transaction,{destination:'operations',eventType:'AuditCommitted',aggregateSeq:1,payload:{transactionId:confirmed.payload.transactionId,preparedEventIds:[earlier.eventId]}});
        eventId=await enqueue(transaction,{destination:'operations',eventType:'AuditCommitted',aggregateSeq:1,payload:{transactionId:confirmed.payload.transactionId,preparedEventIds:[confirmed.eventId]}});
        await transaction.query('COMMIT');}finally{transaction.release();}
      let returned=false;
      const read=fetch(sides[1].auth+'/api/audit-logs?limit=100',{headers:{Cookie:sides[1].cookies.root}}).then(async r=>{returned=true;assert.equal(r.status,200);return r.json();});
      for(let retry=0;!(await customer.query('SELECT delivered_at FROM outbox_events WHERE event_id=$1',[firstBatchId])).rows[0].delivered_at;retry++){
        assert.ok(retry<40,'first confirmation batch did not complete');await delay(50);
      }
      assert.equal((await operations.query('SELECT count(*)::int AS n FROM audit_logs WHERE request_id=$1',[earlier.payload.audit.requestId])).rows[0].n,1);
      await delay(200);assert.equal(returned,false,'audit read acknowledged only part of a committed transaction');
      await gate.query('SELECT pg_advisory_unlock(20261105,777)');
      const body=await read;assert.equal(body.data.filter(row=>row.requestId===confirmed.payload.audit.requestId).length,1);
      assert.equal(body.data.filter(row=>row.requestId===earlier.payload.audit.requestId).length,1);
      const row=(await customer.query('SELECT event_id,event_type,payload FROM outbox_events WHERE event_id=$1',[eventId])).rows[0];
      assert.equal((await send({eventId:row.event_id,source:'customer',eventType:row.event_type,payload:row.payload})).body.status,'duplicate');
      assert.equal((await operations.query('SELECT count(*)::int AS n FROM audit_logs WHERE request_id=$1',[confirmed.payload.audit.requestId])).rows[0].n,1);
    }finally{await gate.query('SELECT pg_advisory_unlock_all()');gate.release();await operations.query('DROP TRIGGER delay_confirmed_audit ON audit_logs; DROP FUNCTION delay_confirmed_audit()');}
  });
  await t.test('a killed producer rolls back its business row and orphaned preparation is aborted after its lock is released',async()=>{
    const {spawn}=require('node:child_process'),{once}=require('node:events');
    const child=spawn(process.execPath,['-e',`
      require('reflect-metadata');
      const {randomUUID}=require('node:crypto');
      const {DatabaseService}=require('./dist/database/database.service');
      const {AuditService}=require('./dist/audit/audit.service');
      const values={DB_HOST:'customer-db',DB_PORT:5432,DB_USER:'customer_app',DB_PASSWORD:process.env.PGPASSWORD,
        DB_NAME:'dva_webhook_test',OPERATIONS_URL:'http://operations-app:3005',CUSTOMER_AUTH_TOKEN:process.env.CUSTOMER_AUTH_TOKEN};
      const config={get:key=>values[key]},db=new DatabaseService(config),audit=new AuditService(db,config);
      db.transaction(async client=>{
        const id=(await client.query("INSERT INTO customers(name,phone_number,status) VALUES('crash-test','01099990002','ACTIVE') RETURNING customer_seq")).rows[0].customer_seq;
        const requestId=randomUUID();await audit.recordSuccess({actorId:null,actorType:'AI',action:'CUSTOMER_CREATED',targetType:'CUSTOMER',targetId:id,requestId},client);
        process.send({requestId});await new Promise(()=>{});
      }).catch(()=>{process.exit(1)});
    `],{stdio:['ignore','ignore','pipe','ipc']});
    try{
      const [{requestId}]=await once(child,'message',{signal:AbortSignal.timeout(10000)});
      let read=await fetch(sides[1].auth+'/api/audit-logs?limit=100',{headers:{Cookie:sides[1].cookies.root}});
      assert.equal(read.status,200);assert.equal((await read.json()).data.some(row=>row.requestId===requestId),false);
      assert.equal((await operations.query("SELECT aborted FROM customer_audit_preparations WHERE audit->>'request_id'=$1",[requestId])).rows[0].aborted,false);
      child.kill('SIGKILL');await once(child,'exit');
      for(let retry=0;;retry++){
        read=await fetch(sides[1].auth+'/api/audit-logs?limit=100',{headers:{Cookie:sides[1].cookies.root}});assert.equal(read.status,200);
        if(!(await operations.query("SELECT 1 FROM customer_audit_preparations WHERE audit->>'request_id'=$1 AND NOT aborted",[requestId])).rowCount)break;
        assert.ok(retry<20);await delay(50);
      }
      assert.equal((await customer.query("SELECT count(*)::int AS n FROM customers WHERE phone_number='01099990002'")).rows[0].n,0);
      assert.equal((await operations.query('SELECT count(*)::int AS n FROM audit_logs WHERE request_id=$1',[requestId])).rows[0].n,0);
    }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit');}}
  });
});
