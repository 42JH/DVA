const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {Pool}=require('pg');
const {hashPassword}=require('./seed-password.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('customer context and call registration preserve HTTP, independent business DBs, PBX and visible audit',async t=>{
 assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.PGDATABASE,'dva_webhook_test');
 const start=Date.now(),origin='http://localhost:5173',password='context-test-only-password';
 const mono=new Pool({host:'monolith-db',user:'monolith_app'}),customer=new Pool({host:'customer-db',user:'customer_app'}),consultation=new Pool({host:'consultation-db',user:'consultation_app'}),operations=new Pool({host:'operations-db',user:'operations_app'});
 t.after(async()=>{await Promise.all([mono.end(),customer.end(),consultation.end(),operations.end()]);});
 const sides=[{base:'http://monolith-app:3000',auth:'http://monolith-app:3000',pbx:'http://monolith-app:3000',db:mono,calls:mono,identity:mono},
  {base:'http://customer-app:3001',auth:'http://operations-app:3005',pbx:'http://consultation-app:3004',db:customer,calls:consultation,identity:operations}];
 for(const side of sides)for(let n=0;;n++){try{if((await fetch(side.base+'/api/docs-json')).ok)break;}catch{}assert.ok(n<80,'context app unavailable');await delay(250);}
 const hash=await hashPassword(password);
 for(const side of sides){
  await side.calls.query('TRUNCATE pbx_webhooks.call_ended_events,recordings,call_utterances,call_sessions RESTART IDENTITY CASCADE');
  await side.db.query('TRUNCATE customers,organizations,departments,memberships,company_pins,personal_pins RESTART IDENTITY CASCADE');
  await side.identity.query('TRUNCATE admin_users,audit_logs RESTART IDENTITY CASCADE');
  if(side===sides[1]){await operations.query('TRUNCATE customer_audit_preparations,consultation_audit_preparations,inbox_events,outbox_events RESTART IDENTITY');await consultation.query('TRUNCATE inbox_events,outbox_events RESTART IDENTITY');}
  await side.identity.query("INSERT INTO admin_users(login_id,name,password_hash,role,status,created_at) VALUES('operator','고객 확인 운영자',$1,'OPERATOR','ACTIVE','2026-01-01Z')",[hash]);
  await side.db.query(`INSERT INTO customers(name,phone_number,status,monthly_billing_enabled,address_data) VALUES
   ('현재 고객','01098880001','ACTIVE',true,'{"roadAddress":"현재 도로","jibunAddress":"현재 지번","dongName":"현재동","postalCode":"01234"}'),
   ('소속 고객','01098880002','ACTIVE',false,NULL),('탈퇴 고객','01098880003','WITHDRAWN',false,NULL),('숨김 고객','01098880004','ACTIVE',false,NULL);
   UPDATE customers SET deleted_at='2026-01-01Z' WHERE customer_seq=4;
   INSERT INTO organizations(name,status,monthly_billing_enabled,created_at) VALUES('활성 기업','ACTIVE',true,'2026-01-01Z'),('비활성 기업','INACTIVE',false,'2026-01-01Z');
   INSERT INTO departments(organization_seq,name,group_billing_enabled,created_at) VALUES(1,'부서',true,'2026-01-01Z');
   INSERT INTO memberships(customer_seq,organization_seq,department_seq,employee_no,role,status) VALUES(2,1,1,'0002','MEMBER','ACTIVE');
   INSERT INTO personal_pins(customer_seq,label,address_data,version)
    SELECT 1,CASE WHEN n%2=0 THEN NULL ELSE '개인 주소' END,jsonb_build_object('name','수령인','phoneNumber','01000000001','roadAddress','이전 도로','jibunAddress','이전 지번','dongName','이전동','postalCode','01234','detailAddress',n::text),n
    FROM generate_series(1,121) n;
   INSERT INTO personal_pins(customer_seq,label,address_data,version) VALUES(2,'타인 비공개','{"name":"다른 수령인","phoneNumber":"01000000002","roadAddress":"다른 도로","jibunAddress":"다른 지번","dongName":"다른동","postalCode":"01234"}',1);
   INSERT INTO personal_pins(customer_seq,label,address_data,version,deleted_at) VALUES(1,'삭제한 주소','{"name":"수령인","phoneNumber":"01000000001","roadAddress":"삭제 도로","jibunAddress":"삭제 지번","dongName":"삭제동","postalCode":"01234"}',7,'2026-01-01Z');`);
  await side.calls.query(`INSERT INTO call_sessions(provider_call_id,caller_phone_number,incoming_at,registered_at,deleted_at,customer_seq) VALUES
   ('legacy','01098880001',NULL,NULL,NULL,NULL),('deleted','01098880001','2026-10-27T01:00:00Z',NULL,'2026-10-28Z',NULL),
   ('expired','01098880001','2020-01-01Z',NULL,NULL,NULL)`);
 }
 const normalize=(v,key)=>{
  if(typeof v==='string'&&['occurredAt','observedAt'].includes(key)){const at=Date.parse(v);assert.ok(Number.isFinite(at)&&at>=start-1000&&at<=Date.now()+1000);return'<generated-time>';}
  if(v instanceof Date){assert.ok(Number.isFinite(v.getTime()));if(['registered_at','received_at','occurred_at'].includes(key)){assert.ok(v.getTime()>=start-1000&&v.getTime()<=Date.now()+1000);return'<generated-time>';}return v.toISOString();}
  if(Array.isArray(v))return v.map(item=>normalize(item,key));
  if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,normalize(x,k)]));return v;
 };
 const customerSQL=[
  'SELECT customer_seq,name,phone_number,status,monthly_billing_enabled,address_data,deleted_at,anonymized_at FROM customers ORDER BY customer_seq',
  'SELECT organization_seq,name,status,monthly_billing_enabled,created_at,deleted_at FROM organizations ORDER BY organization_seq',
  'SELECT department_seq,organization_seq,name,group_billing_enabled,created_at,deleted_at FROM departments ORDER BY department_seq',
  'SELECT membership_seq,customer_seq,organization_seq,department_seq,employee_no,role,status,deleted_at FROM memberships ORDER BY membership_seq',
  'SELECT company_pin_seq,organization_seq,department_seq,department_name,label,address_data,version,deleted_at FROM company_pins ORDER BY company_pin_seq',
  'SELECT personal_pin_seq,customer_seq,label,address_data,version,deleted_at FROM personal_pins ORDER BY personal_pin_seq'];
 const callsSQL=['SELECT call_session_seq,provider_call_id,caller_phone_number,incoming_at,registered_at,started_at,ended_at,deleted_at,customer_seq,order_seq FROM call_sessions ORDER BY call_session_seq',
  'SELECT recording_id,payload,received_at,processing_status,call_session_seq FROM pbx_webhooks.call_ended_events ORDER BY recording_id',
  'SELECT recording_seq,call_session_seq,object_key FROM recordings ORDER BY recording_seq'];
 const auditSQL='SELECT audit_log_seq,actor_type,actor_seq,actor_name,action,target_type,target_seq,target_admin_name,request_id,result,metadata,occurred_at FROM audit_logs ORDER BY audit_log_seq';
 let pinTable='personal_pins';
 async function compare(label){
  for(const statement of customerSQL){const sql=statement.replace('FROM personal_pins','FROM '+pinTable);assert.deepEqual(normalize((await customer.query(sql)).rows),normalize((await mono.query(sql)).rows),label+' customer');}
  for(const sql of callsSQL)assert.deepEqual(normalize((await consultation.query(sql)).rows),normalize((await mono.query(sql)).rows),label+' '+sql);
  assert.deepEqual(normalize((await operations.query(auditSQL)).rows),normalize((await mono.query(auditSQL)).rows),label+' all audit');
 }
 let count=0;
 async function request(method,path,body,status,options={}){
  const requestId=randomUUID(),results=[];
  for(const side of sides){
   const base=path.startsWith('/api/auth/')||path.startsWith('/api/audit-logs')?side.auth:path.startsWith('/webhooks/')||path.startsWith('/api/calls/')?side.pbx:side.base;
   const response=await fetch(base+path,{method,redirect:'error',signal:AbortSignal.timeout(20000),headers:{'X-Request-Id':requestId,
    ...(options.noOrigin?{}:{Origin:options.origin??origin}),...(options.session?{Cookie:options.cookie??side.cookie}:{}),
    ...(options.pbx?{Authorization:'Bearer '+process.env.PBX_WEBHOOK_TOKEN}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
   const text=await response.text();assert.equal(response.status,status,side.base+' '+method+' '+path+' '+text.slice(0,900));
   assert.equal(response.headers.get('x-request-id'),requestId);
   if(path.startsWith('/api/'))assert.equal(response.headers.get('cache-control'),'no-store');
   const value=text?JSON.parse(text):null,cookie=response.headers.get('set-cookie');
   if(options.login){assert.match(cookie,/^dva_session=[a-f0-9]{64};/);side.cookie=cookie.split(';')[0];assert.ok(Math.abs(Date.parse(value.data.expiresAt)-Date.now()-9*3600_000)<15000);value.data.expiresAt='<nine-hours>';}
   results.push({value:normalize(value),cors:response.headers.get('access-control-allow-origin'),credentials:response.headers.get('access-control-allow-credentials'),cookie:cookie?.replace(/^dva_session=[^;]*/,'dva_session=<opaque>').replace(/Expires=[^;]+/,'Expires=<valid>')});
  }
  assert.deepEqual(results[1],results[0],method+' '+path);await compare(method+' '+path);count++;return results[0].value;
 }
 const ctx=(body,status=200,options={})=>request('POST','/api/customers/context',body,status,options);
 const call=(providerCallId,incomingAt='2026-10-27T01:00:00Z')=>({providerCallId,incomingAt});
 await request('POST','/api/auth/login',{loginId:'operator',password},200,{login:true});
 const streams=[];
 for(const side of sides){
  const abort=new AbortController();t.after(()=>abort.abort());
  const response=await fetch(side.pbx+'/api/calls/active-count/stream',{headers:{Cookie:side.cookie},signal:abort.signal});assert.equal(response.status,200);
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
  streams.push({close:()=>abort.abort(),async next(){for(;;){const end=buffer.indexOf('\n\n');if(end>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);if(!frame.includes('event: active-call-count'))continue;const text=frame.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim()).join('\n');return normalize(JSON.parse(text));}let timer;try{const chunk=await Promise.race([reader.read(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Registration SSE timeout')),10000);})]);assert.equal(chunk.done,false);buffer+=decoder.decode(chunk.value,{stream:true}).replaceAll('\r\n','\n');}finally{clearTimeout(timer);}}}});
 }
 async function streamCount(expected){const values=await Promise.all(streams.map(s=>s.next()));assert.deepEqual(values[1],values[0]);assert.equal(values[0].activeCallCount,expected);}
 await streamCount(0);
 const before=(await mono.query('SELECT count(*) FROM call_sessions')).rows;
 for(const phoneNumber of ['01000000000','01098880001','01098880002','01098880003','01098880004']){
  const result=await ctx({phoneNumber},200,{noOrigin:true});assert.equal(Object.hasOwn(result.data,'callSessionSeq'),false);
  if(phoneNumber==='01098880001'){assert.equal(result.data.personalPins.length,121);assert.equal(result.data.customer.address.roadAddress,'현재 도로');assert.equal(result.data.personalPins[0].addressData.roadAddress,'이전 도로');}
 }
 assert.deepEqual((await mono.query('SELECT count(*) FROM call_sessions')).rows,before);
 for(const membershipStatus of ['ACTIVE','INACTIVE'])for(const organizationStatus of ['ACTIVE','INACTIVE'])for(const role of ['MEMBER','ORG_ADMIN']){
  for(const side of sides){await side.db.query('UPDATE memberships SET status=$1,role=$2 WHERE membership_seq=1',[membershipStatus,role]);await side.db.query('UPDATE organizations SET status=$1 WHERE organization_seq=1',[organizationStatus]);}
  await ctx({phoneNumber:'01098880002'});
 }
 for(const body of [{phoneNumber:'021234567'},{phoneNumber:'0101234567'},{phoneNumber:'010123456789'},{phoneNumber:'00821098880001'}, {},{phoneNumber:123},{phoneNumber:null},{phoneNumber:'010-123'},{phoneNumber:' 010123'},{phoneNumber:'010123',extra:true},{phoneNumber:'010123',call:null},{phoneNumber:'010123',call:{}},{phoneNumber:'010123',call:call('bad','2026-02-30T01:00:00Z')},{phoneNumber:'010123',call:call('bad','2026-10-27T01:00:00')},{phoneNumber:'010123',call:call('bad id')},{phoneNumber:'010123',call:call('bad\0id')},{phoneNumber:'12',call:call('short-phone')}])await ctx(body,400);
 for(const providerCallId of ['deleted','expired'])await ctx({phoneNumber:'01098880001',call:call(providerCallId)},409);
 await ctx({phoneNumber:'01098880001',call:call('too-old','2020-01-01T00:00:00Z')},409);
 await ctx({phoneNumber:'01098889999',call:call('future','2030-01-01T00:00:00Z')});
 await streamCount(1);
 const registered=await ctx({phoneNumber:'01098880001',call:call('registered')});const id=registered.data.callSessionSeq;
 assert.equal(registered.data.customer.customerSeq,1);assert.equal((await mono.query('SELECT customer_seq,caller_phone_number FROM call_sessions WHERE call_session_seq=$1',[id])).rows[0].caller_phone_number,'01098880001');
 await streamCount(2);for(const stream of streams)stream.close();
 const active=await request('GET','/api/calls/active-count',undefined,200,{session:true});assert.equal(active.data.activeCallCount,2);
 await ctx({phoneNumber:'01098880001',call:call('registered')});await ctx({phoneNumber:'01098880001',call:call('registered')},200,{session:true});
 await ctx({phoneNumber:'01098880002',call:call('registered')},409);await ctx({phoneNumber:'01098880001',call:call('registered','2026-10-27T01:00:01Z')},409);
 await ctx({phoneNumber:'01098880003',call:call('withdrawn')});assert.equal((await consultation.query("SELECT customer_seq FROM call_sessions WHERE provider_call_id='withdrawn'")).rows[0].customer_seq,3);
 await ctx({phoneNumber:'01098880004',call:call('hidden')});await ctx({phoneNumber:'01098889999',call:call('unknown')});
 await ctx({phoneNumber:'01098880001'},401,{session:true,cookie:'dva_session=bad'});await ctx({phoneNumber:'01098880001'},403,{origin:'https://untrusted.invalid'});
 await request('POST','/api/customers/context/',{phoneNumber:'01098880001'},200);await request('GET','/api/customers/context',undefined,400,{session:true});
 for(const [body,status] of [['{',400],[JSON.stringify({phoneNumber:'0'.repeat(103000)}),413]]){
  const requestId=randomUUID(),values=[];
  for(const side of sides){const r=await fetch(side.base+'/api/customers/context',{method:'POST',headers:{'Content-Type':'application/json','X-Request-Id':requestId,Origin:origin},body});assert.equal(r.status,status);assert.equal(r.headers.get('x-request-id'),requestId);assert.equal(r.headers.get('cache-control'),'no-store');values.push(await r.json());}
  assert.deepEqual(values[1],values[0]);await compare('raw JSON rejection');count++;
 }
 const payload={recordingId:'before-call',callFrom:'01098885555',callTo:'0212345678',startedAt:'2026-10-27T02:00:00Z',endedAt:'2026-10-27T02:01:00Z',durationSeconds:60,recordingUrl:'https://recordings.example.test/audio.mp3'};
 await request('POST','/webhooks/pbx/call-ended',payload,200,{pbx:true});
 const ended=await ctx({phoneNumber:payload.callFrom,call:call('pbx-first',payload.startedAt)});
 assert.equal((await consultation.query('SELECT ended_at FROM call_sessions WHERE call_session_seq=$1',[ended.data.callSessionSeq])).rows[0].ended_at.toISOString(),payload.endedAt.replace('Z','.000Z'));
 await ctx({phoneNumber:payload.callFrom,call:call('pbx-first',payload.startedAt)});
 for(const side of sides)await side.db.query('ALTER TABLE personal_pins RENAME TO context_unavailable_pins');
 pinTable='context_unavailable_pins';
 await ctx({phoneNumber:'01098880001',call:call('query-failed')},503);
 for(const side of sides)await side.db.query('ALTER TABLE context_unavailable_pins RENAME TO personal_pins');
 pinTable='personal_pins';
 await ctx({phoneNumber:'01098880001',call:call('query-failed')});
 for(const side of sides)await side.identity.query("CREATE FUNCTION context_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='CALL_STARTED' THEN RAISE EXCEPTION 'private audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER context_reject BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION context_reject_audit();");
 await ctx({phoneNumber:'01098880001',call:call('audit-failed')},503);
 for(const side of sides)await side.identity.query('DROP TRIGGER context_reject ON audit_logs; DROP FUNCTION context_reject_audit()');
 await ctx({phoneNumber:'01098880001',call:call('audit-failed')});
 const concurrentIds=Array.from({length:10},()=>randomUUID());
 for(const side of sides){
  const gate=await side.identity.connect();
  try{
   await gate.query('SELECT pg_advisory_lock(916011,160)');
   await side.identity.query('CREATE FUNCTION context_audit_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(916011,160); RETURN NEW; END $$; CREATE TRIGGER context_audit_gate BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION context_audit_gate();');
   const attempt=i=>fetch(side.base+'/api/customers/context',{method:'POST',signal:AbortSignal.timeout(20000),headers:{'Content-Type':'application/json','X-Request-Id':concurrentIds[i]},body:JSON.stringify({phoneNumber:'01098880001',call:call('concurrent')})}).then(async r=>{assert.equal(r.status,200);return(await r.json()).data.callSessionSeq;});
   const first=attempt(0);
   for(let n=0;;n++){if((await side.identity.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND classid=916011 AND objid=160) AS waiting")).rows[0].waiting)break;assert.ok(n<100,'first creator did not reach audit gate');await delay(10);}
   // Fix the creator while the other requests contend, so its audit request ID is comparable.
   const other=Array.from({length:9},(_,i)=>attempt(i+1));
   for(let n=0;;n++){if(Number((await side.calls.query("SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND NOT granted")).rows[0].count)>=(side.calls===side.identity?2:1))break;assert.ok(n<100,'duplicate requests did not contend');await delay(10);}
   await gate.query('SELECT pg_advisory_unlock(916011,160)');
   const results=await Promise.all([first,...other]);assert.equal(new Set(results).size,1);
  }finally{
   await gate.query('SELECT pg_advisory_unlock(916011,160)');gate.release();
   await side.identity.query('DROP TRIGGER IF EXISTS context_audit_gate ON audit_logs; DROP FUNCTION IF EXISTS context_audit_gate()');
  }
 }
 await compare('ten concurrent registrations');
 await request('GET','/api/audit-logs?limit=100',undefined,403,{session:true});
 for(const side of sides)await side.identity.query("UPDATE admin_users SET role='SUPERVISOR' WHERE login_id='operator'");
 await request('GET','/api/audit-logs?limit=100',undefined,200,{session:true});
 const docs=[];for(const side of sides)docs.push(await(await fetch(side.base+'/api/docs-json')).json());
 assert.deepEqual(docs[1].paths['/api/customers/context'],docs[0].paths['/api/customers/context']);
 const visited=new Set();function schemas(value){if(!value||typeof value!=='object')return;if(value.$ref){const name=value.$ref.split('/').pop();if(!visited.has(name)){visited.add(name);assert.deepEqual(docs[1].components.schemas[name],docs[0].components.schemas[name],name);schemas(docs[0].components.schemas[name]);}}for(const child of Object.values(value))if(typeof child==='object')schemas(child);}
 schemas(docs[0].paths['/api/customers/context']);assert.ok(visited.size>5);
 await t.test('private registration receipts reject altered redelivery while queries read current snapshots',async()=>{
  const event={eventId:randomUUID(),source:'customer',eventType:'CallerContextRequested',payload:{input:{phoneNumber:'01098880001',call:call('registered')},actorId:null,requestId:randomUUID()}};
  async function privateCall(url,token,body){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(body)});return{status:r.status,value:await r.json()};}
  const url='http://consultation-app:3004/internal/caller-context',token=process.env.CUSTOMER_AUTH_TOKEN;
  assert.equal((await privateCall(url,'wrong',event)).status,403);
  const first=await privateCall(url,token,event);assert.equal(first.status,200);assert.equal(first.value.payload.callSessionSeq,id);
  assert.deepEqual(await privateCall(url,token,event),first);
  const conflict=await privateCall(url,token,{...event,payload:{...event.payload,input:{phoneNumber:'01098880002',call:call('registered')}}});assert.equal(conflict.status,409);assert.equal(conflict.value.code,'EVENT_PAYLOAD_CONFLICT');
  assert.equal((await consultation.query('SELECT count(*)::int AS n FROM inbox_events WHERE event_id=$1',[event.eventId])).rows[0].n,1);
  const query={eventId:randomUUID(),source:'consultation',eventType:'CallerContextRequested',payload:{phoneNumber:'01098880001'}};
  const target='http://customer-app:3001/internal/caller-context',credential=process.env.CONSULTATION_AUTH_TOKEN;
  assert.equal((await privateCall(target,credential,query)).value.payload.customer.name,'현재 고객');
  await customer.query("UPDATE customers SET name='변경 즉시 반영' WHERE customer_seq=1");
  assert.equal((await privateCall(target,credential,query)).value.payload.customer.name,'변경 즉시 반영');
  await customer.query("UPDATE customers SET name='현재 고객' WHERE customer_seq=1");
  assert.equal((await customer.query('SELECT count(*)::int AS n FROM inbox_events WHERE event_id=$1',[query.eventId])).rows[0].n,0);
 });
 await t.test('a lost successful command response remains unknown and a retry reuses its call and audit',async sub=>{
  const {CallContextClient}=require('./customer-runtime/customers/call-context.client');
  const {CustomersService}=require('./customer-runtime/customers/customers.service');
  const values={CONSULTATION_URL:'http://consultation-app:3004',CUSTOMER_AUTH_TOKEN:process.env.CUSTOMER_AUTH_TOKEN};
  const client=new CallContextClient({get:key=>values[key]}),service=new CustomersService({}, {}, {}, client);
  const input={phoneNumber:'01098880001',call:call('lost-command-ack-'+randomUUID())};
  const realFetch=globalThis.fetch;let lose=true,committed;
  sub.mock.method(globalThis,'fetch',async(...args)=>{
   const response=await realFetch(...args);
   if(lose){lose=false;assert.equal(response.status,200);committed=(await response.json()).payload.callSessionSeq;throw new TypeError('simulated lost command response');}
   return response;
  });
  await assert.rejects(service.context(input,null,randomUUID()),e=>e.getStatus()===503);
  assert.ok(Number.isInteger(committed));
  for(let n=0;n<2;n++)assert.equal((await service.context(input,null,randomUUID())).callSessionSeq,committed);
  assert.equal((await consultation.query('SELECT count(*)::int AS n FROM call_sessions WHERE provider_call_id=$1',[input.call.providerCallId])).rows[0].n,1);
  assert.equal((await operations.query("SELECT count(*)::int AS n FROM audit_logs WHERE action='CALL_STARTED' AND target_seq=$1",[committed])).rows[0].n,1);
 });
 await t.test('a killed producer leaves no call or receipt and its prepared audit aborts before one successful retry',async()=>{
  const {spawn}=require('node:child_process'),{once}=require('node:events');
  const payload={input:{phoneNumber:'01098880001',call:call('crash-'+randomUUID())},actorId:null,requestId:randomUUID()};
  const child=spawn(process.execPath,['test/context-claimant.cjs'],{env:{...process.env,CONTEXT_CRASH_PAYLOAD:JSON.stringify(payload)},stdio:['ignore','pipe','pipe']});
  let ready=false,problem='';child.stdout.on('data',chunk=>{if(chunk.toString().includes('prepared'))ready=true;});child.stderr.on('data',chunk=>{problem+=chunk;});
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
  for(let n=0;!ready;n++){assert.ok(n<150&&child.exitCode===null,'claimant did not prepare: '+problem);await delay(50);}
  const prepared=(await operations.query("SELECT transaction_id FROM consultation_audit_preparations WHERE NOT aborted AND audit->>'request_id'=$1",[payload.requestId])).rows;assert.equal(prepared.length,1);
  assert.equal((await consultation.query('SELECT count(*)::int AS n FROM call_sessions WHERE provider_call_id=$1',[payload.input.call.providerCallId])).rows[0].n,0);
  const exited=once(child,'exit');child.kill('SIGKILL');assert.deepEqual(await exited,[null,'SIGKILL']);
  assert.equal((await consultation.query("SELECT count(*)::int AS n FROM inbox_events WHERE payload->>'requestId'=$1",[payload.requestId])).rows[0].n,0);
  for(let n=0;;n++){
   const response=await fetch(sides[1].auth+'/api/audit-logs?limit=100',{headers:{Cookie:sides[1].cookie}});assert.equal(response.status,200);await response.arrayBuffer();
   if((await operations.query('SELECT aborted FROM consultation_audit_preparations WHERE event_id=$1',[prepared[0].transaction_id])).rows[0]?.aborted)break;
   assert.ok(n<80,'orphan audit was not reconciled');await delay(50);
  }
  assert.equal((await operations.query('SELECT count(*)::int AS n FROM audit_logs WHERE request_id=$1',[payload.requestId])).rows[0].n,0);
  let saved;
  for(let n=0;n<2;n++){const response=await fetch(sides[1].base+'/api/customers/context',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload.input)});assert.equal(response.status,200);const value=await response.json();if(saved)assert.equal(value.data.callSessionSeq,saved);saved=value.data.callSessionSeq;}
  assert.equal((await consultation.query('SELECT count(*)::int AS n FROM call_sessions WHERE provider_call_id=$1',[payload.input.call.providerCallId])).rows[0].n,1);
  assert.equal((await operations.query("SELECT count(*)::int AS n FROM audit_logs WHERE action='CALL_STARTED' AND target_seq=$1",[saved])).rows[0].n,1);
 });
 await t.test('service credentials and preparation tables isolate customer and consultation audit decisions',async()=>{
  async function event(source,token,eventType,payload){const id=randomUUID(),response=await fetch('http://operations-app:3005/internal/events',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({eventId:id,source,eventType,payload})});return{status:response.status,value:await response.json(),id};}
  const transactionId=randomUUID(),input={transactionId,result:'SUCCESS',occurredAt:new Date().toISOString(),audit:{actorId:null,actorType:'AI',action:'CUSTOMER_CREATED',targetType:'CUSTOMER',targetId:1,requestId:randomUUID()}};
  const prepared=await event('customer',process.env.CUSTOMER_AUTH_TOKEN,'AuditPrepared',input);assert.equal(prepared.status,200);
  assert.equal((await event('customer',process.env.CONSULTATION_AUTH_TOKEN,'AuditAborted',{transactionId})).status,401);
  assert.equal((await event('consultation',process.env.CONSULTATION_AUTH_TOKEN,'AuditPrepared',input)).status,422);
  const callAudit={...input,audit:{...input.audit,action:'CALL_STARTED',targetType:'CALL_SESSION'}};
  for(const invalid of [{...callAudit,result:'FAILED'},{...callAudit,audit:{...callAudit.audit,actorType:'SYSTEM'}},{...callAudit,audit:{...callAudit.audit,targetId:null}}])
   assert.equal((await event('consultation',process.env.CONSULTATION_AUTH_TOKEN,'AuditPrepared',invalid)).status,422);
  assert.equal((await event('consultation',process.env.CONSULTATION_AUTH_TOKEN,'AuditAborted',{transactionId})).status,200);
  assert.equal((await operations.query('SELECT aborted FROM customer_audit_preparations WHERE event_id=$1',[prepared.id])).rows[0].aborted,false);
  assert.equal((await event('customer',process.env.CUSTOMER_AUTH_TOKEN,'AuditAborted',{transactionId})).status,200);
  assert.equal((await operations.query('SELECT aborted FROM customer_audit_preparations WHERE event_id=$1',[prepared.id])).rows[0].aborted,true);
 });
 t.diagnostic(`Compared ${count} HTTP requests, unfiltered customer/call/PBX/recording/audit rows and ${visited.size} referenced DTOs; ten concurrent callers per side.`);
});
