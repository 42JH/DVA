const { truncateFixture } = require('./fixture-reset.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { hashPassword } = require('./seed-password.cjs');

test('customer retention local cleanup preserves newer children and erases only expired personal details', async t=>{
  assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.PGDATABASE,'dva_webhook_test');
  const {RetentionRepository}=require('../dist/retention/retention.repository');
  const db=new Pool();t.after(()=>db.end());
  const transaction=async work=>{const client=await db.connect();try{await client.query('BEGIN');const result=await work(client);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}};
  const repo=new RetentionRepository({pool:db,transaction});
  await truncateFixture(db,'TRUNCATE customers,organizations,departments,memberships,personal_pins,payment_cards RESTART IDENTITY CASCADE');
  const at=process.env.RETENTION_AT;assert.ok(Number.isFinite(Date.parse(at)));
  const address={name:'보존 수령인',phoneNumber:'0212345678',roadAddress:'보존 도로',jibunAddress:'보존 지번',detailAddress:'',dongName:'보존동',postalCode:'01234'};
  const own={roadAddress:'개인 도로',jibunAddress:'개인 지번',detailAddress:'',dongName:'개인동',postalCode:'01234'};
  for(const [n,age]of [[1,null],[2,6],[3,4]])await db.query(`INSERT INTO customers(name,phone_number,status,deleted_at,monthly_billing_enabled,address_data)
    VALUES($1,$2,'ACTIVE',CASE WHEN $4::text IS NULL THEN NULL ELSE $3::timestamptz-$4::interval END,true,$5)`,['개인정보 '+n,'0100000000'+n,at,age===null?null:age+' years',own]);
  for(const [n,age]of [[1,6],[2,6],[3,4],[4,null]])await db.query(`INSERT INTO organizations(name,status,created_at,deleted_at)
    VALUES($1,'ACTIVE',$2::timestamptz-interval '7 years',CASE WHEN $3::text IS NULL THEN NULL ELSE $2::timestamptz-$3::interval END)`,['조직 '+n,at,age===null?null:age+' years']);
  for(const [n,org,age]of [[1,1,6],[2,2,6],[3,2,4]])await db.query(`INSERT INTO departments(organization_seq,name,created_at,deleted_at)
    VALUES($1,$2,$3::timestamptz-interval '7 years',$3::timestamptz-$4::interval)`,[org,'부서 '+n,at,age+' years']);
  for(const [n,customer,org,dept,age]of [[1,2,1,1,6],[2,3,2,2,4]])await db.query(`INSERT INTO memberships(customer_seq,organization_seq,department_seq,employee_no,role,status,deleted_at)
    VALUES($1,$2,$3,$4,'MEMBER','ACTIVE',$5::timestamptz-$6::interval)`,[customer,org,dept,'employee'+n,at,age+' years']);
  for(const [n,age]of [[1,6],[2,4]])await db.query(`INSERT INTO personal_pins(customer_seq,label,address_data,deleted_at)
    VALUES(2,$1,$2,$3::timestamptz-$4::interval)`,['주소 '+n,{...address,detailAddress:String(n)},at,age+' years']);
  for(const [n,customer,org,age]of [[1,2,null,6],[2,3,null,4],[3,null,1,6],[4,null,2,4]])await db.query(`INSERT INTO payment_cards(customer_seq,organization_seq,registration_key,request_hash,provider_customer_key,provider_environment,masked_number,expiration_year,expiration_month,status,created_at,updated_at,deleted_at)
    VALUES($1,$2,$3,repeat('a',64),$3,'test','****1234',2029,1,'FAILED',$4::timestamptz-interval '7 years',$4::timestamptz-interval '7 years',$4::timestamptz-$5::interval)`,[customer,org,'40000000-0000-4000-8000-'+String(n).padStart(12,'0'),at,age+' years']);
  const tables=[['customers','customer_seq'],['organizations','organization_seq'],['departments','department_seq'],['memberships','membership_seq'],['personal_pins','personal_pin_seq'],['payment_cards','payment_card_seq']];
  const snapshot=async()=>{const result={};for(const[table,key]of tables)result[table]=(await db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY ${key}`)).rows.map(r=>r.row);return result;};
  const before=await snapshot();
  const hasOutbox=!!(await db.query("SELECT to_regclass('outbox_events') AS name")).rows[0].name;
  const pending=async()=>hasOutbox?(await db.query("SELECT event_id,payload FROM outbox_events WHERE event_type='CustomerPaymentCardsPurged' ORDER BY outbox_seq")).rows:[];
  const pendingBefore=await pending();
  for(const [key,value]of [[20261103,157],[20261027,37]]){const gate=await db.connect();try{await gate.query('SELECT pg_advisory_lock($1,$2)',[key,value]);await repo.purgeDatabase();assert.deepEqual(await snapshot(),before);}finally{await gate.query('SELECT pg_advisory_unlock($1,$2)',[key,value]);gate.release();}}
  await db.query("CREATE FUNCTION customer_retention_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.anonymized_at IS DISTINCT FROM OLD.anonymized_at THEN RAISE EXCEPTION 'controlled anonymization failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER customer_retention_fault BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION customer_retention_fault()");
  try{await assert.rejects(repo.purgeDatabase());assert.deepEqual(await snapshot(),before);assert.deepEqual(await pending(),pendingBefore);}finally{await db.query('DROP TRIGGER customer_retention_fault ON customers; DROP FUNCTION customer_retention_fault()');}
  const gate=await db.connect();try{await gate.query('BEGIN');await gate.query('SELECT 1 FROM payment_cards WHERE payment_card_seq=1 FOR UPDATE');await repo.purgeDatabase();assert.deepEqual((await db.query('SELECT payment_card_seq FROM payment_cards ORDER BY payment_card_seq')).rows.map(r=>r.payment_card_seq),[1,2,4]);}finally{await gate.query('ROLLBACK');gate.release();}
  await repo.purgeDatabase();const after=await snapshot();
  assert.deepEqual(after.payment_cards.map(r=>r.payment_card_seq),[2,4]);assert.deepEqual(after.memberships.map(r=>r.membership_seq),[2]);assert.deepEqual(after.personal_pins.map(r=>r.personal_pin_seq),[2]);assert.deepEqual(after.departments.map(r=>r.department_seq),[2,3]);assert.deepEqual(after.organizations.map(r=>r.organization_seq),[2,3,4]);
  assert.equal(after.customers.length,3);assert.equal(after.customers[1].name,'삭제된 고객');assert.equal(after.customers[1].phone_number,'0002');assert.equal(after.customers[1].address_data,null);assert.equal(after.customers[1].monthly_billing_enabled,false);assert.ok(after.customers[1].anonymized_at);assert.deepEqual(after.customers[0],before.customers[0]);assert.deepEqual(after.customers[2],before.customers[2]);
  await repo.purgeDatabase();assert.deepEqual(await snapshot(),after);
  if(hasOutbox){const oldIds=new Set(pendingBefore.map(row=>row.event_id));assert.deepEqual((await pending()).filter(row=>!oldIds.has(row.event_id)).flatMap(row=>row.payload.ids).sort((a,b)=>a-b),[1,3]);}
  for(const rows of Object.values(after))for(const row of rows)for(const key of Object.keys(row))if(key.endsWith('_at')&&row[key]&&Date.parse(row[key])>=Date.parse(at)){assert.ok(Date.parse(row[key])<=Date.now()+2000);row[key]='<new fixture or retention timestamp>';}
  console.log(JSON.stringify({customerLocalRetention:after,localChildrenProtectRoot:true,rollback:true,lockedCardSkipped:true}));
});

test('customer retention hard deletion passes referenced pages and preserves source batches and child guards',async t=>{
  const {RetentionRepository}=require('../dist/retention/retention.repository');
  const {createHash}=require('node:crypto'),{createServer}=require('node:http');
  const db=new Pool();t.after(()=>db.end());
  await truncateFixture(db,'TRUNCATE customers,organizations,departments,memberships,personal_pins,payment_cards RESTART IDENTITY CASCADE');
  const at=process.env.RETENTION_AT,token='retention-reference-test-'.padEnd(48,'t');
  const source=!!(await db.query("SELECT to_regclass('orders') AS name")).rows[0].name;
  if(source)await truncateFixture(db,'TRUNCATE call_sessions RESTART IDENTITY CASCADE');
  else await db.query('TRUNCATE outbox_events,inbox_events');
  await db.query(`INSERT INTO customers(name,phone_number,status,deleted_at)
    SELECT '만료 고객 '||n,'010'||lpad(n::text,8,'0'),'ACTIVE',
    CASE WHEN n=1160 THEN NULL WHEN n=1159 THEN $1::timestamptz-interval '4 years' ELSE $1::timestamptz-interval '6 years' END FROM generate_series(1,1160) n`,[at]);
  await db.query("INSERT INTO organizations(name,status) VALUES('보존 기업','ACTIVE')");
  await db.query("INSERT INTO memberships(customer_seq,organization_seq,employee_no,status,deleted_at) VALUES(1158,1,'kept','ACTIVE',$1::timestamptz-interval '4 years')",[at]);
  const address={name:'보존 수령인',phoneNumber:'0212345678',roadAddress:'보존 도로',jibunAddress:'보존 지번',detailAddress:'',dongName:'보존동',postalCode:'01234'};
  await db.query('INSERT INTO personal_pins(customer_seq,address_data) VALUES(1156,$1)',[address]);
  await db.query("INSERT INTO payment_cards(customer_seq,registration_key,request_hash,provider_customer_key,provider_environment,expiration_year,expiration_month,status,deleted_at) VALUES(1157,$1,'kept',$1,'test',2099,12,'FAILED',$2::timestamptz-interval '4 years')",['40000000-0000-4000-8000-000000009999',at]);
  if(source)await db.query("INSERT INTO orders(customer_seq,creation_source,created_at,updated_at) SELECT customer_seq,'ADMIN',$1,$1 FROM customers WHERE customer_seq<=1050",[at]);
  let mode='ok',url='http://order:3002';const requests=[],errors=[];
  if(!source){const server=createServer(async(req,res)=>{try{const chunks=[];for await(const chunk of req)chunks.push(chunk);const event=JSON.parse(Buffer.concat(chunks));
    require('@dva/events/call-read-references.cjs').validateRetainedCustomersQuery(event);assert.equal(req.headers.authorization,'Bearer '+token);requests.push(event.payload.ids);
    if(mode==='fail'){res.writeHead(503).end();return;}res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({eventId:event.eventId,status:'processed',payload:event.payload.ids.filter(id=>id<=1050).sort((a,b)=>a-b)}));
  }catch(error){errors.push(error.message);res.writeHead(500).end();}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));url='http://127.0.0.1:'+server.address().port;t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});}
  const transaction=async work=>{const client=await db.connect();try{await client.query('BEGIN');const result=await work(client);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}};
  const repo=new RetentionRepository({pool:db,transaction},{get:key=>key==='ORDER_URL'?url:token});
  const {RetentionWorker}=require('../dist/retention/retention.worker');
  const worker=new RetentionWorker(repo,{pool:db,erase:async()=>{}},{get:key=>key==='ORDER_URL'?url:key==='NODE_ENV'?'test':token});t.after(()=>worker.onModuleDestroy());
  const snapshot=async()=>(await db.query('SELECT to_jsonb(c) AS row FROM customers c ORDER BY customer_seq')).rows.map(({row})=>{if(row.anonymized_at)row.anonymized_at='<anonymized>';return row;});
  const before=await snapshot();
  if(!source){mode='fail';await assert.rejects(repo.purgeDatabase());assert.deepEqual(await snapshot(),before);mode='ok';requests.length=0;}
  await db.query("CREATE FUNCTION retention_root_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled customer deletion failure'; END $$; CREATE TRIGGER retention_root_fault BEFORE DELETE ON customers FOR EACH ROW EXECUTE FUNCTION retention_root_fault()");
  try{await assert.rejects(repo.purgeDatabase());assert.deepEqual(await snapshot(),before);}finally{await db.query('DROP TRIGGER retention_root_fault ON customers; DROP FUNCTION retention_root_fault()');}
  requests.length=0;const gate=await db.connect(),batches=[];let count=1160;
  try{await gate.query('BEGIN');await gate.query('SELECT 1 FROM customers WHERE customer_seq=1051 FOR UPDATE');
    for(const expected of [100,4]){await worker.run();const rows=await snapshot();batches.push(count-rows.length);assert.equal(count-rows.length,expected);count=rows.length;assert.ok(rows.some(row=>row.customer_seq===1051));}
    if(!source){assert.ok(requests.some(ids=>ids.length===1000));assert.ok(requests.length>=4);assert.ok(requests.every(ids=>!ids.includes(1051)));}
  }finally{await gate.query('ROLLBACK');gate.release();}
  await worker.run();const after=await snapshot();batches.push(count-after.length);assert.deepEqual(batches,[100,4,1]);
  assert.deepEqual(after.map(row=>row.customer_seq),[...Array.from({length:1050},(_,n)=>n+1),1156,1157,1158,1159,1160]);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({customerRetentionRoots:{batches,remaining:after.length,rowsHash:createHash('sha256').update(JSON.stringify(after)).digest('hex')}}));
});

test('customer retention worker preserves source scheduling, shared runs, retry and shutdown',async t=>{
  const {RetentionWorker}=require('../dist/retention/retention.worker');
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const fakeDatabase={pool:{connect:async()=>({query:async()=>({rows:[]}),release:()=>{}})}};
  const config=environment=>({get:key=>key==='NODE_ENV'?environment:key==='ORDER_URL'?'http://order:3002':'retention-worker-test-'.padEnd(48,'t')});
  let calls=0,finish;
  const pending=new RetentionWorker({claimCall:async()=>undefined,purgeDatabase:()=>{calls++;return new Promise(resolve=>{finish=resolve;});}},fakeDatabase,config('test'));
  t.after(()=>pending.onModuleDestroy());pending.onApplicationBootstrap();await pause(5);assert.equal(calls,0);
  const one=pending.run(),two=pending.run();assert.equal(one,two);
  for(let n=0;!finish;n++){assert.ok(n<100);await pause(1);}
  let stopped=false;const shutdown=pending.onModuleDestroy().then(()=>{stopped=true;});await pause(5);assert.equal(stopped,false);
  finish(true);await Promise.all([one,two,shutdown]);await pending.run();assert.equal(calls,1);
  let fail=true,retries=0;const logs=[];
  const recovering=new RetentionWorker({claimCall:async()=>undefined,purgeDatabase:async()=>{retries++;if(fail)throw Error('private failure details');return true;}},fakeDatabase,config('test'));
  t.after(()=>recovering.onModuleDestroy());recovering.logger.error=value=>logs.push(value);
  await assert.rejects(recovering.run());fail=false;await recovering.run();assert.equal(retries,2);assert.deepEqual(logs,[{event:'retention_cleanup_failed'}]);await recovering.onModuleDestroy();
  let ticks=0;const scheduled=new RetentionWorker({claimCall:async()=>undefined,purgeDatabase:async()=>{ticks++;return true;}},fakeDatabase,config('production'));
  t.after(()=>scheduled.onModuleDestroy());scheduled.onApplicationBootstrap();
  const deadline=Date.now()+15000;while(ticks<2){assert.ok(Date.now()<deadline,'ten-second retention timer');await pause(50);}
  await scheduled.onModuleDestroy();assert.equal(ticks,2);await scheduled.run();assert.equal(ticks,2);
  console.log(JSON.stringify({customerRetentionWorker:{singleRun:true,retry:true,shutdown:true,timer:true}}));
});

test('customer reads match monolith with independent operations sessions and immutable customer data', async t => {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.PGDATABASE, 'dva_webhook_test');
  const reference = new Pool({ host: 'monolith-db', user: 'monolith_app' });
  const operations = new Pool({ host: 'operations-db', user: 'operations_app' });
  const customer = new Pool({ host: 'customer-db', user: 'customer_app' });
  t.after(async () => { await Promise.all([reference.end(), operations.end(), customer.end()]); });
  const sides = [
    { name: 'monolith', base: 'http://monolith-app:3000', auth: 'http://monolith-app:3000', db: reference, identity: reference, cookies: {} },
    { name: 'msa', base: 'http://customer-app:3001', auth: 'http://operations-app:3005', db: customer, identity: operations, cookies: {} },
  ];
  for (const base of [sides[0].base, sides[1].base, sides[1].auth]) {
    for (let attempt = 0; ; attempt++) {
      try { if ((await fetch(base+'/api/docs-json', { signal: AbortSignal.timeout(2000) })).ok) break; } catch { /* Wait for startup. */ }
      assert.ok(attempt < 60, base+' did not start');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  assert.equal((await fetch(sides[1].base+'/customer/health/ready')).status, 200);
  assert.equal((await customer.query("SELECT to_regclass('admin_users') IS NULL AND to_regclass('admin_sessions') IS NULL AS isolated")).rows[0].isolated, true);
  const password = 'read-parity-only-password';
  const hash = await hashPassword(password);
  const address = { roadAddress: '서울 도로 10', jibunAddress: '서울 지번 20', detailAddress: '3층', dongName: '역삼동', postalCode: '01234' };
  for (const side of sides) {
    await truncateFixture(side.identity, 'TRUNCATE admin_users,audit_logs RESTART IDENTITY CASCADE');
    for (const [login, role, status] of [['root','SYSTEM_ADMIN','ACTIVE'], ['operator','OPERATOR','ACTIVE'],
      ['supervisor','OPERATOR','ACTIVE'], ['pending','OPERATOR','PENDING'], ['inactive','OPERATOR','INACTIVE']]) {
      await side.identity.query(`INSERT INTO admin_users(login_id,name,password_hash,role,status,created_at)
        VALUES($1,$2,$3,$4,$5,'2025-10-01T00:00:00Z')`, [login, '테스트 '+login, hash, role, status]);
    }
    await truncateFixture(side.db, 'TRUNCATE customers,organizations,departments,memberships RESTART IDENTITY CASCADE');
    for (const [name,status,deleted,created] of [['한빛 %_[회사]','ACTIVE',null,'2025-10-01T00:00:00Z'],
      ['비활성기업','INACTIVE',null,null], ['삭제기업','ACTIVE','2026-01-01T00:00:00Z',null], ['빈 기업','ACTIVE',null,null]]) {
      await side.db.query('INSERT INTO organizations(name,status,deleted_at,created_at,monthly_billing_enabled) VALUES($1,$2,$3,$4,true)', [name,status,deleted,created]);
    }
    const people = [['김가람','01000000001','ACTIVE',null,address], ['검색 %_[문자]','01000000002','ACTIVE',null,null],
      ['탈퇴고객','01000000003','WITHDRAWN',null,address], ['삭제고객','01000000004','ACTIVE','2026-01-01T00:00:00Z',address],
      ['새 고객','01000000004','ACTIVE',null,address], ['부서 없는 고객','01000000006','ACTIVE',null,address]];
    for (const row of people) await side.db.query('INSERT INTO customers(name,phone_number,status,deleted_at,address_data,monthly_billing_enabled) VALUES($1,$2,$3,$4,$5,true)', row);
    await side.db.query(`INSERT INTO departments(organization_seq,name,group_billing_enabled,created_at,deleted_at) VALUES
      (1,'연구 개발',true,'2025-10-01T00:00:00Z',NULL),(1,'삭제 부서',false,NULL,'2026-01-01T00:00:00Z'),(2,'다른 부서',false,NULL,NULL)`);
    await side.db.query(`INSERT INTO memberships(customer_seq,organization_seq,department_seq,employee_no,role,status,deleted_at) VALUES
      (1,1,1,'0007','ORG_ADMIN','ACTIVE',NULL),(2,1,NULL,'A002','MEMBER','ACTIVE',NULL),
      (3,1,1,'003','MEMBER','ACTIVE',NULL),(4,1,2,'004','MEMBER','ACTIVE',NULL),
      (5,2,3,'005','MEMBER','INACTIVE',NULL),(6,1,NULL,'006','MEMBER','ACTIVE','2026-01-01T00:00:00Z')`);
  }
  async function snapshot(db) {
    const values = [];
    for (const query of [
      'SELECT customer_seq,name,phone_number,status,monthly_billing_enabled,address_data,deleted_at,anonymized_at FROM customers ORDER BY customer_seq',
      'SELECT organization_seq,name,status,monthly_billing_enabled,created_at,deleted_at FROM organizations ORDER BY organization_seq',
      'SELECT department_seq,organization_seq,name,group_billing_enabled,created_at,deleted_at FROM departments ORDER BY department_seq',
      'SELECT membership_seq,customer_seq,organization_seq,department_seq,employee_no,role,status,monthly_billing_enabled,group_billing_enabled,deleted_at FROM memberships ORDER BY membership_seq',
    ]) values.push((await db.query(query)).rows);
    return values;
  }
  const original = await snapshot(reference);
  assert.deepEqual(await snapshot(customer), original);
  let compared = 0;
  const origin = 'http://localhost:5173';
  async function request(method, path, actor, expected, body, options = {}) {
    const id = randomUUID(), results = [];
    for (const side of sides) {
      const response = await fetch((path.startsWith('/api/auth') || path.startsWith('/api/admins') ? side.auth : side.base)+path, {
        method, redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { 'X-Request-Id': id,
          ...((/^\/api\/customers\/\d/.test(path)||path.startsWith('/api/companies/search')) && options.ai !== false ? {Authorization:'Bearer '+(options.token ?? process.env.AI_BUSINESS_TOKEN)} : {}), ...(options.noOrigin ? {} : { Origin: options.origin ?? origin }),
          ...(actor && side.cookies[actor] ? { Cookie: options.duplicate ? side.cookies[actor]+'; '+side.cookies[actor] : side.cookies[actor] } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      assert.equal(response.status, expected, `${side.name} ${method} ${path}`);
      assert.equal(response.headers.get('x-request-id'), id);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const cookie = response.headers.get('set-cookie');
      if (options.login) {
        assert.match(cookie, /^dva_session=[a-f0-9]{64};/);
        assert.match(cookie, /; Path=\/api;/); assert.match(cookie, /; HttpOnly;/);
        assert.match(cookie, /; Secure;/); assert.match(cookie, /; SameSite=Lax/);
        side.cookies[options.login] = cookie.split(';')[0];
      }
      const text = await response.text(), result = text ? JSON.parse(text) : undefined;
      if (options.login) {
        const expiry = Date.parse(result.data.expiresAt);
        assert.ok(expiry > Date.now()+9*3600_000-10000 && expiry < Date.now()+9*3600_000+10000);
        result.data.expiresAt = '<valid-nine-hour-expiry>';
      }
      results.push({ body: result, origin: response.headers.get('access-control-allow-origin'),
        credentials: response.headers.get('access-control-allow-credentials'),
        cookie: cookie?.replace(/^dva_session=[^;]*/, 'dva_session=<opaque>').replace(/Expires=[^;]+/, 'Expires=<date>') });
    }
    assert.deepEqual(results[1], results[0], `${method} ${path} HTTP parity`);
    assert.deepEqual(await snapshot(customer), original, `${method} ${path} changed customer data`);
    assert.deepEqual(await snapshot(reference), original, `${method} ${path} changed monolith customer data`);
    compared++;
    return results[0].body;
  }
  const login = id => request('POST','/api/auth/login',undefined,200,{ loginId:id,password },{ login:id });
  for (const id of ['root','operator','supervisor']) await login(id);
  for (const path of ['/api/customers','/api/companies','/api/companies/1/members','/api/companies/1/departments'])
    await request('GET',path,undefined,401);
  await request('GET','/api/customers/1',undefined,200);
  await request('GET','/api/customers/3',undefined,404);
  await request('GET','/api/customers/3','operator',200);
  await request('GET','/api/customers/4','root',404);
  for (const actor of ['root','operator','supervisor']) {
    for (const path of ['/api/customers','/api/companies','/api/companies/1','/api/companies/1/members','/api/companies/1/departments'])
      await request('GET',path,actor,200);
  }
  for (const path of ['/api/customers?q=%25_%5B','/api/customers?phoneNumber=01000000004',
    '/api/customers?phoneNumber=0000','/api/customers?phoneNumber=0','/api/customers?status=WITHDRAWN','/api/customers?limit=1&offset=1','/api/customers?offset=99999',
    '/api/companies?q=%25_%5B','/api/companies?status=INACTIVE','/api/companies?limit=1&offset=99999',
    '/api/companies/2/members?status=INACTIVE','/api/companies/1/members?limit=1&offset=99999',
    '/api/companies/4/members','/api/companies/1/departments?limit=1&offset=99999','/api/companies/4/departments'])
    await request('GET',path,'root',200);
  for (const path of ['/api/companies/search?q=한빛%20연구','/api/companies/search?q=%25_%5B',
    '/api/companies/search?q=없는주소','/api/companies/search?q=한빛&limit=1&offset=99999']) {
    const result = await request('GET',path,undefined,200);
    for (const item of result.data) for (const field of ['employeeNo','role','personalPins']) assert.equal(item[field], undefined);
  }
  for(const actor of ['root','operator','supervisor']) await request('GET','/api/companies/search?q=한빛',actor,200,undefined,{ai:false});
  await request('GET','/api/companies/search?q=한빛',undefined,401,undefined,{ai:false});
  await request('GET','/api/customers/1',undefined,401,undefined,{ai:false});
  await request('GET','/api/customers/1',undefined,401,undefined,{token:'wrong'});
  await request('GET','/api/companies/members/search?q=김',undefined,401);
  for(const actor of ['root','operator','supervisor']) {
    const result=await request('GET','/api/companies/members/search?q=0007',actor,200);
    assert.equal(result.total_count,1);assert.equal(result.data[0].employeeNo,'0007');
  }
  for(const [q,total] of [['검색',1],['010-0000-0002',1],['연구 김',1],['한빛',0],['서울',0],['김 없는단어',0],['새',0]]) {
    const result=await request('GET','/api/companies/members/search?q='+encodeURIComponent(q),'root',200);
    assert.equal(result.total_count,total,q);
  }
  const inactive=await request('GET','/api/companies/members/search?q=새&includeInactive=true','root',200);
  assert.equal(inactive.total_count,1);assert.equal(inactive.data[0].membershipStatus,'INACTIVE');
  const emptyPage=await request('GET','/api/companies/members/search?q=검색&limit=1&offset=100','root',200);
  assert.equal(emptyPage.total_count,1);assert.deepEqual(emptyPage.data,[]);assert.equal(emptyPage.hasNext,false);
  for(const query of ['', '?q=%20%20', '?q='+encodeURIComponent('x'.repeat(101)), '?q=a%00b','?q=a&includeInactive=1','?q=a&limit=0','?q=a&unknown=true'])
    await request('GET','/api/companies/members/search'+query,'root',400);
  for (const path of ['/api/customers?status=PENDING','/api/customers?limit=0','/api/customers?limit=101',
    '/api/customers?offset=-1','/api/customers?limit=1&limit=2','/api/customers?extra=true',
    '/api/customers/0','/api/customers/2147483648','/api/companies/invalid',
    '/api/companies?status=SUSPENDED','/api/companies/1/members?status=WITHDRAWN',
    '/api/companies/1/departments?offset=1.5','/api/companies/search?q=%20%20'])
    await request('GET',path,'root',400);
  for (const path of ['/api/companies/3','/api/companies/3/members','/api/companies/3/departments','/api/customers/99999'])
    await request('GET',path,'root',404);
  await request('GET','/api/companies','operator',200,undefined,{ noOrigin:true });
  await request('GET','/api/companies','root',403,undefined,{ origin:'https://untrusted.invalid' });
  await request('GET','/api/customers/1','operator',401,undefined,{ duplicate:true });
  await request('PATCH','/api/admins/2','root',204,{ status:'INACTIVE' });
  await request('GET','/api/customers','operator',401);
  await request('GET','/api/companies/search?q=한빛','operator',401);
  await request('GET','/api/customers/1','operator',401);
  await request('PATCH','/api/admins/2','root',204,{ status:'ACTIVE' });
  await request('GET','/api/companies','operator',401);
  await login('operator');
  await request('GET','/api/companies','operator',200);
  await request('POST','/api/auth/logout','operator',204);
  await request('GET','/api/companies/search?q=한빛','operator',401);
  await request('GET','/api/companies/search?q=한빛',undefined,200);
  await login('operator');
  await request('DELETE','/api/admins','root',204,{adminUserSeqs:[2]});
  await request('GET','/api/customers','operator',401);
  const docs = await Promise.all(sides.map(async side => (await (await fetch(side.base+'/api/docs-json')).json())));
  for(const q of ['', '  ', '검색', '0000', '010-0000', '%', '_'])
    await request('GET','/api/companies/1/members?q='+encodeURIComponent(q),'root',200);
  for(const q of ['x'.repeat(101), '\0'])
    await request('GET','/api/companies/1/members?q='+encodeURIComponent(q),'root',400);
  const schemas = new Set();
  function compareSchemas(value) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.$ref === 'string') {
      assert.ok(value.$ref.startsWith('#/components/schemas/'));
      const name = value.$ref.slice('#/components/schemas/'.length);
      if (schemas.has(name)) return;
      schemas.add(name);
      assert.ok(docs[0].components.schemas[name], name+' missing reference schema');
      assert.deepEqual(docs[1].components.schemas[name], docs[0].components.schemas[name], name+' OpenAPI schema');
      compareSchemas(docs[0].components.schemas[name]);
    }
    for (const child of Object.values(value)) compareSchemas(child);
  }
  for (const path of ['/api/customers','/api/customers/{id}','/api/companies','/api/companies/search',
    '/api/companies/members/search','/api/companies/{id}','/api/companies/{id}/members','/api/companies/{id}/departments']) {
    assert.deepEqual(docs[1].paths[path].get, docs[0].paths[path].get, path+' OpenAPI');
    compareSchemas(docs[0].paths[path].get);
  }
  t.diagnostic(`${compared} identical requests compared; all seven reads preserved customer data`);
});
