const { truncateFixture } = require('./fixture-reset.cjs');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID,createHmac,createDecipheriv}=require('node:crypto');
const {Pool}=require('pg');
const {hashPassword}=require('./seed-password.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('customer PATCH and personal PIN APIs preserve HTTP, call locks and separate business DBs',async t=>{
 assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.PGDATABASE,'dva_webhook_test');
 const started=Date.now(),origin='http://localhost:5173',password='pins-test-only-password';
 const mono=new Pool({host:'monolith-db',user:'monolith_app'}),customer=new Pool({host:'customer-db',user:'customer_app'}),calls=new Pool({host:'consultation-db',user:'consultation_app'}),operations=new Pool({host:'operations-db',user:'operations_app'});
 t.after(async()=>{await Promise.all([mono.end(),customer.end(),calls.end(),operations.end()]);});
 const sides=[{base:'http://monolith-app:3000',auth:'http://monolith-app:3000',db:mono,calls:mono,identity:mono,cookies:{}},
  {base:'http://customer-app:3001',auth:'http://operations-app:3005',db:customer,calls,identity:operations,cookies:{}}];
 for(const side of sides)for(let attempt=0;;attempt++){try{if((await fetch(side.base+'/api/docs-json')).ok)break;}catch{}assert.ok(attempt<80);await delay(250);}
 const hash=await hashPassword(password);
 for(const side of sides){
  await truncateFixture(side.calls, 'TRUNCATE pbx_webhooks.call_ended_events,recordings,call_utterances,call_sessions RESTART IDENTITY CASCADE');
  await truncateFixture(side.db, 'TRUNCATE customers,organizations,departments,memberships,personal_pins RESTART IDENTITY CASCADE');
  await truncateFixture(side.identity, 'TRUNCATE admin_users,audit_logs RESTART IDENTITY CASCADE');
  if(side===sides[1]){await truncateFixture(customer, 'TRUNCATE inbox_events,outbox_events RESTART IDENTITY');await truncateFixture(calls, 'TRUNCATE inbox_events,outbox_events RESTART IDENTITY');await truncateFixture(operations, 'TRUNCATE inbox_events,outbox_events,customer_audit_preparations,consultation_audit_preparations RESTART IDENTITY');}
  await side.identity.query(`INSERT INTO admin_users(login_id,name,password_hash,role,status,created_at) VALUES
   ('root','개발 운영자',$1,'SYSTEM_ADMIN','ACTIVE','2026-01-01Z'),('operator','상담 운영자',$1,'OPERATOR','ACTIVE','2026-01-01Z'),('supervisor','관리 운영자',$1,'OPERATOR','ACTIVE','2026-01-01Z')`,[hash]);
  await side.db.query(`INSERT INTO customers(name,phone_number,status,monthly_billing_enabled) VALUES
   ('내 고객','01091110001','ACTIVE',false),('다른 고객','01091110002','ACTIVE',true),('탈퇴 고객','01091110003','WITHDRAWN',false),('숨김 고객','01091110004','ACTIVE',false);
   UPDATE customers SET deleted_at='2026-01-01Z' WHERE customer_seq=4;`);
  await side.calls.query(`INSERT INTO call_sessions(provider_call_id,caller_phone_number,incoming_at,customer_seq,started_at,ended_at,deleted_at) VALUES
   ('ongoing','01091110001','2026-10-27T01:00:00Z',1,NULL,NULL,NULL),
   ('ended','01091110001','2026-10-27T02:00:00Z',1,'2026-10-27T02:00:01Z','2026-10-27T02:01:01Z',NULL),
   ('other','01091110002','2026-10-27T03:00:00Z',2,NULL,NULL,NULL),
   ('deleted','01091110001','2026-10-27T04:00:00Z',1,NULL,NULL,'2026-10-28Z'),
   ('expired','01091110001','2020-01-01Z',1,NULL,NULL,NULL),
   ('legacy','01091110001',NULL,NULL,NULL,NULL,NULL),
   ('different-identity','01091110001','2026-10-27T05:00:00Z',2,NULL,NULL,NULL),
   ('no-phone',NULL,'2026-10-27T06:00:00Z',NULL,NULL,NULL,NULL)`);
 }
 const registrations = new Map();
 async function cardRows(db) {
   const rows = (await db.query('SELECT * FROM payment_cards ORDER BY payment_card_seq')).rows;
   const generatedKeys = new Set(),
     nonces = new Set();
   for (const row of rows) {
     const expected = registrations.get(row.registration_key);
     if (!expected) continue;
     const input = expected.input;
     const hash = createHmac('sha256', Buffer.from('01'.repeat(32), 'hex'))
       .update(
         JSON.stringify([
           expected.kind,
           expected.id,
           input.cardNumber,
           input.expirationYear,
           input.expirationMonth,
           input.customerIdentityNumber,
           input.cardPassword ?? null,
           input.customerName ?? null,
         ]),
       )
       .digest('hex');
     assert.equal(row.request_hash, hash);
     assert.match(
       row.provider_customer_key,
       /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
     );
     assert.equal(generatedKeys.has(row.provider_customer_key), false);
     generatedKeys.add(row.provider_customer_key);
     row.provider_customer_key = '<card-customer-' + row.payment_card_seq + '>';
     if (row.encrypted_billing_key !== null) {
       const bytes = Buffer.from(row.encrypted_billing_key, 'base64');
       assert.equal(bytes.toString('base64'), row.encrypted_billing_key);
       assert.ok(bytes.length > 28);
       const nonce = bytes.subarray(0, 12).toString('hex');
       assert.equal(nonces.has(nonce), false);
       nonces.add(nonce);
       const decipher = createDecipheriv(
         'aes-256-gcm',
         Buffer.from('01'.repeat(32), 'hex'),
         bytes.subarray(0, 12),
       );
       decipher.setAAD(Buffer.from(String(row.payment_card_seq)));
       decipher.setAuthTag(bytes.subarray(-16));
       const key = Buffer.concat([
         decipher.update(bytes.subarray(12, -16)),
         decipher.final(),
       ]).toString('utf8');
       assert.equal(key, 'fixture-billing-key-' + row.registration_key);
       row.encrypted_billing_key = '<verified-billing-key-' + row.registration_key + '>';
     }
     if (row.claimed_until !== null) {
       const at = row.claimed_until.getTime();
       assert.ok(
         at >= started + 90000 - 1000 && at <= Date.now() + 90000 + 1000,
         'registration uses the source 90-second claim',
       );
       row.claimed_until = '<registration-90-second-claim>';
     }
   }
   return normalize(rows);
 }

 const normalize=(value,key)=>{
  if(value instanceof Date){if(['occurred_at','last_login_at'].includes(key)||['created_at','updated_at','deleted_at'].includes(key)&&value.getTime()>=started-1000&&value.getTime()<=Date.now()+1000){assert.ok(value.getTime()>=started-1000&&value.getTime()<=Date.now()+1000);return'<generated-time>';}return value.toISOString();}
  if(Array.isArray(value))return value.map(item=>normalize(item,key));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([name,item])=>[name,normalize(item,name)]));return value;
 };
 const tables=[
  'SELECT customer_seq,name,phone_number,status,monthly_billing_enabled,address_data,deleted_at,anonymized_at FROM customers ORDER BY customer_seq',
  'SELECT organization_seq,name,status,monthly_billing_enabled,created_at,deleted_at FROM organizations ORDER BY organization_seq',
  'SELECT department_seq,organization_seq,name,group_billing_enabled,created_at,deleted_at FROM departments ORDER BY department_seq',
  'SELECT membership_seq,customer_seq,organization_seq,department_seq,employee_no,role,status,monthly_billing_enabled,group_billing_enabled,deleted_at FROM memberships ORDER BY membership_seq',
  'SELECT personal_pin_seq,customer_seq,label,address_data,search_text,version,deleted_at FROM personal_pins ORDER BY personal_pin_seq',
  'SELECT * FROM payment_cards ORDER BY payment_card_seq'];
 const callSQL='SELECT call_session_seq,provider_call_id,caller_phone_number,incoming_at,started_at,ended_at,deleted_at,customer_seq,order_seq FROM call_sessions ORDER BY call_session_seq';
 const auditSQL='SELECT audit_log_seq,actor_type,actor_seq,actor_name,action,target_type,target_seq,target_admin_name,request_id,result,metadata,occurred_at FROM audit_logs ORDER BY audit_log_seq';
 async function compare(label){
  for(const sql of tables) {
    const current=sql.startsWith('SELECT * FROM payment_cards')?await cardRows(customer):normalize((await customer.query(sql)).rows);
    const reference=sql.startsWith('SELECT * FROM payment_cards')?await cardRows(mono):normalize((await mono.query(sql)).rows);
    assert.deepEqual(current,reference,label+' '+sql);
  }
  assert.deepEqual(normalize((await calls.query(callSQL)).rows),normalize((await mono.query(callSQL)).rows),label+' calls');
  assert.deepEqual(normalize((await operations.query(auditSQL)).rows),normalize((await mono.query(auditSQL)).rows),label+' all audit');
  assert.equal((await operations.query('SELECT count(*)::int n FROM customer_audit_preparations WHERE NOT aborted')).rows[0].n,0,label+' unconfirmed audit');
 }
 let count=0;
 async function fetchSide(side,method,path,body,options={},requestId=randomUUID()){
  const endpoint=/^\/api\/(auth|audit-logs)(\/|\?|$)/.test(path)?side.auth:side.base;
  const response=await fetch(endpoint+path,{method,redirect:'error',signal:AbortSignal.timeout(28000),headers:{'X-Request-Id':requestId,...(/^\/api\/(?:customers|companies|pins)(?:\/|$)/.test(path)?{Authorization:'Bearer '+process.env.AI_BUSINESS_TOKEN}:{}),
   ...(options.admin?{Cookie:side.cookies[options.admin],Origin:origin}:{}),...(options.cookie?{Cookie:options.cookie}:{}),
   ...(options.origin?{Origin:options.origin}:{}),...(options.key?{'Idempotency-Key':options.key}:{}),...(options.call===undefined?{}:{call_session_seq:String(options.call)}),
   ...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:options.raw?body:JSON.stringify(body)});
  const text=await response.text();let value=text?JSON.parse(text):undefined;
  assert.equal(response.headers.get('x-request-id'),requestId);assert.equal(response.headers.get('cache-control'),'no-store');
  if(options.login){const cookie=response.headers.get('set-cookie');assert.match(cookie,/^dva_session=[a-f0-9]{64};/);side.cookies[options.login]=cookie.split(';')[0];
   assert.ok(Math.abs(Date.parse(value.data.expiresAt)-Date.now()-9*3600_000)<15000);value.data.expiresAt='<nine-hours>';}
  return {status:response.status,body:value,cors:response.headers.get('access-control-allow-origin'),credentials:response.headers.get('access-control-allow-credentials')};
 }
 async function request(method,path,body,status,options={}){
  const requestId=randomUUID(),results=[];
  for(const side of sides){const value=await fetchSide(side,method,path,body,options,requestId);assert.equal(value.status,status,side.base+' '+method+' '+path+' '+JSON.stringify(value.body));results.push(value);}
  assert.deepEqual(results[1],results[0],method+' '+path);await compare(method+' '+path);count++;return results[0].body;
 }
 for(const loginId of ['root','operator','supervisor'])await request('POST','/api/auth/login',{loginId,password},200,{origin,login:loginId});
 const schemas=[];
 for(const side of sides)schemas.push(await(await fetch(side.base+'/api/docs-json')).json());
 const paths={'/api/customers/{id}/card':['get','put'],'/api/companies/{id}/group-card':['get','put'],'/api/customers/cards':['delete'],'/api/companies/group-cards':['delete'],'/api/customers/{id}':['patch'],'/api/customers/{id}/pins':['get','post'],'/api/pins/{id}':['patch']};
 const refs=new Set(),visit=value=>{if(Array.isArray(value)){value.forEach(visit);return;}if(value&&typeof value==='object')for(const[k,v]of Object.entries(value)){if(k==='$ref'&&typeof v==='string')refs.add(v.split('/').pop());else visit(v);}};
 for(const[path,methods]of Object.entries(paths))for(const method of methods){assert.deepEqual(schemas[1].paths[path][method],schemas[0].paths[path][method]);visit(schemas[0].paths[path][method]);}
 for(const name of refs){assert.deepEqual(schemas[1].components.schemas[name],schemas[0].components.schemas[name],name);visit(schemas[0].components.schemas[name]);}
 assert.equal(schemas[1].paths['/internal/call-scope'],undefined);

 await t.test(
   'personal and company cards preserve current caller access, masked output and read locks',
   async () => {
     const beforeCount = count;
     for (const side of sides) {
       await side.db.query(
         "INSERT INTO organizations(name,status,created_at) VALUES('카드 기업','ACTIVE','2026-01-01Z'),('비활성 기업','INACTIVE','2026-01-01Z'),('삭제 기업','ACTIVE','2026-01-01Z'); UPDATE organizations SET deleted_at='2026-01-01Z' WHERE organization_seq=3",
       );
       await side.db.query(
         "INSERT INTO memberships(customer_seq,organization_seq,employee_no,status,group_billing_enabled) VALUES(1,1,'card-1','ACTIVE',false),(2,1,'card-2','ACTIVE',false)",
       );
     }
     for (const path of ['/api/customers/1/card', '/api/companies/1/group-card']) {
       assert.equal((await request('GET', path, undefined, 200, { call: 1 })).data, null);
       for (const call of [undefined, 'invalid', '0', '2147483648'])
         await request('GET', path, undefined, 400, { call });
       for (const [call, status] of [
         [2, 409],
         [4, 404],
         [5, 404],
         [7, 403],
         [8, 403],
         [99999, 404],
       ])
         await request('GET', path, undefined, status, { call });
       await request('GET', path, undefined, 401, { call: 1, cookie: 'dva_session=bad' });
     }
     await request('GET', '/api/customers/1/card', undefined, 403, { call: 3 });
     await request('GET', '/api/companies/1/group-card', undefined, 200, { call: 3 });
     for (const [path, status] of [
       ['/api/customers/3/card', 409],
       ['/api/customers/4/card', 404],
       ['/api/customers/99999/card', 404],
       ['/api/companies/2/group-card', 409],
       ['/api/companies/3/group-card', 404],
       ['/api/companies/99999/group-card', 404],
     ])
       await request('GET', path, undefined, status, { call: 'invalid' });
     const cards = [
       [1, null, 'ACTIVE', null, '************1234', 'issuer'],
       [null, 1, 'ACTIVE', null, '************5678', null],
       [2, null, 'FAILED', null, null, null],
       [2, null, 'ACTIVE', '2026-01-01Z', '************9999', 'old'],
     ];
     for (const row of cards) {
       const registrationKey = randomUUID(),
         providerKey = randomUUID();
       for (const side of sides)
         await side.db.query(
           'INSERT INTO payment_cards(customer_seq,organization_seq,registration_key,request_hash,provider_customer_key,provider_environment,encrypted_billing_key,issuer_code,masked_number,expiration_year,expiration_month,status,created_at,updated_at,deleted_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,2099,12,$10,$11,$11,$12)',
           [
             row[0],
             row[1],
             registrationKey,
             'fixed-request-hash',
             providerKey,
             'test',
             'private-encrypted-billing-key',
             row[5],
             row[4],
             row[2],
             '2026-01-01Z',
             row[3],
           ],
         );
     }
     for (const [path, id, mask, issuer] of [
       ['/api/customers/1/card', 1, '************1234', 'issuer'],
       ['/api/companies/1/group-card', 2, '************5678', null],
     ]) {
       for (const call of [1, 6]) {
         const data = (await request('GET', path, undefined, 200, { call })).data;
         assert.deepEqual(data, {
           paymentCardSeq: id,
           issuerCode: issuer,
           maskedNumber: mask,
           expirationYear: 2099,
           expirationMonth: 12,
           active: true,
         });
       }
       for (const admin of ['root', 'operator', 'supervisor'])
         await request('GET', path, undefined, 200, { admin, call: 'invalid' });
     }
     assert.equal(
       (await request('GET', '/api/customers/2/card', undefined, 200, { call: 3 })).data,
       null,
     );
     for (const side of sides)
       await side.db.query(
         "UPDATE payment_cards SET expiration_year=2020 WHERE payment_card_seq=1; UPDATE memberships SET status='INACTIVE' WHERE customer_seq=2",
       );
     const expired = (await request('GET', '/api/customers/1/card', undefined, 200, { call: 1 }))
       .data;
     assert.equal(expired.expirationYear, 2020);
     assert.equal(expired.active, true);
     await request('GET', '/api/companies/1/group-card', undefined, 403, { call: 3 });
     for (const side of sides)
       await side.db.query("UPDATE memberships SET status='ACTIVE' WHERE customer_seq=2");
     const requestId = randomUUID(),
       responses = [];
     for (const side of sides) {
       const call = (
         await side.calls.query(
           "INSERT INTO call_sessions(provider_call_id,caller_phone_number,incoming_at,customer_seq) VALUES('card-read-lock','01091110001','2026-10-27T09:00:00Z',1) RETURNING call_session_seq",
         )
       ).rows[0].call_session_seq;
       const gate = await side.db.connect(),
         ending = await side.calls.connect();
       let read, termination;
       try {
         await gate.query('BEGIN');
         const gatePid = (await gate.query('SELECT pg_backend_pid() pid')).rows[0].pid;
         await gate.query('LOCK TABLE payment_cards IN ACCESS EXCLUSIVE MODE');
         read = fetchSide(side, 'GET', '/api/customers/1/card', undefined, { call }, requestId);
         let blocked = false;
         for (let n = 0; n < 150; n++) {
           blocked = (
             await side.db.query(
               'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) blocked',
               [gatePid],
             )
           ).rows[0].blocked;
           if (blocked) break;
           await delay(10);
         }
         assert.equal(blocked, true, 'card SELECT waits after caller permission');
         await ending.query('BEGIN');
         const endingPid = (await ending.query('SELECT pg_backend_pid() pid')).rows[0].pid;
         termination = ending.query(
           "UPDATE call_sessions SET started_at='2026-10-27T09:00:01Z',ended_at='2026-10-27T09:01:00Z' WHERE call_session_seq=$1",
           [call],
         );
         let held = false;
         for (let n = 0; n < 150; n++) {
           held = (
             await side.calls.query('SELECT cardinality(pg_blocking_pids($1))>0 held', [endingPid])
           ).rows[0].held;
           if (held) break;
           await delay(10);
         }
         assert.equal(
           held,
           true,
           'card read retains live caller SHARE lock until local read completes',
         );
         await gate.query('COMMIT');
         const response = await read;
         assert.equal(response.status, 200);
         responses.push(response);
         await termination;
         await ending.query('COMMIT');
       } finally {
         await gate.query('ROLLBACK');
         gate.release();
         await ending.query('ROLLBACK');
         ending.release();
         await read?.catch(() => {});
         await termination?.catch(() => {});
       }
     }
     assert.deepEqual(responses[1], responses[0]);
     await compare('card caller read lock');
     count++;
     for (const db of [customer, calls])
       assert.equal(
         (
           await db.query(
             "SELECT count(*)::int n FROM inbox_events WHERE event_type IN ('PaymentCardCallScopeRequested','PaymentCardCallerRead')",
           )
         ).rows[0].n,
         0,
       );
     console.log(
       JSON.stringify({
         cardReadPairs: count - beforeCount,
         cardReadCallLockRaces: 1,
         fullPaymentCardRows: true,
         privateResultPersistence: false,
       }),
     );
   },
 );


 await t.test(
   'card removal preserves denied owners, audit rollback and repeated deletion',
   async () => {
     const beforeCount = count;
     for (const [path, key] of [['/api/customers/cards', 'customerSeqs'], ['/api/companies/group-cards', 'organizationSeqs']]) {
       for (const call of [undefined, 'bad', 0])
         await request('DELETE', path, { [key]: [1] }, 400, { call });
       for (const [call, status] of [
         [2, 409],
         [4, 404],
         [7, 403],
         [8, 403],
       ])
         await request('DELETE', path, { [key]: [1] }, status, { call });
       await request('DELETE', path, { [key]: [1] }, 403, { call: 1, cookie: 'dva_session=bad' });
       await request('DELETE', path, { [key]: [1] }, 401, { call: 1, cookie: 'dva_session=bad', origin });
     }
     for (const [path, key, id, status] of [
       ['/api/customers/cards', 'customerSeqs', 3, 409],
       ['/api/customers/cards', 'customerSeqs', 4, 404],
       ['/api/companies/group-cards', 'organizationSeqs', 2, 409],
       ['/api/companies/group-cards', 'organizationSeqs', 3, 404],
       ['/api/customers/cards', 'customerSeqs', 'invalid', 400],
     ])
       await request('DELETE', path, { [key]: [id] }, status, { call: 'bad' });
     for (const status of ['REGISTERING', 'FAILED']) {
       const key = randomUUID(),
         provider = randomUUID();
       for (const side of sides)
         await side.db.query(
           "INSERT INTO payment_cards(customer_seq,registration_key,request_hash,provider_customer_key,provider_environment,expiration_year,expiration_month,status,created_at,updated_at) VALUES(1,$1,'fixed-pending-card',$2,'test',2099,12,$3,'2026-01-01Z','2026-01-01Z')",
           [key, provider, status],
         );
     }
     for (const side of sides)
       await side.identity.query(
         "CREATE FUNCTION reject_card_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='PAYMENT_CARD_DELETED' AND NEW.result='SUCCESS' THEN RAISE EXCEPTION 'injected card audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_card_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_card_audit()",
       );
     try {
       await request('DELETE', '/api/customers/cards', { customerSeqs: [1] }, 500, { call: 1 });
     } finally {
       for (const side of sides)
         await side.identity.query(
           'DROP TRIGGER reject_card_audit ON audit_logs; DROP FUNCTION reject_card_audit()',
         );
     }
     await request('GET', '/api/customers/1/card', undefined, 200, { call: 1 });
     await request('DELETE', '/api/customers/cards', { customerSeqs: [1] }, 204, { call: 6 });
     await request('DELETE', '/api/customers/cards', { customerSeqs: [1] }, 204, { call: 1 });
     assert.equal(
       (await request('GET', '/api/customers/1/card', undefined, 200, { call: 1 })).data,
       null,
     );
     await request('DELETE', '/api/companies/group-cards', { organizationSeqs: [1] }, 204, {
       admin: 'operator',
       call: 'bad',
     });
     await request('DELETE', '/api/companies/group-cards', { organizationSeqs: [1] }, 204, { call: 3 });
     assert.equal(
       (await request('GET', '/api/companies/1/group-card', undefined, 200, { admin: 'root' })).data,
       null,
     );
     assert.equal(
       (
         await customer.query(
           'SELECT count(*)::int n FROM payment_cards WHERE customer_seq=1 AND deleted_at IS NULL',
         )
       ).rows[0].n,
       0,
     );
     assert.equal(
       (
         await operations.query(
           "SELECT count(*)::int n FROM audit_logs WHERE action='PAYMENT_CARD_DELETED' AND result='SUCCESS'",
         )
       ).rows[0].n,
       4,
     );
     for (const [path, key, column] of [
       ['/api/customers/cards', 'customerSeqs', 'customer_seq'],
       ['/api/companies/group-cards', 'organizationSeqs', 'organization_seq'],
     ]) {
       if (column === 'organization_seq') for (const side of sides)
         await side.db.query("UPDATE organizations SET status='ACTIVE' WHERE organization_seq=2");
       const cardIds = [];
       for (const id of [1, 2]) {
         const key = randomUUID(), provider = randomUUID(), inserted = [];
         for (const side of sides) inserted.push((await side.db.query(`INSERT INTO payment_cards(
           ${column},registration_key,request_hash,provider_customer_key,provider_environment,
           encrypted_billing_key,masked_number,expiration_year,expiration_month,status,created_at,updated_at)
           VALUES($1,$2,'fixed-batch-removal',$3,'test','private-billing-key','************5678',2099,12,'ACTIVE','2026-01-01Z','2026-01-01Z')
           RETURNING payment_card_seq`, [id, key, provider])).rows[0].payment_card_seq);
         assert.equal(inserted[1], inserted[0]);
         cardIds.push(inserted[0]);
       }
       const before = await cardRows(mono);
       const affectedIds = before.filter(row => [1, 2].includes(row[column]) && row.deleted_at === null)
         .map(row => row.payment_card_seq);
       const successes = async () => (await mono.query("SELECT target_seq,request_id FROM audit_logs WHERE action='PAYMENT_CARD_DELETED' AND result='SUCCESS' ORDER BY audit_log_seq")).rows;
       const beforeAudit = await successes();
       for (const input of [undefined, {}, { [key]: [] }, { [key]: [1, 1] }, { [key]: ['1'] },
         { [key]: [0] }, { [key]: [1.5] }, { [key]: [2147483648] }, { [key]: [1], extra: true }])
         await request('DELETE', path, input, 400, { admin: 'root' });
       await request('DELETE', path, { [key]: [2, 1] }, 403, { call: 1 });
       await request('DELETE', path, { [key]: [1, 2147483647] }, 404, { admin: 'root' });
       assert.deepEqual(await cardRows(mono), before);
       assert.deepEqual(await successes(), beforeAudit);
       for (const side of sides) await side.identity.query(`CREATE FUNCTION reject_second_card_audit() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN IF NEW.action='PAYMENT_CARD_DELETED' AND NEW.result='SUCCESS' AND NEW.target_seq=${cardIds[1]}
         THEN RAISE EXCEPTION 'private second card audit failure'; END IF; RETURN NEW; END $$;
         CREATE TRIGGER reject_second_card_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_second_card_audit()`);
       try {
         await request('DELETE', path, { [key]: [2, 1] }, 500, { admin: 'root' });
         assert.deepEqual(await cardRows(mono), before);
         assert.deepEqual(await successes(), beforeAudit);
       } finally {
         for (const side of sides) await side.identity.query('DROP TRIGGER reject_second_card_audit ON audit_logs; DROP FUNCTION reject_second_card_audit()');
       }
       await request('DELETE', path, { [key]: [2, 1] }, 204, { admin: 'operator' });
       const audits = (await successes()).slice(beforeAudit.length);
       assert.deepEqual(audits.map(row => row.target_seq).sort((a, b) => a - b), affectedIds);
       assert.equal((await mono.query(`SELECT count(*)::int n FROM payment_cards
         WHERE payment_card_seq=ANY($1::int[]) AND deleted_at IS NULL`, [affectedIds])).rows[0].n, 0);
       assert.equal(new Set(audits.map(row => row.request_id)).size, 1);
       await request('DELETE', path, { [key]: [1, 2] }, 204, { admin: 'root' });
       assert.deepEqual(await successes(), [...beforeAudit, ...audits]);
       if (column === 'organization_seq') for (const side of sides)
         await side.db.query("UPDATE organizations SET status='INACTIVE' WHERE organization_seq=2");
     }
     for (const path of ['/api/customers/1/card', '/api/companies/1/group-card'])
       await request('DELETE', path, undefined, 404, { admin: 'root' });
     console.log(
       JSON.stringify({
         cardRemovalPairs: count - beforeCount,
         allCardStatesRemoved: true,
         auditRollback: true,
         repeatedDeleteAddsNoAudit: true,
       }),
     );
   },
 );


 await t.test(
   'card registration and replacement preserve provider idempotency, encryption and recovery',
   async () => {
     const beforeCount = count;
     const input = {
       cardNumber: '4000000000001234',
       expirationYear: 2099,
       expirationMonth: 12,
       customerIdentityNumber: '900101',
       cardPassword: '01',
       customerName: '검증 명의',
     };
     const personal = '/api/customers/1/card',
       company = '/api/companies/1/group-card';
     const remember = (path, key, value) => {
       key = key.toLowerCase();
       if (!registrations.has(key))
         registrations.set(key, {
           kind: path.includes('/companies/') ? 'ORGANIZATION' : 'CUSTOMER',
           id: Number(path.split('/')[3]),
           input: structuredClone(value),
         });
     };
     async function register(path, value, status, options = {}) {
       const key = options.key ?? randomUUID();
       if (/^[0-9a-f-]{36}$/i.test(key)) remember(path, key, value);
       return { key, body: await request('PUT', path, value, status, { call: 1, ...options, key }) };
     }
     const peer = (side) =>
       side === sides[0] ? 'http://monolith-app:8000' : 'http://customer-app:8000';
     async function providerRequests(side, key) {
       const response = await fetch(peer(side) + '/__requests', {
         headers: { Authorization: 'Bearer ' + process.env.CUSTOMER_AUTH_TOKEN },
       });
       assert.equal(response.status, 200);
       return (await response.json()).filter(
         (row) =>
           row.path === '/v1/billing/authorizations/card' && (!key || row.registrationKey === key),
       );
     }
     async function release(side, key) {
       const response = await fetch(peer(side) + '/__card-release', {
         method: 'POST',
         headers: {
           Authorization: 'Bearer ' + process.env.CUSTOMER_AUTH_TOKEN,
           'Content-Type': 'application/json',
         },
         body: JSON.stringify({ key }),
       });
       assert.equal(response.status, 200);
       return response.json();
     }
     for (const path of [personal, company]) {
       await request('PUT', path, input, 400, { call: 1 });
       await register(path, input, 400, { key: 'invalid' });
       for (const invalid of [
         { ...input, cardNumber: '4000-0000-0000-1234' },
         { ...input, expirationMonth: 0 },
         { ...input, expirationYear: '2099' },
         { ...input, customerIdentityNumber: '1' },
         { ...input, cardPassword: null },
         { ...input, customerName: 'x'.repeat(101) },
         { ...input, cvv: '123' },
       ])
         await register(path, invalid, 400);
       await register(path, { ...input, expirationYear: 2000 }, 400);
     }
     for (const [path, status] of [
       ['/api/customers/3/card', 409],
       ['/api/customers/4/card', 404],
       ['/api/customers/99999/card', 404],
       ['/api/companies/2/group-card', 409],
     ])
       await register(path, input, status, { call: 'bad' });
     for (const call of [undefined, 'bad', 0]) await register(personal, input, 400, { call });
     for (const [call, status] of [
       [2, 409],
       [3, 403],
       [7, 403],
       [8, 403],
     ])
       await register(personal, input, status, { call });
     const first = await register(personal, input, 200);
     assert.equal(first.body.data.maskedNumber, '************1234');
     assert.equal(first.body.data.issuerCode, 'fixture-is');
     await register(personal, input, 200, { key: first.key.toUpperCase() });
     await register(personal, { ...input, customerName: '변경된 명의' }, 409, { key: first.key });
     for (const side of sides) assert.equal((await providerRequests(side, first.key)).length, 1);
     await register(company, { ...input, customerName: '', cardPassword: undefined }, 200, {
       admin: 'supervisor',
       call: 'bad',
     });
     await register(personal, { ...input, cardNumber: '4000000000000001' }, 422);
     const unknown = await register(personal, { ...input, cardNumber: '4000000000000002' }, 502);
     await register(personal, { ...input, cardNumber: '4000000000000002' }, 409, {
       key: unknown.key,
     });
     for (const ending of ['0003', '0004', '0005'])
       await register(personal, { ...input, cardNumber: '400000000000' + ending }, 502);
     const lost = await register(personal, { ...input, cardNumber: '4000000000000007' }, 502);
     await register(personal, { ...input, cardNumber: '4000000000000007' }, 409, { key: lost.key });
     for (const side of sides)
       await side.db.query(
         "UPDATE payment_cards SET claimed_until='2026-01-01Z' WHERE registration_key=$1",
         [lost.key],
       );
     await register(personal, { ...input, cardNumber: '4000000000000007' }, 200, { key: lost.key });
     for (const side of sides) assert.equal((await providerRequests(side, lost.key)).length, 2);
     const auditKey = randomUUID(),
       auditInput = { ...input, customerName: '감사 복구' };
     for (const side of sides)
       await side.identity.query(
         "CREATE FUNCTION reject_card_registration_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='PAYMENT_CARD_REGISTERED' AND NEW.result='SUCCESS' THEN RAISE EXCEPTION 'injected registration audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_card_registration_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_card_registration_audit()",
       );
     try {
       await register(personal, auditInput, 500, { key: auditKey });
     } finally {
       for (const side of sides)
         await side.identity.query(
           'DROP TRIGGER reject_card_registration_audit ON audit_logs; DROP FUNCTION reject_card_registration_audit()',
         );
     }
     await register(personal, auditInput, 409, { key: auditKey });
     for (const side of sides)
       await side.db.query(
         "UPDATE payment_cards SET claimed_until='2026-01-01Z' WHERE registration_key=$1",
         [auditKey],
       );
     await register(personal, auditInput, 200, { key: auditKey });
     const gateKey = randomUUID(),
       gatedInput = { ...input, cardNumber: '4000000000000006' },
       ids = [randomUUID(), randomUUID()];
     remember(personal, gateKey, gatedInput);
     const gatedResults = [];
     for (const side of sides) {
       let pending;
       try {
         pending = fetchSide(side, 'PUT', personal, gatedInput, { key: gateKey, call: 1 }, ids[0]);
         for (let n = 0; ; n++) {
           if ((await providerRequests(side, gateKey)).length) break;
           assert.ok(n < 150);
           await delay(10);
         }
         await side.db.query('SELECT 1 FROM customers WHERE customer_seq=1 FOR UPDATE NOWAIT');
         const concurrent = await fetchSide(
           side,
           'PUT',
           personal,
           gatedInput,
           { key: gateKey, call: 1 },
           ids[1],
         );
         assert.equal(concurrent.status, 409);
         await release(side, gateKey);
         const result = await pending;
         assert.equal(result.status, 200);
         gatedResults.push([result, concurrent]);
       } finally {
         await release(side, gateKey);
         await pending?.catch(() => {});
       }
     }
     assert.deepEqual(gatedResults[1], gatedResults[0]);
     await compare('same-key registration race');
     count += 2;
     const endedKey = randomUUID(),
       endedId = randomUUID(),
       endedResults = [];
     remember(personal, endedKey, gatedInput);
     for (const side of sides) {
       const call = (
         await side.calls.query(
           "INSERT INTO call_sessions(provider_call_id,caller_phone_number,incoming_at,customer_seq) VALUES('card-register-ended','01091110001','2026-10-27T10:00:00Z',1) RETURNING call_session_seq",
         )
       ).rows[0].call_session_seq;
       let pending;
       try {
         pending = fetchSide(side, 'PUT', personal, gatedInput, { key: endedKey, call }, endedId);
         for (let n = 0; ; n++) {
           if ((await providerRequests(side, endedKey)).length) break;
           assert.ok(n < 150);
           await delay(10);
         }
         await side.calls.query(
           "UPDATE call_sessions SET started_at='2026-10-27T10:00:01Z',ended_at='2026-10-27T10:01:00Z' WHERE call_session_seq=$1",
           [call],
         );
         await release(side, endedKey);
         const result = await pending;
         assert.equal(result.status, 200);
         endedResults.push(result);
       } finally {
         await release(side, endedKey);
         await pending?.catch(() => {});
       }
     }
     assert.deepEqual(endedResults[1], endedResults[0]);
     await compare('call may end after committed registration preparation');
     count++;
     const histories = [];
     for (const side of sides) {
       const rows = await providerRequests(side);
       const cards = (
         await side.db.query('SELECT registration_key,provider_customer_key FROM payment_cards')
       ).rows;
       const aliases = new Map(
         cards.map((row) => [row.registration_key, row.provider_customer_key]),
       );
       for (const row of rows) assert.equal(row.body.customerKey, aliases.get(row.registrationKey));
       histories.push(rows.map(row => ({
         ...row,
         body: { ...row.body, customerKey: '<verified-provider-customer-key>' },
       })));
     }
     assert.deepEqual(histories[1], histories[0], 'provider request history');
     for (const db of [customer, calls])
       assert.equal(
         (
           await db.query(
             "SELECT count(*)::int n FROM inbox_events WHERE event_type IN ('PaymentCardCallScopeRequested','PaymentCardCallerRead')",
           )
         ).rows[0].n,
         0,
       );
     console.log(
       JSON.stringify({
         cardRegistrationPairs: count - beforeCount,
         providerRepliesVerified: true,
         hmacAndAesGcmVerified: true,
         sameKeyRace: true,
         unknownAndAuditRecovery: true,
         callEndsDuringProvider: true,
       }),
     );
   },
 );

 const address={name:' 수령인 ',phoneNumber:'021234567',roadAddress:' 서울 도로 ',jibunAddress:' 서울 지번 ',detailAddress:' 1층 ',dongName:' 역삼동 ',postalCode:'01234'};
 const own={roadAddress:'현재 도로',jibunAddress:'현재 지번',dongName:'현재동',postalCode:'01234'};
 await request('PATCH','/api/customers/1',{name:' 이름 수정 '},204);
 for(const input of [{},{phoneNumber:'01000000000'},{name:null},{status:null},{address:{}},{address:{...own,latitude:37}},{monthlyBillingEnabled:true}])
  await request('PATCH','/api/customers/1',input,input.monthlyBillingEnabled?403:400,'status' in input?{admin:'root'}:{});
 await request('PATCH','/api/customers/1',{status:'WITHDRAWN'},403);
 for(const call of [undefined,'abc','0','2147483648'])await request('PATCH','/api/customers/1',{address:own},400,{call});
 for(const[call,status]of [[1,204],[6,204],[2,409],[3,403],[4,404],[5,404],[7,403],[8,403],[99999,404]])
  await request('PATCH','/api/customers/1',{address:own},status,{call});
 await request('PATCH','/api/customers/1',{address:null},204,{call:1});
 for(const admin of ['root','operator','supervisor'])await request('PATCH','/api/customers/1',{address:own,monthlyBillingEnabled:true},204,{admin,call:'invalid'});
 await request('PATCH','/api/customers/3',{status:'ACTIVE'},409,{admin:'operator'});
 await request('PATCH','/api/customers/3',{name:'숨김'},404);
 await request('PATCH','/api/customers/4',{name:'숨김'},404,{admin:'root'});
 await request('PATCH','/api/customers/1',{name:'오류'},403,{cookie:'dva_session=bad'});
 await request('PATCH','/api/customers/1',{name:'오류'},401,{cookie:'dva_session=bad',origin});
 const pin=(await request('POST','/api/customers/1/pins',{label:' 집 ',addressData:address},201,{call:1})).data.personalPinSeq;
 await request('GET','/api/customers/1/pins',undefined,200,{call:1});
 await request('GET','/api/customers/1/pins?limit=1&offset=99',undefined,200,{call:1});
 await request('PATCH','/api/pins/'+pin,{label:null,expectedVersion:1},200,{call:2});
 await request('PATCH','/api/pins/'+pin,{addressData:{...address,detailAddress:'102호'},expectedVersion:1},200,{call:2});
 await request('PATCH','/api/pins/'+pin,{label:'동일 상태'},200,{call:1});
 await request('PATCH','/api/pins/'+pin,{label:'동일 상태'},200,{call:1});
 const second=(await request('POST','/api/customers/1/pins',{label:'또 다른 집',addressData:{...address,detailAddress:'103호'}},201,{call:2})).data.personalPinSeq;
 await request('POST','/api/customers/1/pins',{label:'별칭 무시',addressData:{...address,detailAddress:'  103호  '}},409,{call:1});
 await request('PATCH','/api/pins/'+second,{label:'롤백 대상',addressData:{...address,detailAddress:'102호'}},409,{call:1});
 for(const call of [undefined,0,'abc','2147483648'])await request('GET','/api/customers/1/pins',undefined,400,{call});
 for(const[call,status]of [[2,409],[3,403],[4,404],[5,404],[7,403],[8,403],[99999,404]]){
  await request('GET','/api/customers/1/pins',undefined,status,{call});
  if(call!==2)await request('PATCH','/api/pins/'+pin,{label:'거절'},status,{call});
 }
 for(const admin of ['root','operator','supervisor']){
  await request('GET','/api/customers/1/pins',undefined,200,{admin,call:'invalid'});
  await request('PATCH','/api/pins/'+pin,{label:admin},200,{admin});
 }
 for(const input of [{},{expectedVersion:1},{label:3},{addressData:null},{addressData:{...address,phoneNumber:'0101'}},{addressData:{...address,phoneNumber:'11999999999'}},{addressData:{...address,postalCode:'12345\n'}},{addressData:{...address,latitude:37}},{customerSeq:2,label:'x'}])
  await request('PATCH','/api/pins/'+pin,input,400,{call:1});
 await request('PATCH','/api/pins/99999',{label:'x'},404);
 await request('PATCH','/api/pins/99999',{},400);
 await request('POST','/api/customers/3/pins',{addressData:address},403,{call:1});
 await request('POST','/api/customers/3/pins',{addressData:address},409,{admin:'root'});
 await request('GET','/api/customers/4/pins',undefined,404,{admin:'root'});
 await request('POST','/api/customers/1/pins',{addressData:{...address,detailAddress:'104호'}},403,{cookie:'dva_session=bad'});
 await request('POST','/api/customers/1/pins',{addressData:{...address,detailAddress:'104호'}},401,{cookie:'dva_session=bad',origin});
 for(const path of ['/api/customers/1/pins?q=%25_','/api/customers/1/pins?q='+encodeURIComponent('103호'),'/api/customers/1/pins?limit=1','/api/customers/1/pins?limit=1&offset=1','/api/customers/1/pins?limit=0','/api/customers/1/pins?unknown=1'])
  await request('GET',path,undefined,path.includes('limit=0')||path.includes('unknown')?400:200,{call:1});
 for(const side of sides)await side.db.query('UPDATE personal_pins SET deleted_at=$2 WHERE personal_pin_seq=$1',[second,'2026-10-28Z']);
 await request('GET','/api/customers/1/pins',undefined,200,{call:1});
 await request('PATCH','/api/pins/'+second,{label:'삭제됨'},404,{call:1});
 await request('POST','/api/customers/1/pins',{addressData:{...address,detailAddress:'103호'}},201,{call:2});
 await request('POST','/api/customers/1/pins',{},400,{call:1});
 await request('POST','/api/customers/1/pins',{label:'Cafe\u0301 100%_',addressData:{...address,detailAddress:'같은 키 첫 주소',phoneNumber:'07011999999'}},201,{call:2,key:'ignored-key'});
 await request('POST','/api/customers/1/pins',{addressData:{...address,detailAddress:'같은 키 둘째 주소'}},201,{call:2,key:'ignored-key'});
 await request('POST','/api/customers/1/pins',{addressData:{...address,detailAddress:'같은 키 둘째 주소'}},409,{call:2,key:'another-key'});
 await request('GET','/api/customers/1/pins?q='+encodeURIComponent('café'),undefined,200,{call:1});
 await request('GET','/api/customers/1/pins?q=%25_',undefined,200,{call:1});
 await request('POST','/api/customers/1/pins',{addressData:{...address,detailAddress:'x'.repeat(100500)}},201,{call:2});
 await request('PATCH','/api/customers/1','{',400,{raw:true});
 await request('PATCH','/api/customers/1',JSON.stringify({name:'x'.repeat(103000)}),413,{raw:true});
 await request('PATCH','/api/customers/1/',{name:'후행 슬래시'},204);
 await request('PATCH','/api/customers/1',{name:'거절'},403,{admin:'operator',origin:'https://invalid.example'});
 await request('GET','/api/pins/'+pin,undefined,404,{admin:'root'});
 await request('GET','/api/companies/1/pins',undefined,404,{admin:'root'});
 for(const side of sides)await side.db.query("UPDATE customers SET deleted_at='2026-10-28Z' WHERE customer_seq=2;INSERT INTO customers(name,phone_number,status) VALUES('번호 재사용 고객','01091110002','ACTIVE')");
 await request('POST','/api/customers/5/pins',{addressData:address},403,{call:3});
 await request('PATCH','/api/customers/5',{address:own},403,{call:3});
 // Hold the first success audit so the second create reaches the same uncommitted unique address.
 const createId=randomUUID(),duplicateId=randomUUID(),duplicateResults=[];
 for(const side of sides){const gate=await side.identity.connect();let first,second;try{
  await gate.query('SELECT pg_advisory_lock(20261107,160)');const gatePid=(await gate.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  await side.identity.query(`CREATE FUNCTION pins_test_create_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.request_id='${createId}'::uuid AND NEW.result='SUCCESS' THEN PERFORM pg_advisory_xact_lock(20261107,160); END IF; RETURN NEW; END $$;
   CREATE TRIGGER pins_test_create BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION pins_test_create_gate()`);
  const input={addressData:{...address,detailAddress:'동시 중복 주소'}};
  first=fetchSide(side,'POST','/api/customers/1/pins',input,{call:2},createId);
  let prepared=false;for(let n=0;n<150;n++){prepared=(await side.identity.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) waiting',[gatePid])).rows[0].waiting;if(prepared)break;await delay(10);}assert.equal(prepared,true);
  second=fetchSide(side,'POST','/api/customers/1/pins',input,{call:2},duplicateId);
  let duplicate=false;for(let n=0;n<150;n++){duplicate=(await side.db.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'INSERT INTO personal_pins(customer_seq,%') waiting")).rows[0].waiting;if(duplicate)break;await delay(10);}assert.equal(duplicate,true,'duplicate INSERT waits for the real unique key');
  await gate.query('SELECT pg_advisory_unlock(20261107,160)');const result=await Promise.all([first,second]);assert.deepEqual(result.map(r=>r.status),[201,409]);duplicateResults.push(result);
 }finally{await gate.query('SELECT pg_advisory_unlock(20261107,160)');gate.release();await first?.catch(()=>{});await second?.catch(()=>{});await side.identity.query('DROP TRIGGER IF EXISTS pins_test_create ON audit_logs;DROP FUNCTION IF EXISTS pins_test_create_gate()');}}
 assert.deepEqual(duplicateResults[1],duplicateResults[0]);await compare('concurrent unique address');count+=2;
 // A genuine audit INSERT failure must roll back fields and version on both sides.
 for(const side of sides)await side.identity.query(`CREATE FUNCTION pins_test_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.result='SUCCESS' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END $$;
  CREATE TRIGGER pins_test_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION pins_test_fail_audit()`);
 try{await request('PATCH','/api/pins/'+pin,{label:'감사 실패'},500,{call:1});await request('PATCH','/api/customers/1',{address:null,name:'감사 실패'},500,{call:1});}
 finally{for(const side of sides)await side.identity.query('DROP TRIGGER pins_test_audit ON audit_logs;DROP FUNCTION pins_test_fail_audit()');}
 await request('PATCH','/api/pins/'+pin,{label:'감사 복구'},200,{call:1});
 // Queue both partial updates on a real row lock so their audit order is deterministic across sides.
 const labelId=randomUUID(),addressId=randomUUID();
 for(const side of sides){const gate=await side.db.connect();let first,second;try{
  await gate.query('BEGIN');await gate.query('SELECT 1 FROM personal_pins WHERE personal_pin_seq=$1 FOR UPDATE',[pin]);
  first=fetchSide(side,'PATCH','/api/pins/'+pin,{label:'동시 별칭'},{call:2},labelId);
  async function queued(n){for(let attempt=0;attempt<150;attempt++){
   const count=(await side.db.query("SELECT count(*)::int n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'UPDATE personal_pins SET label=%'" )).rows[0].n;
   if(count>=n)return;await delay(10);
  }assert.fail('partial mutation did not queue');}
  await queued(1);second=fetchSide(side,'PATCH','/api/pins/'+pin,{addressData:{...address,detailAddress:'동시 전체 주소'}},{call:2},addressId);await queued(2);
  await gate.query('COMMIT');assert.equal((await first).status,200);assert.equal((await second).status,200);
 }finally{await gate.query('ROLLBACK');gate.release();await first?.catch(()=>{});await second?.catch(()=>{});}}
 await compare('concurrent partial updates');count+=2;
 // A write queued behind call termination must re-read the ended state before changing its customer.
 const conflictId=randomUUID();
 for(const side of sides){const lock=await side.calls.connect();let pending;try{
  await lock.query('BEGIN');const pid=(await lock.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  await lock.query('SELECT 1 FROM call_sessions WHERE call_session_seq=1 FOR UPDATE');
  pending=fetchSide(side,'PATCH','/api/customers/1',{address:null,name:'저장 금지'},{call:1},conflictId);
  let blocked=false;for(let n=0;n<150;n++){blocked=(await side.calls.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) blocked',[pid])).rows[0].blocked;if(blocked)break;await delay(10);}assert.equal(blocked,true,'call lock before customer mutation');
  await lock.query("UPDATE call_sessions SET started_at='2026-10-27T01:00:01Z',ended_at='2026-10-27T01:01:01Z' WHERE call_session_seq=1");await lock.query('COMMIT');assert.equal((await pending).status,409);
 }finally{await lock.query('ROLLBACK');lock.release();await pending?.catch(()=>{});}}
 await compare('call termination wins');
 // PIN writes keep a SHARE lock until the customer transaction and audit finish.
 const lockRequest=randomUUID();
 for(const side of sides){const gate=await side.db.connect(),ending=await side.calls.connect();let mutation,termination;try{
  await gate.query('BEGIN');const gatePid=(await gate.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  await gate.query('SELECT 1 FROM personal_pins WHERE personal_pin_seq=$1 FOR UPDATE',[pin]);
  mutation=fetchSide(side,'PATCH','/api/pins/'+pin,{label:'잠금 유지'},{call:6},lockRequest);
  let blocked=false;for(let n=0;n<150;n++){blocked=(await side.db.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) blocked',[gatePid])).rows[0].blocked;if(blocked)break;await delay(10);}assert.equal(blocked,true);
  await ending.query('BEGIN');const endingPid=(await ending.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  termination=ending.query("UPDATE call_sessions SET started_at='2026-10-27T07:00:00Z',ended_at='2026-10-27T07:01:00Z' WHERE call_session_seq=6");
  let held=false;for(let n=0;n<150;n++){held=(await side.calls.query('SELECT cardinality(pg_blocking_pids($1))>0 held',[endingPid])).rows[0].held;if(held)break;await delay(10);}assert.equal(held,true,'call SHARE lock survives cross-service write');
  await gate.query('COMMIT');assert.equal((await mutation).status,200);await termination;await ending.query('COMMIT');
 }finally{await gate.query('ROLLBACK');gate.release();await ending.query('ROLLBACK');ending.release();await mutation?.catch(()=>{});await termination?.catch(()=>{});}}
 await compare('PIN write keeps its call lock');
 for(const side of sides)await side.identity.query('DELETE FROM admin_sessions WHERE admin_user_seq=2');
 await request('GET','/api/customers/1/pins',undefined,401,{admin:'operator',call:2});
 await request('PATCH','/api/pins/'+pin,{label:'회수된 관리자'},401,{admin:'operator',call:2});
 console.log(JSON.stringify({identicalRequests:count,openApiOperations:10,referencedSchemas:refs.size,callLockRaces:2,fullBusinessRows:true}));

 await t.test('internal writes replay once without storing private input, reject mutation and isolate service tokens',async()=>{
  const event={eventId:randomUUID(),source:'customer',eventType:'CallScopedCustomerRequested',payload:{command:{operation:'PersonalPinUpdated',id:pin,callSessionSeq:2,input:{label:'내부 재수신'},requestId:randomUUID()}}};
  const post=(input=event,token=process.env.CUSTOMER_AUTH_TOKEN)=>fetch('http://consultation-app:3004/internal/call-scope',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(input)});
  const before=(await customer.query('SELECT version FROM personal_pins WHERE personal_pin_seq=$1',[pin])).rows[0].version;
  // Consume the real committed response and discard it, then retry the same internal event.
  const first=await post();assert.equal(first.status,200);const committed=await first.json();
  const repeated=await post();assert.equal(repeated.status,200);assert.deepEqual(await repeated.json(),committed);
  assert.equal((await customer.query('SELECT version FROM personal_pins WHERE personal_pin_seq=$1',[pin])).rows[0].version,before+1);
  assert.equal((await operations.query('SELECT count(*)::int n FROM audit_logs WHERE request_id=$1',[event.payload.command.requestId])).rows[0].n,1);
  const receipt=(await customer.query('SELECT payload FROM inbox_events WHERE event_id=$1',[event.eventId])).rows[0].payload;
  assert.deepEqual(Object.keys(receipt).sort(),['requestHash','result']);assert.match(receipt.requestHash,/^[a-f0-9]{64}$/);assert.ok(!JSON.stringify(receipt).includes('내부 재수신'));
  const changed=structuredClone(event);changed.payload.command.input.label='변조';assert.equal((await post(changed)).status,409);
  assert.equal((await post(event,process.env.CONSULTATION_AUTH_TOKEN)).status,403);
  assert.equal((await post({...event,source:'operations'})).status,422);
  assert.equal((await post({...event,payload:{...event.payload,actorId:1}})).status,422);
  const callback=await fetch('http://customer-app:3001/internal/call-scope',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+process.env.CUSTOMER_AUTH_TOKEN},body:JSON.stringify(event)});assert.equal(callback.status,403);
  const pages=await fetch('http://customer-app:3001/api/docs-json').then(r=>r.json());assert.equal(pages.paths['/internal/call-scope'],undefined);
 });

 await t.test('read events return a fresh page without persisting private snapshots',async()=>{
  const call=(await calls.query("INSERT INTO call_sessions(provider_call_id,caller_phone_number,incoming_at,customer_seq) VALUES('pin-read-event','01091110001','2026-10-27T08:00:00Z',1) RETURNING call_session_seq")).rows[0].call_session_seq;
  const event={eventId:randomUUID(),source:'customer',eventType:'CallScopedCustomerRequested',payload:{command:{operation:'PersonalPinsListed',id:1,callSessionSeq:call,input:{limit:100,offset:0},requestId:randomUUID()}}};
  const send=async()=>{const response=await fetch('http://consultation-app:3004/internal/call-scope',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+process.env.CUSTOMER_AUTH_TOKEN},body:JSON.stringify(event)});assert.equal(response.status,200);return(await response.json()).payload;};
  const before=await send();await customer.query('UPDATE personal_pins SET label=$2 WHERE personal_pin_seq=$1',[pin,'읽을 때 최신 상태']);
  const after=await send();assert.notDeepEqual(after,before);assert.equal(after.data.find(row=>row.personalPinSeq===pin).label,'읽을 때 최신 상태');
  assert.equal((await customer.query('SELECT count(*)::int n FROM inbox_events WHERE event_id=$1',[event.eventId])).rows[0].n,0);
  assert.equal((await calls.query('SELECT count(*)::int n FROM inbox_events WHERE event_id=$1',[event.eventId])).rows[0].n,0);
 });

 await t.test('SIGKILL rolls back PIN and command receipt, aborts orphan audit, then permits a single retry',async()=>{
  const {spawn}=require('node:child_process'),{once}=require('node:events');
  const command={operation:'PersonalPinUpdated',id:pin,callSessionSeq:2,input:{label:'종료 복구'},requestId:randomUUID()};
  const event={eventId:randomUUID(),source:'consultation',eventType:'CallScopedCustomerRequested',payload:{command,caller:{phone:'01091110001',customerSeq:1,endedAt:'2026-10-27T02:01:01.000Z'}}};
  const before=(await customer.query('SELECT label,version FROM personal_pins WHERE personal_pin_seq=$1',[pin])).rows[0];
  const child=spawn(process.execPath,['test/pin-scope-claimant.cjs'],{env:{...process.env,PIN_CRASH_EVENT:JSON.stringify(event)},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',chunk=>{output+=chunk.toString();});
  try{
   for(let n=0;!output.includes('prepared');n++){assert.ok(n<250&&child.exitCode===null,'PIN producer did not prepare');await delay(20);}
   assert.equal((await operations.query("SELECT count(*)::int n FROM customer_audit_preparations WHERE audit->>'request_id'=$1 AND NOT aborted",[command.requestId])).rows[0].n,1);
   assert.equal((await customer.query('SELECT count(*)::int n FROM inbox_events WHERE event_id=$1',[event.eventId])).rows[0].n,0);
   assert.deepEqual((await customer.query('SELECT label,version FROM personal_pins WHERE personal_pin_seq=$1',[pin])).rows[0],before);
   const exited=once(child,'exit');child.kill('SIGKILL');await exited;
   for(let attempt=0;;attempt++){
    const read=await fetch(sides[1].auth+'/api/audit-logs?limit=100',{headers:{Cookie:sides[1].cookies.root}});assert.equal(read.status,200);await read.json();
    if(!(await operations.query("SELECT 1 FROM customer_audit_preparations WHERE audit->>'request_id'=$1 AND NOT aborted",[command.requestId])).rowCount)break;
    assert.ok(attempt<80);await delay(25);
   }
   assert.equal((await customer.query('SELECT count(*)::int n FROM inbox_events WHERE event_id=$1',[event.eventId])).rows[0].n,0);
   assert.deepEqual((await customer.query('SELECT label,version FROM personal_pins WHERE personal_pin_seq=$1',[pin])).rows[0],before);
   assert.equal((await operations.query('SELECT count(*)::int n FROM audit_logs WHERE request_id=$1',[command.requestId])).rows[0].n,0);
   for(let attempt=0;attempt<2;attempt++){
    const response=await fetch('http://consultation-app:3004/internal/call-scope',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+process.env.CUSTOMER_AUTH_TOKEN},body:JSON.stringify({...event,source:'customer',payload:{command}})});assert.equal(response.status,200);await response.json();
   }
   assert.deepEqual((await customer.query('SELECT label,version FROM personal_pins WHERE personal_pin_seq=$1',[pin])).rows[0],{label:'종료 복구',version:before.version+1});
   assert.equal((await operations.query('SELECT count(*)::int n FROM audit_logs WHERE request_id=$1',[command.requestId])).rows[0].n,1);
  }finally{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}}
 });
});
