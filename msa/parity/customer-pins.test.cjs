const { truncateFixture } = require('./fixture-reset.cjs');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
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
   ('root','개발 운영자',$1,'SYSTEM_ADMIN','ACTIVE','2026-01-01Z'),('operator','상담 운영자',$1,'OPERATOR','ACTIVE','2026-01-01Z'),('supervisor','관리 운영자',$1,'SUPERVISOR','ACTIVE','2026-01-01Z')`,[hash]);
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
 const normalize=(value,key)=>{
  if(value instanceof Date){if(['occurred_at','last_login_at'].includes(key)){assert.ok(value.getTime()>=started-1000&&value.getTime()<=Date.now()+1000);return'<generated-time>';}return value.toISOString();}
  if(Array.isArray(value))return value.map(item=>normalize(item,key));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([name,item])=>[name,normalize(item,name)]));return value;
 };
 const tables=[
  'SELECT customer_seq,name,phone_number,status,monthly_billing_enabled,address_data,deleted_at,anonymized_at FROM customers ORDER BY customer_seq',
  'SELECT organization_seq,name,status,monthly_billing_enabled,created_at,deleted_at FROM organizations ORDER BY organization_seq',
  'SELECT department_seq,organization_seq,name,group_billing_enabled,created_at,deleted_at FROM departments ORDER BY department_seq',
  'SELECT membership_seq,customer_seq,organization_seq,department_seq,employee_no,role,status,deleted_at FROM memberships ORDER BY membership_seq',
  'SELECT personal_pin_seq,customer_seq,label,address_data,search_text,version,deleted_at FROM personal_pins ORDER BY personal_pin_seq'];
 const callSQL='SELECT call_session_seq,provider_call_id,caller_phone_number,incoming_at,started_at,ended_at,deleted_at,customer_seq,order_seq FROM call_sessions ORDER BY call_session_seq';
 const auditSQL='SELECT audit_log_seq,actor_type,actor_seq,actor_name,action,target_type,target_seq,target_admin_name,request_id,result,metadata,occurred_at FROM audit_logs ORDER BY audit_log_seq';
 async function compare(label){
  for(const sql of tables)assert.deepEqual(normalize((await customer.query(sql)).rows),normalize((await mono.query(sql)).rows),label+' '+sql);
  assert.deepEqual(normalize((await calls.query(callSQL)).rows),normalize((await mono.query(callSQL)).rows),label+' calls');
  assert.deepEqual(normalize((await operations.query(auditSQL)).rows),normalize((await mono.query(auditSQL)).rows),label+' all audit');
  assert.equal((await operations.query('SELECT count(*)::int n FROM customer_audit_preparations WHERE NOT aborted')).rows[0].n,0,label+' unconfirmed audit');
 }
 let count=0;
 async function fetchSide(side,method,path,body,options={},requestId=randomUUID()){
  const endpoint=/^\/api\/(auth|audit-logs)(\/|\?|$)/.test(path)?side.auth:side.base;
  const response=await fetch(endpoint+path,{method,redirect:'error',signal:AbortSignal.timeout(28000),headers:{'X-Request-Id':requestId,...(/^\/api\/(?:customers|pins)(?:\/|$)/.test(path)?{Authorization:'Bearer '+process.env.AI_BUSINESS_TOKEN}:{}),
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
 const paths={'/api/customers/{id}':['patch'],'/api/customers/{id}/pins':['get','post'],'/api/pins/{id}':['patch']};
 const refs=new Set(),visit=value=>{if(Array.isArray(value)){value.forEach(visit);return;}if(value&&typeof value==='object')for(const[k,v]of Object.entries(value)){if(k==='$ref'&&typeof v==='string')refs.add(v.split('/').pop());else visit(v);}};
 for(const[path,methods]of Object.entries(paths))for(const method of methods){assert.deepEqual(schemas[1].paths[path][method],schemas[0].paths[path][method]);visit(schemas[0].paths[path][method]);}
 for(const name of refs){assert.deepEqual(schemas[1].components.schemas[name],schemas[0].components.schemas[name],name);visit(schemas[0].components.schemas[name]);}
 assert.equal(schemas[1].paths['/internal/call-scope'],undefined);
 const address={name:' 수령인 ',phoneNumber:'01091119999',roadAddress:' 서울 도로 ',jibunAddress:' 서울 지번 ',detailAddress:' 1층 ',dongName:' 역삼동 ',postalCode:'01234'};
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
 for(const input of [{},{expectedVersion:1},{label:3},{addressData:null},{addressData:{...address,phoneNumber:'0101'}},{addressData:{...address,postalCode:'12345\n'}},{addressData:{...address,latitude:37}},{customerSeq:2,label:'x'}])
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
 await request('POST','/api/customers/1/pins',{label:'Cafe\u0301 100%_',addressData:{...address,detailAddress:'같은 키 첫 주소',phoneNumber:'11999999999'}},201,{call:2,key:'ignored-key'});
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
 console.log(JSON.stringify({identicalRequests:count,openApiOperations:4,referencedSchemas:refs.size,callLockRaces:2,fullBusinessRows:true}));

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
