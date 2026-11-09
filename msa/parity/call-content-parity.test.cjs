const { truncateFixture } = require('./fixture-reset.cjs');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID,createHash}=require('node:crypto');
const {fork}=require('node:child_process');
const {once}=require('node:events');
const {Pool}=require('pg');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('production unanswered writes and call content/deletion match the monolith',async t=>{
  assert.equal(process.env.PGDATABASE,'dva_webhook_test');
  const begun=Date.now(),origin='http://localhost:5173',token=process.env.AI_INSIGHTS_TOKEN;
  const mono=new Pool({host:'monolith-db',user:'monolith_app'}),cons=new Pool({host:'consultation-db',user:'consultation_app'}),ops=new Pool({host:'operations-db',user:'operations_app'});
  const sides=[{base:'http://monolith-app:3000',db:mono,identity:mono},{base:'http://consultation-app:3004',db:cons,identity:ops}];
  const children=new Set(),expiryFixtures=[];
  t.after(async()=>{for(const child of children)child.kill('SIGKILL');for(const fixture of expiryFixtures){await fixture.query('ROLLBACK');fixture.release();}await Promise.all([mono.end(),cons.end(),ops.end()]);});
  for(const side of sides)for(let attempt=0;;attempt++){
    try{if((await fetch(side.base+(side.db===mono?'/health':'/consultation/health/ready'))).status===200)break;}catch{}
    assert.ok(attempt<60,'production app did not become ready');await delay(100);
  }
  const requestIds=new Set(),parallelRequests=new Map(),times=new Map();
  let comparisons=0;
  for(const side of sides){
    await truncateFixture(side.db, 'TRUNCATE call_sessions RESTART IDENTITY CASCADE');
    side.cookies=[];side.admins=[];
    for(const [index,role]of ['OPERATOR','SUPERVISOR','SYSTEM_ADMIN'].entries()){
      const id=(await side.identity.query(`INSERT INTO admin_users(login_id,name,password_hash,role,status)
        VALUES($1,$2,'unused-password',$3,'ACTIVE') RETURNING admin_user_seq`,['content'+index,'콘텐츠 관리자 '+index,role])).rows[0].admin_user_seq;
      const session=String(index+3).repeat(64);
      await side.identity.query('INSERT INTO admin_sessions(session_token_hash,admin_user_seq) VALUES($1,$2)',[createHash('sha256').update(session).digest('hex'),id]);
      side.cookies.push('dva_session='+session);side.admins.push(id);
    }
  }
  function receipt(side,key,value){
    if(value===null)return null;
    const stamp=new Date(value).getTime();assert.ok(stamp>=begun-2000&&stamp<=Date.now()+1000,key+' is a fresh receipt');
    const address=side.base+key;
    if(times.has(address))assert.equal(times.get(address),stamp,key+' must remain unchanged');else times.set(address,stamp);
    return '<'+key+'>';
  }
  async function snapshot(side){
    const calls=(await side.db.query(`SELECT call_session_seq,provider_call_id,caller_phone_number,incoming_at::text,started_at::text,ended_at::text,deleted_at
      FROM call_sessions WHERE provider_call_id LIKE 'content-%' ORDER BY call_session_seq`)).rows;
    for(const row of calls)row.deleted_at=receipt(side,'call-deleted-'+row.call_session_seq,row.deleted_at);
    const questions=(await side.db.query(`SELECT unanswered_question_seq,event_id,call_session_seq,question_text,occurred_at::text,offset_seconds,status,reason,
      faq_entry_seq,payload_hash,faq_conversion_hash,created_at,registered_at::text,deleted_at FROM unanswered_questions ORDER BY unanswered_question_seq`)).rows;
    for(const row of questions){row.created_at=receipt(side,'question-created-'+row.unanswered_question_seq,row.created_at);row.deleted_at=receipt(side,'question-deleted-'+row.unanswered_question_seq,row.deleted_at);}
    const events=(await side.db.query(`SELECT event_id,call_session_seq,event_order,kind,occurred_at::text,offset_seconds,call_utterance_seq,unanswered_question_seq,payload,payload_hash
      FROM call_insight_events ORDER BY event_order,event_id`)).rows;
    const utterances=(await side.db.query(`SELECT call_utterance_seq,call_session_seq,utterance_order,speaker,utterance_text,last_sentence_seq,received_at::text
      FROM call_utterances ORDER BY call_utterance_seq`)).rows;
    const audits=(await side.identity.query(`SELECT actor_type,actor_seq,actor_name,action,target_type,target_seq,target_admin_name,request_id,result,metadata,occurred_at
      FROM audit_logs WHERE request_id=ANY($1::uuid[])`,[[...requestIds]])).rows;
    for(const row of audits){
      if(row.actor_seq!==null){const index=side.admins.indexOf(row.actor_seq);assert.ok(index>=0);row.actor_seq='<admin-'+index+'>';}
      receipt(side,'audit-'+row.request_id+'-'+row.action+'-'+row.result,row.occurred_at);delete row.occurred_at;
      row.request_id=parallelRequests.get(row.request_id)??row.request_id;
    }
    audits.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return {calls,questions,events,utterances,audits};
  }
  async function compare(){assert.deepEqual(await snapshot(sides[1]),await snapshot(sides[0]));}
  async function http(side,method,path,body,options,requestId){
    const headers={'X-Request-Id':requestId};
    if(options.origin!==false)headers.Origin=options.origin??origin;
    if(options.session!==false)headers.Cookie=options.cookie??side.cookies[options.actor??0];
    if(options.bearer!==undefined)headers.Authorization='Bearer '+options.bearer;
    if(body!==undefined)headers['Content-Type']='application/json';
    const response=await fetch(side.base+path,{method,headers,redirect:'error',signal:AbortSignal.timeout(15000),body:body===undefined?undefined:JSON.stringify(body)});
    const text=await response.text();
    return {status:response.status,body:text?JSON.parse(text):null,cache:response.headers.get('cache-control'),
      requestId:response.headers.get('x-request-id'),cors:response.headers.get('access-control-allow-origin'),location:response.headers.get('location')};
  }
  async function pair(method,path,body,status,options={}){
    const id=randomUUID();requestIds.add(id);
    const results=[];for(const side of sides){const result=await http(side,method,path,body,options,id);assert.equal(result.status,status,side.base+' '+method+' '+path+' '+JSON.stringify(result));results.push(result);}
    assert.deepEqual(results[1],results[0],method+' '+path);await compare();comparisons++;return results[0].body;
  }
  const collect=(body,status=201,options={})=>pair('POST','/api/ai/unanswered-questions',body,status,{session:false,bearer:token,...options});
  const question=(call=100001,changes={})=>({eventId:randomUUID(),callSessionSeq:call,providerCallId:'content-'+call,questionText:' 원문 질문\n주말 수거? 😊 ',occurredAt:'2026-11-01T10:01:20+09:00',offsetSeconds:80,...changes});
  async function seedCall(id,changes={}){
    for(const side of sides)await side.db.query(`INSERT INTO call_sessions(call_session_seq,provider_call_id,caller_phone_number,incoming_at,started_at,ended_at)
      OVERRIDING SYSTEM VALUE VALUES($1,$2,'01011112222',$3,$4,$5)`,[id,'content-'+id,'2026-11-01T01:00:00Z',changes.ongoing?null:'2026-11-01T01:00:00Z',changes.ongoing?null:'2026-11-01T01:03:00Z']);
    // Freeze only physical expiry cleanup; API guards must still reject the exact expired timestamp.
    if(changes.incomingAt)for(const side of sides){const fixture=await side.db.connect();expiryFixtures.push(fixture);await fixture.query('BEGIN');
      await fixture.query('SELECT 1 FROM call_sessions WHERE call_session_seq=$1 FOR KEY SHARE',[id]);
      await side.db.query('UPDATE call_sessions SET incoming_at=$2 WHERE call_session_seq=$1',[id,changes.incomingAt]);}
  }
  for(const id of [100001,100002,100003,100004])await seedCall(id,{ongoing:id===100002,incomingAt:id===100004?'2020-01-01T01:00:00Z':undefined});
  const first=question(),qid=(await collect(first)).data.unansweredQuestionSeq;
  await collect({...first,eventId:first.eventId.toUpperCase(),occurredAt:'2026-11-01T01:01:20Z',reason:null},200);
  for(const change of [{questionText:'변경 원문'},{offsetSeconds:81},{occurredAt:'2026-11-01T01:01:21Z'},{reason:'KB_NO_ANSWER'},
    {callSessionSeq:100003,providerCallId:'content-100003'}])await collect({...first,...change},409);
  await collect(question(100004),404);await collect(question(199999),404);await collect(question(100001,{providerCallId:'wrong'}),403);
  for(const options of [{bearer:'wrong'},{bearer:undefined},{bearer:'wrong',session:true}])await collect(question(),401,options);
  const rejected=[{eventId:'bad'},{callSessionSeq:'100001'},{providerCallId:'bad id'},{providerCallId:'bad\u0000id'},{questionText:' '},
    {questionText:'x\u0000y'},{questionText:'😊'.repeat(1001)},{occurredAt:'2026-02-30T00:00:00Z'},{occurredAt:'2026-11-01T00:00:00'},
    {offsetSeconds:'0'},{offsetSeconds:-1},{offsetSeconds:0.5},{offsetSeconds:Number.MAX_SAFE_INTEGER+1},{reason:'UNCLASSIFIED'},
    {reason:'OTHER'},{reason:['KB_NO_ANSWER']},{status:'OPEN'},{customerSeq:1},{events:[]}];
  for(const changes of rejected)await collect(question(100001,changes),400);
  for(const field of Object.keys(question())){const body=question();delete body[field];await collect(body,400);}
  await collect(question(100001,{occurredAt:'0000-01-01T00:00:00Z'}),400);
  await collect(question(100001,{questionText:'a'.repeat(110000)}),413);
  const classified=question(100001,{reason:'KB_NO_ANSWER',offsetSeconds:0}),classifiedId=(await collect(classified)).data.unansweredQuestionSeq;
  await collect(classified,200);await collect({...classified,reason:undefined},409);
  const unavailable=question(100001,{reason:'KB_UNAVAILABLE',offsetSeconds:Number.MAX_SAFE_INTEGER});await collect(unavailable);await collect(unavailable,200);
  await collect(question(100001,{reason:null,offsetSeconds:null,questionText:'😊'.repeat(1000)}));
  // Same text with distinct UUIDs is not merged; cumulative counts are not capped at 50.
  for(let i=0;i<51;i++)await collect(question(100002));
  const peer=fork(require.resolve('../dist/main.js'),[],{env:{...process.env,NODE_ENV:'production',PORT:'33004',DB_HOST:'consultation-db',DB_PORT:'5432',
    DB_USER:'consultation_app',DB_PASSWORD:process.env.PGPASSWORD,DB_NAME:process.env.PGDATABASE,OPERATIONS_URL:'http://operations-app:3005',CUSTOMER_URL:'http://customer-app:3001',
    SECURITY_LOG_HMAC_KEY:createHash('sha256').update(randomUUID()).digest('hex'),CORS_ORIGINS:origin,AI_AGENT_URL:'http://ai.invalid:8000',S3_RECORDINGS_BUCKET:''},stdio:['ignore','ignore','ignore','ipc']});
  children.add(peer);peer.once('exit',()=>children.delete(peer));
  const peerSide={...sides[1],base:'http://127.0.0.1:33004'};
  for(let attempt=0;;attempt++){try{if((await fetch(peerSide.base+'/consultation/health/ready')).status===200)break;}catch{}
    assert.ok(attempt<100,'second production process did not become ready');await delay(100);}
  const concurrent=question(),parallel=[randomUUID(),randomUUID()];parallel.forEach(id=>{requestIds.add(id);parallelRequests.set(id,parallel[0]);});
  const winners=[];
  for(const side of sides){const results=await Promise.all(parallel.map((id,index)=>http(side===sides[1]&&index===1?peerSide:side,'POST','/api/ai/unanswered-questions',concurrent,{session:false,bearer:token},id)));assert.deepEqual(results.map(r=>r.status).sort(),[200,201]);assert.equal(results[0].body.data.unansweredQuestionSeq,results[1].body.data.unansweredQuestionSeq);winners.push(results[0].body);}
  assert.deepEqual(winners[1],winners[0]);await compare();
  const peerExited=once(peer,'exit');peer.kill('SIGTERM');await peerExited;
  const recorded=(await mono.query('SELECT * FROM unanswered_questions WHERE unanswered_question_seq=$1',[qid])).rows[0];
  assert.equal(recorded.payload_hash,createHash('sha256').update(JSON.stringify({...first,eventId:first.eventId.toLowerCase(),occurredAt:new Date(first.occurredAt).toISOString(),reason:undefined})).digest('hex'));

  // Seed existing utterances/events, not an alternate ingestion implementation.
  for(const side of sides){
    for(const [id,order,speaker,text]of [[101,2,'AI','실제 답변\n안내'],[102,1,'CUSTOMER','실제 고객 질문']])await side.db.query(`INSERT INTO call_utterances(call_utterance_seq,call_session_seq,utterance_order,speaker,utterance_text,last_sentence_seq,received_at)
      OVERRIDING SYSTEM VALUE VALUES($1,100001,$2,$3,$4,2,'2026-11-01T01:00:01Z')`,[id,order,speaker,text]);
  }
  async function event(order,kind,payload,utteranceId=null,unansweredId=null){
    const id=randomUUID();for(const side of sides)await side.db.query(`INSERT INTO call_insight_events(event_id,call_session_seq,event_order,kind,occurred_at,offset_seconds,call_utterance_seq,unanswered_question_seq,payload,payload_hash)
      VALUES($1,100001,$2,$3,'2026-11-01T01:01:20Z',$4,$5,$6,$7,$8)`,[id,order,kind,order===1?null:order,utteranceId,unansweredId,payload,'a'.repeat(64)]);
  }
  await event(1,'UTTERANCE',null,102);await event(2,'UTTERANCE',null,101);
  await event(3,'AI_ACTION',{action:'PIN_SEARCH',summaryText:'PIN 검색',orderSeq:null});
  await event(4,'AI_ACTION',{action:'PREVIOUS_ORDER_SEARCH',summaryText:'과거 주문',orderSeq:37});
  await event(5,'BUSINESS_RESULT',{action:'QUESTION_UNANSWERED',summaryText:'미답변 수집',orderSeq:null,unansweredQuestionSeq:qid},null,qid);
  await event(6,'BUSINESS_RESULT',{action:'QUESTION_UNANSWERED',summaryText:'분류 수집',orderSeq:null,unansweredQuestionSeq:classifiedId},null,classifiedId);
  await event(7,'BUSINESS_RESULT',{action:'FAQ_ANSWERED',summaryText:'여러 FAQ 답변',faqEntrySeqs:[31,32],questionUtteranceOrder:1,answerUtteranceOrder:2,orderSeq:null});
  await event(8,'BUSINESS_RESULT',{action:'FAQ_ANSWERED',summaryText:'구 단건 FAQ',faqEntrySeq:31,questionUtteranceOrder:1,answerUtteranceOrder:2,orderSeq:null});
  await event(9,'BUSINESS_RESULT',{action:'INQUIRY',summaryText:'문의',orderSeq:null,unansweredQuestionSeq:null});
  for(const route of ['transcript','actions','processing-results']){
    const path='/api/calls/100001/'+route;
    await pair('GET',path,undefined,401,{session:false});await pair('GET',path,undefined,401,{cookie:'dva_session=bad'});
    await pair('GET',path,undefined,401,{session:false,bearer:token});
    for(const actor of [0,1,2])await pair('GET',path,undefined,200,{actor,origin:false});
    for(const query of ['?limit=1&offset=0','?limit=1&offset=1','?limit=1&offset=100','?limit=100&offset=0'])await pair('GET',path+query,undefined,200);
    for(const query of ['?limit=0','?limit=101','?offset=-1','?limit=1&limit=2','?unknown=x'])await pair('GET',path+query,undefined,400);
    for(const id of ['0','2147483648','abc'])await pair('GET','/api/calls/'+id+'/'+route,undefined,400);
    await pair('GET','/api/calls/100003/'+route,undefined,200);await pair('GET','/api/calls/100004/'+route,undefined,404);await pair('GET','/api/calls/199999/'+route,undefined,404);
  }
  const transcript=(await pair('GET','/api/calls/100001/transcript',undefined,200)).data;
  assert.deepEqual(transcript.map(x=>[x.utteranceOrder,x.speaker,x.offsetSeconds]),[[1,'CUSTOMER',null],[2,'AI',2]]);
  let results=(await pair('GET','/api/calls/100001/processing-results',undefined,200)).data;
  assert.equal(results[0].questionText,first.questionText);assert.equal(results[1].unansweredReason,'KB_NO_ANSWER');
  assert.deepEqual(results[2].faqEntrySeqs,[31,32]);assert.equal(results[2].faqEntrySeq,null);assert.equal(results[2].questionText,'실제 고객 질문');assert.equal(results[2].answerText,'실제 답변\n안내');
  assert.deepEqual(results[3].faqEntrySeqs,[31]);assert.equal(results[3].faqEntrySeq,31);
  for(const options of [{session:false},{cookie:'dva_session=bad'}])await pair('DELETE','/api/unanswered-questions/'+qid,undefined,401,options);
  for(const options of [{origin:false},{origin:'https://evil.invalid'}])await pair('DELETE','/api/unanswered-questions/'+qid,undefined,403,options);
  for(const body of [{x:1},[],null,'invalid'])await pair('DELETE','/api/unanswered-questions/'+qid,body,400);
  for(const id of ['0','abc','2147483648'])await pair('DELETE','/api/unanswered-questions/'+id,undefined,400);
  await pair('DELETE','/api/unanswered-questions/199999',undefined,404);
  await pair('DELETE','/api/unanswered-questions/'+qid,{},204);await pair('DELETE','/api/unanswered-questions/'+qid,undefined,204);
  await collect(first,200);
  assert.equal((await mono.query('SELECT question_text FROM unanswered_questions WHERE unanswered_question_seq=$1',[qid])).rows[0].question_text,first.questionText);
  results=(await pair('GET','/api/calls/100001/processing-results',undefined,200)).data;
  assert.equal(results[0].questionText,null);assert.equal(results[0].unansweredReason,null);
  // Existing conversion state is preserved on replay and cannot be deleted; conversion itself is a later phase.
  for(const side of sides)await side.db.query(`UPDATE unanswered_questions SET status='REGISTERED',faq_entry_seq=31,faq_conversion_hash=$2,registered_at='2026-11-01T01:02:00Z'
    WHERE unanswered_question_seq=$1`,[classifiedId,'b'.repeat(64)]);
  await pair('DELETE','/api/unanswered-questions/'+classifiedId,undefined,409);await collect(classified,200);
  for(const actor of [0,1,2]){const body=question(100003);const id=(await collect(body)).data.unansweredQuestionSeq;await pair('DELETE','/api/unanswered-questions/'+id,undefined,204,{actor});await collect(body,200);}
  // Fail the actual audit table on each owner; neither source may commit a business change.
  for(const side of sides)await side.identity.query(`CREATE FUNCTION fail_content_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
    IF NEW.action IN ('UNANSWERED_QUESTION_RECORDED','UNANSWERED_QUESTION_DELETED','CALL_DELETED') AND NEW.result='SUCCESS' THEN RAISE EXCEPTION 'fixture audit unavailable'; END IF; RETURN NEW; END$$;
    CREATE TRIGGER fail_content_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_content_audit()`);
  const failed=question(100003);
  const openId=(await mono.query("SELECT unanswered_question_seq FROM unanswered_questions WHERE call_session_seq=100002 AND status='OPEN' ORDER BY unanswered_question_seq LIMIT 1")).rows[0].unanswered_question_seq;
  try{await collect(failed,500);await pair('DELETE','/api/unanswered-questions/'+openId,undefined,500);await pair('DELETE','/api/calls/100003',undefined,500);}
  finally{for(const side of sides)await side.identity.query('DROP TRIGGER fail_content_audit ON audit_logs; DROP FUNCTION fail_content_audit()');}
  await collect(failed);await pair('DELETE','/api/unanswered-questions/'+openId,undefined,204);
  await pair('DELETE','/api/calls/100002',undefined,409);
  for(const options of [{session:false},{session:false,bearer:token}])await pair('DELETE','/api/calls/100003',undefined,401,options);
  await pair('DELETE','/api/calls/100003',undefined,403,{origin:false});await pair('DELETE','/api/calls/100004',undefined,404);
  for(const id of ['0','abc','2147483648'])await pair('DELETE','/api/calls/'+id,undefined,400);
  // A real PostgreSQL row lock follows the source 2-second conflict policy.
  const locks=[];
  try{
    for(const side of sides){const lock=await side.db.connect();locks.push(lock);await lock.query('BEGIN');await lock.query('SELECT 1 FROM call_sessions WHERE call_session_seq=100003 FOR UPDATE');}
    await pair('DELETE','/api/calls/100003',undefined,409);
  }finally{for(const lock of locks){await lock.query('ROLLBACK');lock.release();}}
  await pair('DELETE','/api/calls/100003',undefined,204);await pair('DELETE','/api/calls/100003',undefined,404);
  for(const route of ['transcript','actions','processing-results'])await pair('GET','/api/calls/100003/'+route,undefined,404);
  await collect(question(100003),404);
  const callId=100001;
  for(const side of sides)await side.db.query(`INSERT INTO pbx_webhooks.call_ended_events(recording_id,payload,call_session_seq,processing_status)
    VALUES('content-recording',$1,$2,'RECEIVED')`,[{callFrom:'01011112222',startedAt:'2026-11-01T01:00:00Z',endedAt:'2026-11-01T01:03:00Z',durationSeconds:180,recordingUrl:'https://recordings.example.test/a.mp3'},callId]);
  for(const status of ['RECEIVED','FAILED']){for(const side of sides)await side.db.query('UPDATE pbx_webhooks.call_ended_events SET processing_status=$1 WHERE call_session_seq=$2',[status,callId]);await pair('DELETE','/api/calls/'+callId,undefined,409);}
  for(const side of sides)await side.db.query(`UPDATE pbx_webhooks.call_ended_events SET processing_status='PROCESSED',claim_id=$1,claimed_until=clock_timestamp()+interval '1 hour' WHERE call_session_seq=$2`,[randomUUID(),callId]);
  await pair('DELETE','/api/calls/'+callId,undefined,409);
  for(const side of sides)await side.db.query(`UPDATE pbx_webhooks.call_ended_events SET claim_id=NULL,claimed_until=NULL WHERE call_session_seq=$1`,[callId]);
  await pair('DELETE','/api/calls/'+callId,undefined,204);
  for(const route of ['transcript','actions','processing-results'])await pair('GET','/api/calls/'+callId+'/'+route,undefined,404);
  await collect(first,404);await pair('DELETE','/api/unanswered-questions/'+qid,undefined,404);
  const docs=await Promise.all(sides.map(async side=>(await fetch(side.base+'/api/docs-json')).json()));
  const paths=[['/api/ai/unanswered-questions','post'],['/api/unanswered-questions/{id}','delete'],['/api/calls/{id}','delete'],
    ...['transcript','actions','processing-results'].map(s=>['/api/calls/{id}/'+s,'get'])];
  const seen=new Set();
  function schema(value){if(Array.isArray(value))return value.forEach(schema);if(!value||typeof value!=='object')return;
    if(value.$ref){const name=value.$ref.split('/').at(-1);if(!seen.has(name)){seen.add(name);assert.deepEqual(docs[1].components.schemas[name],docs[0].components.schemas[name],name);schema(docs[0].components.schemas[name]);}}
    Object.values(value).forEach(schema);}
  for(const [path,method]of paths){assert.deepEqual(docs[1].paths[path][method],docs[0].paths[path][method],path);schema(docs[0].paths[path][method]);}
  assert.ok(!Object.keys(docs[1].paths).some(path=>path.includes('/internal/')));

  const prepared={eventId:randomUUID(),source:'consultation',eventType:'AuditPrepared',payload:{transactionId:randomUUID(),
    audit:{actorId:null,actorType:'AI',action:'UNANSWERED_QUESTION_RECORDED',targetType:'UNANSWERED_QUESTION',targetId:qid,requestId:randomUUID()},result:'SUCCESS',occurredAt:new Date().toISOString()}};
  const forged=[
    {...prepared,source:'customer'},
    ...[{targetType:'CALL_SESSION'},{actorType:'ADMIN',actorId:sides[1].admins[0]},
      {action:'UNANSWERED_QUESTION_DELETED'},{action:'CALL_DELETED',targetType:'CALL_SESSION'},
      {action:'UNKNOWN_ACTION'},{actorId:1},{targetId:null},{targetId:0},{privateSecret:'forged'}]
      .map(change=>({...prepared,payload:{...prepared.payload,audit:{...prepared.payload.audit,...change}}})),
    {...prepared,payload:{...prepared.payload,personaVersionSeq:1}},
  ];
  const forgedIds=[];
  for(const [index,event]of forged.entries()){
    const id=randomUUID();forgedIds.push(id);
    const response=await fetch('http://operations-app:3005/internal/events',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+process.env.CONSULTATION_AUTH_TOKEN},body:JSON.stringify({...event,eventId:id})});
    assert.equal(response.status,index===0?401:422,await response.text());
  }
  assert.equal((await ops.query('SELECT count(*) FROM inbox_events WHERE event_id=ANY($1::uuid[])',[forgedIds])).rows[0].count,'0');
  assert.equal((await ops.query('SELECT count(*) FROM consultation_audit_preparations WHERE transaction_id=$1',[prepared.payload.transactionId])).rows[0].count,'0');
  t.diagnostic('private audit rejects forged source/action/target/success actor and extra fields without inbox/preparation residue');

  async function until(check,label){for(let i=0;i<100;i++){if(await check())return;await delay(100);}assert.fail(label);}
  // Kill actual producer processes on both sides of the existing audit commit boundary.
  const crashFixtures=[];
  for(const operation of ['collect','delete'])for(const mode of ['prepared','committed']){
    const input=question(100002),id=operation==='delete'?(await collect(input)).data.unansweredQuestionSeq:undefined;
    crashFixtures.push({operation,mode,input,id});
  }
  for(const {operation,mode,input,id}of crashFixtures){
    const requestId=randomUUID();
    const child=fork(require.resolve('./call-content-claimant.cjs'),[],{env:{...process.env,CONTENT_CRASH_PAYLOAD:JSON.stringify({operation,mode,input,id,adminId:sides[1].admins[0],requestId})},stdio:['ignore','pipe','pipe','ipc']});
    children.add(child);child.once('exit',()=>children.delete(child));
    const [ready]=await once(child,'message',{signal:AbortSignal.timeout(15000)});assert.deepEqual(ready,{ready:true});
    const exited=once(child,'exit');child.kill('SIGKILL');await exited;
    await until(async()=>(await ops.query('SELECT count(*) FROM consultation_audit_preparations WHERE audit->>\'request_id\'=$1',[requestId])).rows[0].count==='0','producer audit did not reconcile');
    const row=(await cons.query('SELECT status FROM unanswered_questions WHERE event_id=$1',[input.eventId])).rows[0];
    if(operation==='collect')assert.equal(!!row,mode==='committed');else assert.equal(row.status,mode==='committed'?'DELETED':'OPEN');
    await until(async()=>(await ops.query("SELECT count(*) FROM audit_logs WHERE request_id=$1 AND result='SUCCESS'",[requestId])).rows[0].count===(mode==='committed'?'1':'0'),'committed audit missing or duplicate');
    const retry=randomUUID(),response=await http(sides[1],operation==='collect'?'POST':'DELETE',operation==='collect'?'/api/ai/unanswered-questions':'/api/unanswered-questions/'+id,
      operation==='collect'?input:undefined,operation==='collect'?{session:false,bearer:token}:{},retry);
    assert.equal(response.status,operation==='collect'?(mode==='committed'?200:201):204);
    const current=(await cons.query('SELECT question_text,status FROM unanswered_questions WHERE event_id=$1',[input.eventId])).rows[0];assert.equal(current.question_text,input.questionText);
    assert.equal(current.status,operation==='collect'?'OPEN':'DELETED');
  }
  t.diagnostic(`production HTTP pairs: ${comparisons}; per-request business rows/hashes/content and all request audits match`);
  t.diagnostic('actual SIGKILL at prepared and committed audit boundaries: collect/delete rollback, recovery and replay');
});
