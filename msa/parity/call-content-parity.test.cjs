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
  const requestIds=new Set(),parallelRequests=new Map(),times=new Map(),registeredIds=new Set();
  t.after(async()=>{for(const child of children)child.kill('SIGKILL');for(const fixture of expiryFixtures){await fixture.query('ROLLBACK');fixture.release();}
    for(const db of [mono,cons])await truncateFixture(db,'TRUNCATE call_sessions RESTART IDENTITY CASCADE');
    for(const db of [mono,ops]){await db.query("DELETE FROM faq_entries WHERE question LIKE 'content-conversion %'");await db.query('DELETE FROM faq_change_notifications WHERE request_id=ANY($1::uuid[])',[[...requestIds]]);}
    await Promise.all([mono.end(),cons.end(),ops.end()]);});
  for(const side of sides)for(let attempt=0;;attempt++){
    try{if((await fetch(side.base+(side.db===mono?'/health':'/consultation/health/ready'))).status===200)break;}catch{}
    assert.ok(attempt<60,'production app did not become ready');await delay(100);
  }
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
    for(const row of questions){row.created_at=receipt(side,'question-created-'+row.unanswered_question_seq,row.created_at);row.deleted_at=receipt(side,'question-deleted-'+row.unanswered_question_seq,row.deleted_at);
      if(registeredIds.has(row.unanswered_question_seq))row.registered_at=receipt(side,'question-registered-'+row.unanswered_question_seq,row.registered_at);}
    const faqs=(await side.identity.query("SELECT * FROM faq_entries WHERE question LIKE 'content-conversion %' ORDER BY faq_entry_seq")).rows;
    for(const row of faqs){
      assert.ok(side.admins.includes(row.updated_by_admin_user_seq));row.updated_by_admin_user_seq='<admin-'+side.admins.indexOf(row.updated_by_admin_user_seq)+'>';
      row.created_at=receipt(side,'faq-created-'+row.faq_entry_seq,row.created_at);row.updated_at=receipt(side,'faq-updated-'+row.faq_entry_seq+'-'+(row.deleted_at===null?'created':'deleted'),row.updated_at);
      row.deleted_at=receipt(side,'faq-deleted-'+row.faq_entry_seq,row.deleted_at);
    }
    const notifications=(await side.identity.query('SELECT * FROM faq_change_notifications WHERE request_id=ANY($1::uuid[]) ORDER BY faq_change_notification_seq',[[...requestIds]])).rows;
    for(const row of notifications){assert.match(row.event_id,/^[0-9a-f-]{36}$/);row.event_id='<notification-'+row.faq_change_notification_seq+'>';
      row.created_at=receipt(side,'notification-created-'+row.faq_change_notification_seq,row.created_at);row.next_attempt_at=receipt(side,'notification-next-'+row.faq_change_notification_seq,row.next_attempt_at);
      row.request_id=parallelRequests.get(row.request_id)??row.request_id;
    }
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
    return {calls,questions,events,utterances,audits,faqs,notifications};
  }
  async function compare(){assert.deepEqual(await snapshot(sides[1]),await snapshot(sides[0]));}
  async function http(side,method,path,body,options,requestId){
    const headers={'X-Request-Id':requestId};
    if(options.origin!==false)headers.Origin=options.origin??origin;
    if(options.session!==false)headers.Cookie=options.cookie??side.cookies[options.actor??0];
    if(options.bearer!==undefined)headers.Authorization='Bearer '+options.bearer;
    if(body!==undefined)headers['Content-Type']='application/json';
    const base=side.db===cons&&path.startsWith('/api/faqs')?'http://operations-app:3005':side.base;
    const response=await fetch(base+path,{method,headers,redirect:'error',signal:AbortSignal.timeout(15000),body:body===undefined?undefined:JSON.stringify(body)});
    const text=await response.text();
    const parsed=text?JSON.parse(text):null;
    if(method==='GET'&&path.startsWith('/api/faqs/')&&response.status===200){
      const id=Number(path.split('/').at(-1)),stored=(await side.identity.query('SELECT created_at,updated_at,updated_by_admin_user_seq FROM faq_entries WHERE faq_entry_seq=$1',[id])).rows[0];
      assert.equal(parsed.data.createdAt,stored.created_at.toISOString());assert.equal(parsed.data.updatedAt,stored.updated_at.toISOString());
      assert.equal(parsed.data.updatedByAdminUserSeq,stored.updated_by_admin_user_seq);assert.ok(side.admins.includes(parsed.data.updatedByAdminUserSeq));
      parsed.data.createdAt=receipt(side,'faq-created-'+id,parsed.data.createdAt);parsed.data.updatedAt=receipt(side,'faq-updated-'+id+'-created',parsed.data.updatedAt);
      parsed.data.updatedByAdminUserSeq='<admin-'+side.admins.indexOf(parsed.data.updatedByAdminUserSeq)+'>';
    }
    return {status:response.status,body:parsed,cache:response.headers.get('cache-control'),
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
  // Preserve a legacy registered state independently of the public conversion scenarios below.
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
  const faqBody=(changes={})=>({category:'수거 일정',question:'content-conversion '+randomUUID(),answer:' 답변 원문\n\n- 안내 ',...changes});
  const conversionPath=id=>'/api/unanswered-questions/'+id+'/faqs';
  async function collectConversion(){const input=question(100002,{questionText:'FAQ 전환 원문 '+randomUUID()});return{input,id:(await collect(input)).data.unansweredQuestionSeq};}
  const conversion=await collectConversion(),conversionInput=faqBody();registeredIds.add(conversion.id);
  await pair('POST',conversionPath(conversion.id),conversionInput,204);
  const faqId=(await mono.query('SELECT faq_entry_seq FROM unanswered_questions WHERE unanswered_question_seq=$1',[conversion.id])).rows[0].faq_entry_seq;
  await pair('POST',conversionPath(conversion.id),conversionInput,204);
  await collect(conversion.input,200);await pair('DELETE','/api/unanswered-questions/'+conversion.id,undefined,409);
  await pair('GET','/api/faqs/'+faqId,undefined,200);
  for(const changes of [{question:conversionInput.question+' '},{category:'기타'},{answer:conversionInput.answer+'추가'}])await pair('POST',conversionPath(conversion.id),{...conversionInput,...changes},409);
  await pair('DELETE','/api/faqs',{faqEntrySeqs:[faqId]},204);
  await pair('POST',conversionPath(conversion.id),conversionInput,409);
  await pair('POST',conversionPath(qid),faqBody(),404);await pair('POST',conversionPath(199999),faqBody(),404);
  const deletedConversion=await collectConversion();await pair('DELETE','/api/unanswered-questions/'+deletedConversion.id,undefined,204);
  await pair('POST',conversionPath(deletedConversion.id),faqBody(),409);
  const open=await collectConversion(),duplicateInput=faqBody();registeredIds.add(open.id);
  await pair('POST','/api/faqs',{items:[duplicateInput]},204);
  await pair('POST',conversionPath(open.id),{...duplicateInput,question:duplicateInput.question.toUpperCase().replaceAll(' ','  ')},409);
  for(const options of [{session:false},{cookie:'dva_session=bad'}])await pair('POST',conversionPath(open.id),faqBody(),401,options);
  for(const options of [{origin:false},{origin:'https://evil.invalid'}])await pair('POST',conversionPath(open.id),faqBody(),403,options);
  for(const id of ['0','2147483648','abc'])await pair('POST',conversionPath(id),faqBody(),400);
  for(const changes of [{category:'전체'},{question:' '},{question:'x\u0000'},{answer:' '},{question:'😀'.repeat(1001)},{answer:'😀'.repeat(20001)},{faqEntrySeq:1}])await pair('POST',conversionPath(open.id),faqBody(changes),400);
  await pair('POST',conversionPath(open.id),faqBody({answer:'x'.repeat(110000)}),413);
  const maximum=await collectConversion();registeredIds.add(maximum.id);
  await pair('POST',conversionPath(maximum.id),faqBody({question:'content-conversion '+'😀'.repeat(981),answer:'😀'.repeat(20000)}),204);
  const unicode=await collectConversion(),unicodeInput=faqBody({question:'content-conversion \ud800 '+randomUUID(),answer:'원본 \udc00 답변'});registeredIds.add(unicode.id);
  await pair('POST',conversionPath(unicode.id),unicodeInput,204);await pair('POST',conversionPath(unicode.id),unicodeInput,204);
  const unicodeFaq=(await mono.query('SELECT faq_entry_seq FROM unanswered_questions WHERE unanswered_question_seq=$1',[unicode.id])).rows[0].faq_entry_seq;
  const storedUnicode=(await pair('GET','/api/faqs/'+unicodeFaq,undefined,200)).data;assert.ok(storedUnicode.question.includes('\ufffd'));assert.ok(storedUnicode.answer.includes('\ufffd'));
  await pair('POST',conversionPath(unicode.id),{...unicodeInput,question:unicodeInput.question.replace('\ud800','\ufffd')},409);
  const dangling=await collectConversion(),danglingInput=faqBody(),danglingHash=createHash('sha256').update(JSON.stringify(danglingInput)).digest('hex');
  for(const side of sides)await side.db.query("UPDATE unanswered_questions SET status='REGISTERED',faq_entry_seq=2147483647,faq_conversion_hash=$2,registered_at='2026-11-01T01:02:00Z' WHERE unanswered_question_seq=$1",[dangling.id,danglingHash]);
  await pair('POST',conversionPath(dangling.id),danglingInput,409);
  for(const action of ['FAQ_CREATED','UNANSWERED_QUESTION_REGISTERED']){
    const failed=await collectConversion(),input=faqBody();registeredIds.add(failed.id);
    for(const side of sides)await side.identity.query(`CREATE FUNCTION content_conversion_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='${action}' AND NEW.result='SUCCESS' THEN RAISE EXCEPTION 'injected conversion audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER content_conversion_failure BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION content_conversion_failure()`);
    try{await pair('POST',conversionPath(failed.id),input,500);}finally{for(const side of sides)await side.identity.query('DROP TRIGGER content_conversion_failure ON audit_logs; DROP FUNCTION content_conversion_failure()');}
    await pair('POST',conversionPath(failed.id),input,204);await pair('POST',conversionPath(failed.id),input,204);
  }
  const parallelConversion=await collectConversion(),parallelInput=faqBody(),parallelIds=Array.from({length:5},()=>randomUUID());registeredIds.add(parallelConversion.id);
  parallelIds.forEach(id=>{requestIds.add(id);parallelRequests.set(id,parallelIds[0]);});
  for(const side of sides){const responses=await Promise.all(parallelIds.map(id=>http(side,'POST',conversionPath(parallelConversion.id),parallelInput,{},id)));
    assert.ok(responses.every(response=>response.status===204));assert.equal(new Set(responses.map(response=>response.location)).size,1);}
  await compare();
  const gated=await collectConversion(),gatedInput=faqBody(),gateId=randomUUID(),blockers=[],gatedRequests=[];registeredIds.add(gated.id);requestIds.add(gateId);
  try{
    for(const side of sides){
      await side.identity.query(`CREATE FUNCTION content_conversion_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.action='UNANSWERED_QUESTION_REGISTERED' AND NEW.result='SUCCESS' THEN PERFORM pg_advisory_xact_lock(20261111,1); END IF; RETURN NEW; END $$;
        CREATE TRIGGER content_conversion_gate BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION content_conversion_gate()`);
      const blocker=await side.identity.connect();blockers.push(blocker);await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(20261111,1)');
      gatedRequests.push(http(side,'POST',conversionPath(gated.id),gatedInput,{},gateId));
    }
    await until(async()=>{for(const side of sides)if(!(await side.identity.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query LIKE '%INSERT INTO audit_logs%' LIMIT 1")).rowCount)return false;return true;},'both conversion transactions did not reach the audit gate');
    await compare();
    const during=await pair('GET','/api/unanswered-questions?status=ALL&unansweredQuestionSeq='+gated.id,undefined,200);assert.equal(during.data[0].status,'OPEN');
    const duplicates=[];
    for(let n=0;n<5;n++){const id=randomUUID();requestIds.add(id);const both=sides.map(side=>http(side,'POST','/api/faqs',{items:[gatedInput]},{},id));
      duplicates.push(Promise.all(both).then(([source,actual])=>{assert.equal(source.status,409);assert.deepEqual(actual,source);}));}
    for(const blocker of blockers)await blocker.query('ROLLBACK');
    const results=await Promise.all(gatedRequests);assert.equal(results[0].status,204);assert.deepEqual(results[1],results[0]);await Promise.all(duplicates);await compare();
  }finally{
    for(const blocker of blockers){await blocker.query('ROLLBACK');blocker.release();}
    for(const side of sides)await side.identity.query('DROP TRIGGER IF EXISTS content_conversion_gate ON audit_logs; DROP FUNCTION IF EXISTS content_conversion_gate()');
    await Promise.allSettled(gatedRequests);
  }
  const delayed=await collectConversion(),delayedInput=faqBody(),delayedId=randomUUID(),readers=[];registeredIds.add(delayed.id);requestIds.add(delayedId);
  const confirmationGate=await ops.connect();let delayedRequest;
  try{
    await ops.query(`CREATE FUNCTION content_conversion_confirmation_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF current_query() LIKE '%jsonb_populate_record(NULL::faq_entries%' THEN PERFORM pg_advisory_xact_lock(20261111,2); END IF; RETURN NEW; END $$;
      CREATE TRIGGER content_conversion_confirmation_gate BEFORE INSERT ON faq_entries FOR EACH ROW EXECUTE FUNCTION content_conversion_confirmation_gate()`);
    await confirmationGate.query('BEGIN');await confirmationGate.query('SELECT pg_advisory_xact_lock(20261111,2)');
    const source=await http(sides[0],'POST',conversionPath(delayed.id),delayedInput,{},delayedId);assert.equal(source.status,204);
    delayedRequest=http(sides[1],'POST',conversionPath(delayed.id),delayedInput,{},delayedId);
    await until(async()=>(await cons.query("SELECT 1 FROM unanswered_questions u JOIN outbox_events o ON o.event_type='FaqConversionCommitted' AND o.delivered_at IS NULL WHERE u.unanswered_question_seq=$1 AND u.status='REGISTERED' LIMIT 1",[delayed.id])).rowCount===1,'the actual question commit did not precede owner confirmation');
    for(let n=0;n<5;n++){const reader={settled:false,promise:undefined};reader.promise=pair('GET','/api/unanswered-questions?status=ALL&unansweredQuestionSeq='+delayed.id,undefined,200).then(result=>{reader.settled=true;assert.equal(result.data[0].status,'REGISTERED');assert.ok(result.data[0].faqEntrySeq);});readers.push(reader);}
    await delay(150);assert.ok(readers.every(reader=>!reader.settled),'reads cannot expose a registered question without its committed FAQ');
    await confirmationGate.query('ROLLBACK');const actual=await delayedRequest;assert.deepEqual(actual,source);await Promise.all(readers.map(reader=>reader.promise));await compare();
  }finally{
    await confirmationGate.query('ROLLBACK');confirmationGate.release();await ops.query('DROP TRIGGER IF EXISTS content_conversion_confirmation_gate ON faq_entries; DROP FUNCTION IF EXISTS content_conversion_confirmation_gate()');
    await Promise.allSettled([delayedRequest,...readers.map(reader=>reader.promise)].filter(Boolean));
  }
  const docs=await Promise.all(sides.map(async side=>(await fetch(side.base+'/api/docs-json')).json()));
  const paths=[['/api/ai/unanswered-questions','post'],['/api/unanswered-questions/{id}','delete'],['/api/unanswered-questions/{id}/faqs','post'],['/api/calls/{id}','delete'],
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
  const conversionCrashes=[];
  for(const mode of ['prepared','committed']){const fixture=await collectConversion();registeredIds.add(fixture.id);conversionCrashes.push({...fixture,mode,faq:faqBody()});}
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
  for(const fixture of conversionCrashes){
    const requestId=randomUUID();requestIds.add(requestId);let gate;
    try{
      if(fixture.mode==='committed'){
        await ops.query(`CREATE FUNCTION content_conversion_confirmation_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF current_query() LIKE '%jsonb_populate_record(NULL::faq_entries%' THEN PERFORM pg_advisory_xact_lock(20261111,2); END IF; RETURN NEW; END $$;
          CREATE TRIGGER content_conversion_confirmation_gate BEFORE INSERT ON faq_entries FOR EACH ROW EXECUTE FUNCTION content_conversion_confirmation_gate()`);
        gate=await ops.connect();await gate.query('BEGIN');await gate.query('SELECT pg_advisory_xact_lock(20261111,2)');
      }
      const child=fork(require.resolve('./call-content-claimant.cjs'),[],{env:{...process.env,CONTENT_CRASH_PAYLOAD:JSON.stringify({operation:'convert',mode:fixture.mode,input:fixture.faq,id:fixture.id,adminId:sides[1].admins[0],requestId})},stdio:['ignore','pipe','pipe','ipc']});
      children.add(child);child.once('exit',()=>children.delete(child));
      const [ready]=await once(child,'message',{signal:AbortSignal.timeout(15000)});assert.deepEqual(ready,{ready:true});
      const preparation=(await ops.query("SELECT transaction_id,audit->'_faqConversion'->'faq'->>'faq_entry_seq' AS faq_id FROM consultation_audit_preparations WHERE audit->'_faqConversion'->>'requestId'=$1",[requestId])).rows[0];
      assert.ok(preparation);const reservedId=Number(preparation.faq_id);
      assert.equal((await ops.query('SELECT 1 FROM faq_entries WHERE faq_entry_seq=$1',[reservedId])).rowCount,0);
      const exited=once(child,'exit');child.kill('SIGKILL');await exited;
      if(gate){await gate.query('ROLLBACK');gate.release();gate=undefined;}
      await until(async()=>(await ops.query('SELECT 1 FROM consultation_audit_preparations WHERE transaction_id=$1 AND NOT aborted',[preparation.transaction_id])).rowCount===0,'FAQ creation preparation did not reconcile after SIGKILL');
      const saved=(await cons.query('SELECT status,faq_entry_seq,faq_conversion_hash FROM unanswered_questions WHERE unanswered_question_seq=$1',[fixture.id])).rows[0];
      assert.equal(saved.status,fixture.mode==='committed'?'REGISTERED':'OPEN');
      assert.equal((await ops.query("SELECT count(*)::int n FROM audit_logs WHERE request_id=$1 AND result='SUCCESS'",[requestId])).rows[0].n,fixture.mode==='committed'?2:0);
      if(fixture.mode==='committed'){
        assert.equal(saved.faq_entry_seq,reservedId);assert.equal((await ops.query('SELECT 1 FROM faq_entries WHERE faq_entry_seq=$1',[reservedId])).rowCount,1);
        assert.equal(saved.faq_conversion_hash,createHash('sha256').update(JSON.stringify(fixture.faq)).digest('hex'));
        await until(async()=>(await cons.query("SELECT 1 FROM outbox_events WHERE event_type='FaqConversionCommitted' AND payload->>'transactionId'=$1 AND delivered_at IS NOT NULL",[preparation.transaction_id])).rowCount===1,'committed FAQ intent was not confirmed');
      }else{assert.equal(saved.faq_entry_seq,null);assert.equal(saved.faq_conversion_hash,null);assert.equal((await ops.query('SELECT 1 FROM faq_entries WHERE faq_entry_seq=$1',[reservedId])).rowCount,0);}
      const retryId=randomUUID();requestIds.add(retryId);
      const retry=await http(sides[1],'POST',conversionPath(fixture.id),fixture.faq,{},retryId);assert.equal(retry.status,204);
      const linked=(await cons.query('SELECT faq_entry_seq FROM unanswered_questions WHERE unanswered_question_seq=$1',[fixture.id])).rows[0].faq_entry_seq;
      if(fixture.mode==='prepared')assert.notEqual(linked,reservedId,'a rolled-back source identity is consumed');
      else assert.equal(linked,reservedId);
      assert.equal((await ops.query("SELECT count(*)::int n FROM faq_change_notifications WHERE operation='INSERT' AND faq_entry_seqs=ARRAY[$1::int]",[linked])).rows[0].n,1);
      assert.equal((await ops.query('SELECT count(*)::int n FROM faq_entries WHERE question=$1',[fixture.faq.question])).rows[0].n,1);
    }finally{if(gate){await gate.query('ROLLBACK');gate.release();}await ops.query('DROP TRIGGER IF EXISTS content_conversion_confirmation_gate ON faq_entries; DROP FUNCTION IF EXISTS content_conversion_confirmation_gate()');}
  }
  t.diagnostic(`production HTTP pairs: ${comparisons}; per-request business rows/hashes/content and all request audits match`);
  t.diagnostic('actual SIGKILL at prepared and committed audit boundaries: collect/delete/FAQ conversion rollback, owner confirmation, recovery and replay');
});

test('call reference owners and public APIs preserve original joins, filters and pagination',async t=>{
  const {requestReferences}=require('@dva/events/call-read-references.cjs');
  const mono=new Pool({host:'monolith-db',user:'monolith_app'}),cons=new Pool({host:'consultation-db',user:'consultation_app'}),customer=new Pool({host:'customer-db',user:'customer_app'}),orders=new Pool({host:'order-db',user:'order_app'}),ops=new Pool({host:'operations-db',user:'operations_app'});
  const customerIds=Array.from({length:250},(_,n)=>9300001+n),orderIds=Array.from({length:250},(_,n)=>9301001+n),organizationIds=[9302001,9302002,9302003],callIds=Array.from({length:530},(_,n)=>9303001+n);
  const personaId=9304001,versionId=9304002,adminId=9305001,session='d'.repeat(64),locks=[];
  const endpoints={order:['http://order-app:3002',process.env.CUSTOMER_AUTH_TOKEN],customer:['http://customer-app:3001',process.env.CONSULTATION_AUTH_TOKEN],persona:['http://operations-app:3005',process.env.CONSULTATION_AUTH_TOKEN]};
  t.after(async()=>{
    for(const client of locks){await client.query('ROLLBACK');client.release();}
    for(const db of [mono,cons]){
      await db.query('DELETE FROM unanswered_questions WHERE call_session_seq=ANY($1::int[])',[callIds]);
      await db.query('DELETE FROM recordings WHERE call_session_seq=ANY($1::int[])',[callIds]);
      await db.query('DELETE FROM call_analyses WHERE call_session_seq=ANY($1::int[])',[callIds]);
      await db.query('DELETE FROM call_sessions WHERE call_session_seq=ANY($1::int[])',[callIds]);
    }
    for(const db of [mono,orders])await db.query('DELETE FROM orders WHERE order_seq=ANY($1::int[])',[orderIds]);
    for(const db of [mono,customer]){
      await db.query('DELETE FROM memberships WHERE customer_seq=ANY($1::int[])',[customerIds]);
      await db.query('DELETE FROM organizations WHERE organization_seq=ANY($1::int[])',[organizationIds]);
      await db.query('DELETE FROM customers WHERE customer_seq=ANY($1::int[])',[customerIds]);
    }
    for(const db of [mono,ops]){
      await db.query('DELETE FROM faq_entries WHERE faq_entry_seq IN(9307001,9307002)');
      await db.query('DELETE FROM ai_persona_versions WHERE ai_persona_version_seq=ANY($1::int[])',[[versionId,versionId+1,versionId+2]]);
      await db.query('DELETE FROM ai_personas WHERE ai_persona_seq=$1',[personaId]);
    }
    for(const db of [mono,ops]){
      await db.query('DELETE FROM admin_sessions WHERE admin_user_seq=$1',[adminId]);
      await db.query('DELETE FROM admin_users WHERE admin_user_seq=$1',[adminId]);
    }
    await Promise.all([mono.end(),cons.end(),customer.end(),orders.end(),ops.end()]);
  });
  for(const [kind,[base]]of Object.entries(endpoints))for(let retry=0;;retry++){
    const prefix=kind==='persona'?'operations':kind;
    try{if((await fetch(base+'/'+prefix+'/health/ready')).status===200)break;}catch{}
    assert.ok(retry<100,'reference owner did not start');await delay(100);
  }
  for(const db of [mono,customer]){
    await db.query(`INSERT INTO customers(customer_seq,name,phone_number,status) OVERRIDING SYSTEM VALUE
      SELECT $1::int+n,'가가가가가가가가가가가가가가가가가가가가가가가가가가가가가가'||n,'0106600'||lpad(n::text,4,'0'),CASE WHEN n=1 THEN 'WITHDRAWN' ELSE 'ACTIVE' END FROM generate_series(0,249)n`,[customerIds[0]]);
    for(const [n,id]of organizationIds.entries())await db.query("INSERT INTO organizations(organization_seq,name,status) OVERRIDING SYSTEM VALUE VALUES($1,$2,$3)",[id,'현재 기업 '+n,n?'ACTIVE':'INACTIVE']);
    for(let n=0;n<3;n++)await db.query("INSERT INTO memberships(customer_seq,organization_seq,employee_no,status) VALUES($1,$2,$3,$4)",[customerIds[n===2?3:n],organizationIds[n],'ref-'+n,n?'ACTIVE':'INACTIVE']);
    await db.query('UPDATE customers SET deleted_at=clock_timestamp() WHERE customer_seq=$1',[customerIds[2]]);
    await db.query('UPDATE organizations SET deleted_at=clock_timestamp() WHERE organization_seq=$1',[organizationIds[1]]);
    await db.query('UPDATE memberships SET deleted_at=clock_timestamp() WHERE customer_seq=$1',[customerIds[3]]);
  }
  for(const db of [mono,orders]){
    await db.query(`INSERT INTO orders(order_seq,customer_seq,status,creation_source) OVERRIDING SYSTEM VALUE
      SELECT $1::int+n,$2::int+n,'COLLECTING','AI' FROM generate_series(0,249)n`,[orderIds[0],customerIds[0]]);
    await db.query('UPDATE orders SET deleted_at=clock_timestamp() WHERE order_seq=$1',[orderIds[3]]);
    const lock=await db.connect();await lock.query('BEGIN');await lock.query('SELECT 1 FROM orders WHERE order_seq=$1 FOR KEY SHARE',[orderIds[4]]);locks.push(lock);
    await db.query("UPDATE orders SET created_at=clock_timestamp()-interval '6 years' WHERE order_seq=$1",[orderIds[4]]);
  }
  for(const db of [mono,ops]){
    await db.query('INSERT INTO ai_personas(ai_persona_seq,code) OVERRIDING SYSTEM VALUE VALUES($1,$2)',[personaId,'call-reference-parity']);
    await db.query("INSERT INTO ai_persona_versions(ai_persona_version_seq,ai_persona_seq,version,prompt_text,name,turn_wait_level,status) OVERRIDING SYSTEM VALUE VALUES($1,$2,1,'원본 설정','조회 버전','NORMAL','INACTIVE')",[versionId,personaId]);
  }
  for(const db of [mono,ops]){
    await db.query("INSERT INTO admin_users(admin_user_seq,login_id,name,password_hash,role,status) OVERRIDING SYSTEM VALUE VALUES($1,'refparity','조회 운영자','not-a-login','OPERATOR','ACTIVE')",[adminId]);
    await db.query('INSERT INTO admin_sessions(session_token_hash,admin_user_seq) VALUES($1,$2)',[createHash('sha256').update(session).digest('hex'),adminId]);
  }
  const scenarios=[{order:0,customer:1},{order:1,customer:0},{order:2,customer:0},{order:3,customer:3},{order:4,customer:0},{order:null,customer:0}];
  const provider='reference-'+randomUUID(),seed=callIds.map((id,n)=>{const scenario=scenarios[n]??{order:n%250,customer:(n+1)%250};return{id,n,customer:customerIds[scenario.customer],order:scenario.order===null?null:orderIds[scenario.order]};});
  for(const db of [mono,cons]){
    await db.query(`INSERT INTO call_sessions(call_session_seq,provider_call_id,caller_phone_number,incoming_at,started_at,ended_at,customer_seq,order_seq) OVERRIDING SYSTEM VALUE
      SELECT r.id,$2||'-'||r.n::text,'01066000000',CASE WHEN r.n=5 OR r.n>=260 THEN NULL ELSE '2026-11-01T00:59:59Z'::timestamptz END,
       CASE WHEN r.n IN(3,4,5) OR r.n>=260 THEN NULL WHEN r.n<6 THEN '2026-11-01T01:00:00Z'::timestamptz ELSE '2026-11-01T01:00:00.123000Z'::timestamptz+((r.n*7)%257)*interval '1 microsecond' END,
       CASE WHEN r.n<3 OR r.n BETWEEN 6 AND 259 THEN '2026-11-01T01:03:00Z'::timestamptz ELSE NULL END,r.customer,r."order"
      FROM jsonb_to_recordset($1::jsonb) AS r(id integer,n integer,customer integer,"order" integer)`,[JSON.stringify(seed),provider]);
    await db.query('UPDATE call_sessions SET analysis_failed_at=$2 WHERE call_session_seq=ANY($1::int[])',[[callIds[0],callIds[1]],'2026-11-01T01:05:00Z']);
    await db.query('UPDATE call_sessions SET deleted_at=$2 WHERE call_session_seq=$1',[callIds[528],'2026-11-01T02:00:00Z']);
    const lock=await db.connect();await lock.query('BEGIN');await lock.query('SELECT 1 FROM call_sessions WHERE call_session_seq=$1 FOR KEY SHARE',[callIds[529]]);locks.push(lock);
    await db.query('UPDATE call_sessions SET incoming_at=$2 WHERE call_session_seq=$1',[callIds[529],'2020-01-01T00:00:00Z']);
    for(const n of [0,4])await db.query(`INSERT INTO call_analyses(call_session_seq,ai_persona_version_seq,ai_started_at,ai_ended_at,repeat_question_count,has_complaint,complaints,payload_hash,analysed_at)
      VALUES($1,$2,'2026-11-01T01:00:01Z','2026-11-01T01:02:50Z',1,$3,$4,$5,'2026-11-01T01:04:00Z')`,[callIds[n],versionId,n===4,JSON.stringify(n===4?[{type:'DISSATISFACTION_EXPRESSION',evidenceText:'원본 근거',offsetSeconds:0,utteranceOrders:[1]}]:[]),'a'.repeat(64)]);
    for(let n=0;n<2;n++)await db.query('INSERT INTO recordings(recording_seq,call_session_seq,object_key,created_at) OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4)',[9306001+n,callIds[0],'recordings/reference-'+n+'.wav','2026-11-01T01:04:'+(n?'00':'30')+'Z']);
  }
  const qualityTypes=['INFORMATION_RECOGNITION_ERROR','INTENT_RECOGNITION_ERROR','SLOW_RESPONSE','INTERRUPTION','DISSATISFACTION_EXPRESSION'];
  async function complaintExpected(source,path){
    const customerType=new URL(path,'http://fixture').searchParams.get('customerType')??'ALL';
    // The frozen source supplies unchanged eligibility/coverage; the new criterion is checked in JS, independently of the SQL.
    const rows=(await mono.query(`SELECT a.has_complaint,a.complaints FROM call_sessions c LEFT JOIN call_analyses a USING(call_session_seq)
      WHERE c.deleted_at IS NULL AND(c.incoming_at IS NULL OR c.incoming_at>transaction_timestamp()-interval '5 years')
      AND COALESCE(c.ended_at,a.ai_ended_at) IS NOT NULL
      AND($1='ALL' OR($1='NEW' AND a.is_new_customer IS TRUE)OR($1='EXISTING' AND a.is_new_customer IS FALSE))`,[customerType])).rows;
    const counts=new Map(qualityTypes.map(type=>[type,0]));let complained=0;
    for(const row of rows){
      const found=new Set();
      if(row.has_complaint===true)for(const item of row.complaints??[])
        if(counts.has(item?.type)&&(item.type!=='DISSATISFACTION_EXPRESSION'||item.target==='ai_service'))found.add(item.type);
      if(found.size)complained++;
      for(const type of found)counts.set(type,counts.get(type)+1);
    }
    const total=[...counts.values()].reduce((a,b)=>a+b,0),expected=structuredClone(source);
    Object.assign(expected.data,{complaintCallCount:complained,
      complaintRatePercent:source.data.assessedCallCount?complained*100/source.data.assessedCallCount:null,typeTotalCount:total,
      types:qualityTypes.map(type=>({type,callCount:counts.get(type),sharePercent:total?counts.get(type)*100/total:null}))});
    return expected;
  }
  let apiPairs=0;
  async function get(path,status=200,headers={}){
    const requestId=randomUUID(),responses=[];
    for(const base of ['http://monolith-app:3000','http://consultation-app:3004']){
      const response=await fetch(base+path,{headers:{Cookie:'dva_session='+session,'X-Request-Id':requestId,...headers}});
      const body=await response.json();assert.equal(response.status,status,JSON.stringify(body));
      assert.equal(response.headers.get('cache-control'),'no-store');responses.push(body);
    }
    const expected=status===200&&path.split('?')[0]==='/api/dashboard/complaint-calls'?await complaintExpected(responses[0],path):responses[0];
    assert.deepEqual(responses[1],expected);apiPairs++;return responses[1];
  }
  const ids={order:orderIds,customer:customerIds,persona:[versionId,2147483647]};
  const read=kind=>requestReferences(kind,endpoints[kind][0]+'/internal/call-read-references',endpoints[kind][1],ids[kind]);
  async function compare(){
    const [orderRows,customerRows,versions]=await Promise.all(['order','customer','persona'].map(read));
    const orderMap=new Map(orderRows.map(row=>[row.order_seq,row])),customerMap=new Map(customerRows.map(row=>[row.customer_seq,row]));
    assert.equal(orderRows.length,249);assert.equal(customerRows.length,249);assert.equal(versions.length,1);
    assert.ok(Buffer.byteLength(JSON.stringify(customerRows))>16384);assert.ok(orderMap.has(orderIds[4]),'call detail also shows old undeleted linked orders');
    for(const [n,scenario]of scenarios.entries()){
      const detail=(await get('/api/calls/'+callIds[n])).data,order=orderMap.get(orderIds[scenario.order]),owner=customerMap.get(order?.customer_seq??customerIds[scenario.customer]);
      assert.deepEqual({customerSeq:owner?.customer_seq??null,customerName:owner?.name??null,organizationName:owner?.organization_name??null,orderStatus:order?.status??null,orderTotalAmount:order?.total_amount??null},
        {customerSeq:detail.call.customerSeq,customerName:detail.call.customerName,organizationName:detail.call.organizationName,orderStatus:detail.call.orderStatus,orderTotalAmount:detail.call.orderTotalAmount});
      if(detail.analysis)assert.deepEqual({id:versions[0].ai_persona_version_seq,name:versions[0].name,version:versions[0].version},{id:detail.analysis.aiPersonaVersionSeq,name:detail.analysis.personaName,version:detail.analysis.personaVersion});
    }
  }
  await compare();
  for(const db of [mono,customer])await db.query('UPDATE customers SET name=$2 WHERE customer_seq=$1',[customerIds[0],'변경된 현재 이름 가나다 %_']);
  for(const db of [mono,orders])await db.query("UPDATE orders SET status='notPaid',payment_method_type='cat',total_amount=12000,payment_due_at=clock_timestamp()+interval '1 day' WHERE order_seq=$1",[orderIds[0]]);
  await compare();
  const list=(query={})=>'/api/calls?'+new URLSearchParams({callerPhoneNumber:'01066000000',...query}).toString();
  const first=await get(list());assert.equal(first.total_count,528);assert.equal(first.data.length,20);
  for(const query of [{limit:100},{offset:245,limit:20},{offset:495,limit:30},{offset:99999},{orderSeq:orderIds[0]},
    {organizationSeq:organizationIds[0]},{organizationSeq:organizationIds[1]},{organizationSeq:organizationIds[2]},
    {q:' 가나다 '},{q:'가나다'.normalize('NFD')},{q:'%_'},{q:'%'},{q:'_'},{q:'0106600'},
    {q:'없는 이름'},{q:'   '},{q:'0106600',offset:245},{q:'0106600',offset:495},{q:'0106600',offset:530},
    {orderStatus:'COLLECTING',offset:250,limit:50},{orderStatus:'notPaid'},{hasComplaint:true},{hasComplaint:false},
    {aiPersonaVersionSeq:versionId},{aiPersonaVersionSeq:2147483647},{from:'2026-11-01T01:00:00Z',to:'2026-11-01T01:00:00.123100Z'}])await get(list(query));
  for(const query of [{limit:101},{offset:-1},{organizationSeq:0},{orderStatus:'paid'},{hasComplaint:'0'},
    {aiPersonaVersionSeq:'1.5'},{from:'bad'},{from:'2026-11-02T00:00:00Z',to:'2026-11-01T00:00:00Z'},{extra:'field'}])await get(list(query),400);
  await get(list()+'&q=one&q=two',400);await get(list(),401,{Cookie:''});await get('/api/calls/'+callIds[0],401,{Cookie:''});
  for(const id of [2147483647,callIds[528],callIds[529]])await get('/api/calls/'+id,404);
  for(const id of ['bad',0,-1,2147483648])await get('/api/calls/'+id,400);
  await Promise.all(Array.from({length:5},()=>get(list({q:'0106600',offset:495,limit:30}))));
  for(const db of [mono,ops]){
    for(let n=0;n<2;n++)await db.query(`INSERT INTO faq_entries(faq_entry_seq,question,answer,category,updated_by_admin_user_seq,deleted_at)
      OVERRIDING SYSTEM VALUE VALUES($1,$2,'원본 답변','기타',$3,$4)`,[9307001+n,'목록 참조 '+n,adminId,n?'2026-11-01T02:00:00Z':null]);
  }
  const {requestComplaintFaqs}=require('@dva/events/call-read-references.cjs');
  for(const db of [mono,ops])await db.query('UPDATE faq_entries SET answer=$2 WHERE faq_entry_seq=$1',[9307001,'원본 긴 답변'.repeat(80000)]);
  const faqs=await requestComplaintFaqs('http://operations-app:3005/internal/call-read-references/complaint-faqs',process.env.CONSULTATION_AUTH_TOKEN);
  assert.deepEqual(faqs,(await mono.query('SELECT question,answer FROM faq_entries WHERE deleted_at IS NULL ORDER BY faq_entry_seq')).rows);
  assert.ok(Buffer.byteLength(JSON.stringify(faqs))>1024*1024);
  const complaintEvent={eventId:randomUUID(),source:'consultation',eventType:'ComplaintFaqSnapshotRequested',payload:{}};
  for(const [body,token,status]of [[complaintEvent,'wrong',403],[{...complaintEvent,payload:{limit:10}},process.env.CONSULTATION_AUTH_TOKEN,422]])
    assert.equal((await fetch('http://operations-app:3005/internal/call-read-references/complaint-faqs',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(body)})).status,status);
  const questions=callIds.map((call,n)=>({id:9308001+n,call,eventId:randomUUID(),n}));
  for(const db of [mono,cons])await db.query(`INSERT INTO unanswered_questions(unanswered_question_seq,event_id,call_session_seq,question_text,occurred_at,
    offset_seconds,reason,payload_hash,status,faq_entry_seq,faq_conversion_hash,registered_at,deleted_at) OVERRIDING SYSTEM VALUE
    SELECT r.id,r."eventId"::uuid,r.call,'목록검증 %_ 질문 '||r.n::text,'2026-11-01T01:01:00Z'::timestamptz,
     CASE WHEN r.n%3=0 THEN NULL ELSE r.n END,CASE WHEN r.n%3=0 THEN NULL WHEN r.n%3=1 THEN 'KB_NO_ANSWER' ELSE 'KB_UNAVAILABLE' END,
     repeat('a',64),CASE WHEN r.n=6 THEN 'DELETED' WHEN r.n IN(0,1) THEN 'REGISTERED' ELSE 'OPEN' END,
     CASE WHEN r.n IN(0,1) THEN 9307001+r.n ELSE NULL END,CASE WHEN r.n IN(0,1) THEN repeat('b',64) ELSE NULL END,
     CASE WHEN r.n IN(0,1) THEN '2026-11-01T01:02:00Z'::timestamptz ELSE NULL END,
     CASE WHEN r.n=6 THEN '2026-11-01T02:00:00Z'::timestamptz ELSE NULL END
    FROM jsonb_to_recordset($1::jsonb) AS r(id integer,call integer,"eventId" text,n integer)`,[JSON.stringify(questions)]);
  const unanswered=(query={})=>'/api/unanswered-questions?'+new URLSearchParams(query).toString();
  const open=await get(unanswered({q:'0106600'}));assert.equal(open.total_count,525);
  const all=await get(unanswered({q:'목록검증',status:'ALL'}));assert.equal(all.total_count,527);
  for(const query of [{},{q:'   '},{status:'REGISTERED'},{status:'ALL',q:'0106600',offset:245},{status:'ALL',q:'0106600',offset:495,limit:100},
    {status:'ALL',q:'0106600',offset:99999},{q:'%_'},{q:'목록검증'.normalize('NFD')},{q:'가나다'},{q:'가나다'.normalize('NFD')},
    {q:'없는 질문'},{reason:'KB_NO_ANSWER'},{reason:'KB_UNAVAILABLE'},{reason:'UNCLASSIFIED'},
    {aiPersonaVersionSeq:versionId,status:'ALL'},{unansweredQuestionSeq:9308001,status:'ALL'},{callSessionSeq:callIds[4]},
    {from:'2026-11-01T01:00:00Z',to:'2026-11-01T01:00:00.123100Z',status:'ALL'}])await get(unanswered(query));
  const registered=await get(unanswered({unansweredQuestionSeq:9308001,status:'ALL'}));assert.equal(registered.data[0].faqEntrySeq,9307001);
  const deletedFaq=await get(unanswered({unansweredQuestionSeq:9308002,status:'ALL'}));assert.equal(deletedFaq.data[0].faqEntrySeq,null);
  for(const query of [{status:'DELETED'},{reason:'OTHER'},{unansweredQuestionSeq:0},{callSessionSeq:'1.2'},
    {from:'2026-11-01T00:00:00Z'},{to:'2026-11-01T00:00:00Z'},
    {from:'2026-11-02T00:00:00Z',to:'2026-11-01T00:00:00Z'},{unknown:1},{q:'x\u0000'}])await get(unanswered(query),400);
  await get(unanswered({q:'목록검증'})+'&status=OPEN&status=ALL',400);await get(unanswered(),401,{Cookie:''});
  for(const db of [mono,ops])await db.query("UPDATE faq_entries SET deleted_at='2026-11-01T03:00:00Z' WHERE faq_entry_seq=9307001");
  const nowDeleted=await get(unanswered({unansweredQuestionSeq:9308001,status:'ALL'}));assert.equal(nowDeleted.data[0].faqEntrySeq,null);
  await Promise.all(Array.from({length:5},()=>get(unanswered({q:'목록검증',status:'ALL',offset:495,limit:100}))));
  const statistics=['stage-dropoffs','registration-time','complaint-calls','response-wait'];
  for(const route of statistics)for(const customerType of ['ALL','NEW','EXISTING'])await get('/api/dashboard/'+route+'?customerType='+customerType);
  for(const db of [mono,ops]){
    for(let n=1;n<=2;n++)await db.query(`INSERT INTO ai_persona_versions(ai_persona_version_seq,ai_persona_seq,version,prompt_text,name,turn_wait_level,status)
      OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,'다른 설정',$4,'NORMAL','INACTIVE')`,[versionId+n,personaId,n+1,n===1?'직전 활성':'다른 비활성']);
    await db.query(`UPDATE ai_persona_versions SET status='ACTIVE',application_id=$2,requested_by_admin_user_seq=$3,
      requested_at='2026-11-01T00:00:00Z',applied_at='2026-11-01T00:01:00Z',previous_active_version_seq=$4 WHERE ai_persona_version_seq=$1`,[versionId,randomUUID(),adminId,versionId+1]);
  }
  const complaintTypes=['INFORMATION_RECOGNITION_ERROR','INTENT_RECOGNITION_ERROR','UNSUPPORTED_ANSWER','SLOW_RESPONSE','INTERRUPTION','DISSATISFACTION_EXPRESSION'];
  const complaints=[...complaintTypes,...complaintTypes.slice(0,1),'REPEATED_QUESTION'].map(type=>({type,evidenceText:'보존 근거',offsetSeconds:0,utteranceOrders:[1]}));
  for(const db of [mono,cons]){
    for(let n=524;n<=527;n++)await db.query(`INSERT INTO call_analyses(call_session_seq,ai_persona_version_seq,ai_started_at,ai_ended_at,
      is_new_customer,registered_parcel_count,has_complaint,complaints,payload_hash,analysed_at) VALUES($1,$2,
      '2026-11-01T01:00:00Z','2026-11-01T01:03:00Z',$3,$4,$5,$6,$7,'2026-11-01T01:04:00Z')`,
      [callIds[n],n===524?versionId:n===525?versionId+1:n===527?versionId+2:null,n===526?null:n!==525,n===526?null:n===525?0:2,n===526?null:n===524,JSON.stringify(n===524?complaints:[]),'a'.repeat(64)]);
    await db.query('UPDATE call_analyses SET is_new_customer=true,registered_parcel_count=3 WHERE call_session_seq=$1',[callIds[0]]);
    await db.query('UPDATE call_analyses SET is_new_customer=false,registered_parcel_count=2,ai_persona_version_seq=$2 WHERE call_session_seq=$1',[callIds[4],versionId+1]);
    for(const [n,stage,wait]of [[0,'NONE',100],[4,'FAQ_ANSWER',200000],[524,'ORDER_LOOKUP',500],[525,'NONE',0]])await db.query(`INSERT INTO call_dashboard_metrics(call_session_seq,dropoff_stage,dropoff_payload_hash,dropoff_received_at,
      total_wait_ms,latency_stats,response_wait_payload_hash,response_wait_received_at) VALUES($1,$2,$3,'2026-11-01T01:04:00Z',$4,$5,$3,'2026-11-01T01:04:00Z')`,
      [callIds[n],stage,'c'.repeat(64),wait,JSON.stringify(wait?[{processType:'FAQ_LOOKUP',measurementCount:2,totalLatencyMs:wait}]:[])]);
  }
  const beforeQuality=(await get('/api/dashboard/complaint-calls')).data;
  const metricItem=(type,target)=>({type,evidenceText:'통계 근거 보존',offsetSeconds:0,utteranceOrders:[1],
    ...(target===undefined?{}:{target,level:target===null?null:'mild'})});
  const dsf=target=>metricItem('DISSATISFACTION_EXPRESSION',target);
  const qualityCases=[
    {n:510,items:[dsf('ai_service')],fresh:true},
    {n:511,items:[dsf('price_policy')],fresh:false},
    {n:512,items:[dsf('delivery_other')],fresh:true},
    {n:513,items:[metricItem('UNSUPPORTED_ANSWER')],fresh:false},
    {n:514,items:[dsf(null)],fresh:null},
    {n:515,items:[metricItem(qualityTypes[0]),dsf('price_policy')],fresh:true},
    {n:516,items:[dsf('price_policy'),...qualityTypes.map(type=>metricItem(type,type===qualityTypes[4]?'ai_service':undefined)),metricItem('UNSUPPORTED_ANSWER'),metricItem(qualityTypes[0])],fresh:false},
    {n:517,items:[],fresh:null,assessed:false},
    {n:518,items:[],fresh:true,assessed:false},
    {n:519,items:[],fresh:false,assessed:null},
    {n:528,items:[dsf('ai_service')],fresh:true},
    {n:529,items:[metricItem(qualityTypes[0])],fresh:false},
    {n:520,items:[metricItem(qualityTypes[2])],fresh:true,ended:false},
    {n:521,items:[metricItem('REPEATED_QUESTION')],fresh:true},
  ];
  for(const db of [mono,cons])for(const row of qualityCases)if(row.ended!==false)await db.query(`INSERT INTO call_analyses(call_session_seq,ai_persona_version_seq,ai_started_at,ai_ended_at,
    is_new_customer,has_complaint,complaints,payload_hash,analysed_at) VALUES($1,$2,'2026-11-01T01:00:00Z',$3,$4,$5,$6,$7,'2026-11-01T01:04:00Z')`,
    [callIds[row.n],versionId,row.ended===false?null:'2026-11-01T01:03:00Z',row.fresh,Object.hasOwn(row,'assessed')?row.assessed:true,JSON.stringify(row.items),'a'.repeat(64)]);
  const afterQuality=(await get('/api/dashboard/complaint-calls')).data;
  for(const [key,delta]of Object.entries({endedCallCount:11,assessedCallCount:10,unassessedCallCount:1,unclassifiedCustomerCallCount:2,complaintCallCount:3,typeTotalCount:7,legacyTypeCallCount:1}))
    assert.equal(afterQuality[key]-beforeQuality[key],delta,'MR476 literal fixture delta '+key);
  for(const [i,delta]of [2,1,1,1,2].entries())assert.equal(afterQuality.types[i].callCount-beforeQuality.types[i].callCount,delta,'MR476 unique type counts');
  for(const n of [511,512,513]){
    const detail=(await get('/api/calls/'+callIds[n])).data;
    assert.deepEqual(detail.analysis.complaints,qualityCases.find(row=>row.n===n).items,'reference complaints remain in call detail');
  }
  for(const route of statistics){for(const customerType of ['ALL','NEW','EXISTING'])await get('/api/dashboard/'+route+'?customerType='+customerType);
    for(const query of ['?customerType=OTHER','?customerType=ALL&customerType=NEW','?from=2026-11-01'])await get('/api/dashboard/'+route+query,400);
    await get('/api/dashboard/'+route,401,{Cookie:''});}
  const registration=(await get('/api/dashboard/registration-time')).data;
  assert.equal(registration.comparison.current.aiPersonaVersionSeq,versionId);assert.equal(registration.comparison.previous.aiPersonaVersionSeq,versionId+1);
  assert.ok(registration.registeredParcelCount>registration.comparison.current.registeredParcelCount+registration.comparison.previous.registeredParcelCount,'other historical versions contribute only to the overall total');
  const complaint=(await get('/api/dashboard/complaint-calls')).data;assert.ok(complaint.legacyTypeCallCount>=1);assert.equal(complaint.types.length,5);
  assert.ok((await get('/api/dashboard/response-wait')).data.invalidWaitCallCount>=1);
  for(const db of [mono,ops])await db.query('UPDATE ai_persona_versions SET previous_active_version_seq=NULL WHERE ai_persona_version_seq=$1',[versionId]);
  assert.equal((await get('/api/dashboard/registration-time')).data.comparison.previous,null);
  for(const db of [mono,ops])await db.query("UPDATE ai_persona_versions SET status='INACTIVE' WHERE ai_persona_version_seq=$1",[versionId]);
  const noActive=(await get('/api/dashboard/registration-time')).data;assert.equal(noActive.comparison.current,null);assert.equal(noActive.comparison.previous,null);
  const docs=await Promise.all(['http://monolith-app:3000','http://consultation-app:3004'].map(async base=>(await fetch(base+'/api/docs-json')).json()));
  for(const path of ['/api/calls','/api/calls/{id}','/api/unanswered-questions'])assert.deepEqual(docs[1].paths[path],docs[0].paths[path]);
  for(const name of ['CallDto','CallListItemDto','CallListResponseDto','CallDetailDto','CallDetailResponseDto','CallAnalysisDto','CallComplaintDto','RecordingDto','UnansweredQuestionDto','UnansweredQuestionListResponseDto']){
    assert.ok(docs[0].components.schemas[name],name+' missing in source');
    const expected=structuredClone(docs[0].components.schemas[name]);
    // MR !476 adds these two fields; every other frozen source schema remains exact.
    if(name==='CallComplaintDto')Object.assign(expected.properties,{
      target:{type:'string',enum:['ai_service','price_policy','delivery_other'],nullable:true,description:'고객 불만 책임 대상. 다른 유형은 null.'},
      level:{type:'string',enum:['explicit','mild'],nullable:true,description:'고객 불만 강도. 다른 유형은 null.'},
    });
    assert.deepEqual(docs[1].components.schemas[name],expected,name);
  }
  for(const route of statistics){
    const expected=structuredClone(docs[0].paths['/api/dashboard/'+route]);
    if(route==='complaint-calls')expected.get.description='판정 완료 통화가 분모입니다. AI 응대 오류 4유형과 ai_service 고객 불만만 품질 비율·5유형 도넛에 포함합니다. 같은 통화·같은 유형은 한 번 집계합니다. 다른 책임의 불만·근거 없는 답변은 통화 목록/상세 참고이며 과거 유형 건수도 운영 참고로 제공합니다. RAG/미답변 사유와 독립적입니다.';
    assert.deepEqual(docs[1].paths['/api/dashboard/'+route],expected);
  }
  for(const name of Object.keys(docs[0].components.schemas).filter(name=>/^(StageDropoff|RegistrationTime|PersonaRegistrationTime|ComplaintCalls|ComplaintType|ResponseWait|ProcessLatency)/.test(name))){
    const expected=structuredClone(docs[0].components.schemas[name]);
    if(name==='ComplaintTypeSummaryDto')expected.properties.type.enum=qualityTypes;
    if(name==='ComplaintCallsDto'){
      expected.properties.typeTotalCount.description='AI 응대 오류 4유형과 ai_service 고객 불만의 통화 수 합계. 한 통화의 여러 유형은 각각 포함.';
      expected.properties.legacyTypeCallCount.description='표준 분류 전의 기존 유형이 있는 통화 수. 운영 참고이며 AI 품질 비율에서 제외.';
    }
    assert.deepEqual(docs[1].components.schemas[name],expected,name);
  }
  assert.deepEqual(await requestReferences('faq','http://operations-app:3005/internal/call-read-references/faqs',process.env.CONSULTATION_AUTH_TOKEN,[9307001,9307002]),[]);
  assert.equal((await fetch('http://operations-app:3005/internal/call-read-references/faqs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})})).status,403);
  await Promise.all(Array.from({length:5},()=>Promise.all(['order','customer','persona'].map(read))));
  for(const [kind,[base,token]]of Object.entries(endpoints)){
    const event={eventId:randomUUID(),source:'consultation',eventType:'CallReadReferencesRequested',payload:{ids:ids[kind]}};
    const post=(body,authorization='Bearer '+token,path='/internal/call-read-references')=>fetch(base+path,{method:'POST',headers:{Authorization:authorization,'Content-Type':'application/json'},body:JSON.stringify(body)});
    for(const authorization of ['', 'Bearer wrong','Bearer '+(kind==='order'?process.env.CONSULTATION_AUTH_TOKEN:process.env.CUSTOMER_AUTH_TOKEN)])assert.equal((await post(event,authorization)).status,403);
    for(const changed of [{...event,source:'customer'},{...event,payload:{ids:[]}},{...event,payload:{ids:[1,1]}},{...event,payload:{ids:Array.from({length:251},(_,n)=>n+1)}}])assert.equal((await post(changed)).status,422);
    assert.equal((await post(event,'Bearer '+token,'/api/internal/call-read-references')).status,404);
    assert.ok(!Object.keys((await(await fetch(base+'/api/docs-json')).json()).paths).some(path=>path.includes('call-read-references')));
  }
  for(const db of [customer,orders,ops])assert.equal((await db.query("SELECT count(*)::int n FROM inbox_events WHERE event_type='CallReadReferencesRequested'")).rows[0].n,0);
  t.diagnostic(`call, unanswered and dashboard HTTP pairs: ${apiPairs}; current owner joins, FAQ deletion, pagination and all four original metric SQL paths including actual ACTIVE/previous persona selection`);

  const intakePath = '/api/calls/{id}/order-intake';
  assert.deepEqual(docs[1].paths[intakePath].get, docs[0].paths[intakePath].get);
  for (const name of ['OrderIntakeResponseDto', 'ParcelConversionDto', 'OrderResultDto',
    'OrderPaymentRequestDto', 'RequestMetaDto', 'ErrorResponseDto']) {
    assert.deepEqual(docs[1].components.schemas[name], docs[0].components.schemas[name], name);
  }

  const intakeCases = [
    { status: 'COLLECTING' },
    { status: 'WAITING_AI', ended: true },
    { status: 'WAITING_PBX', sealed: true },
    { status: 'FINALIZING', ended: true, sealed: true },
    { status: 'FAILED', ended: true, sealed: true, error: 'DEPENDENCY_UNAVAILABLE' },
    { status: 'NO_ORDER', ended: true, sealed: true, orderSeq: null },
    { status: 'FINALIZED', ended: true, sealed: true, orderSeq: orderIds[0] },
    { status: 'FINALIZED', ended: true, sealed: true, orderSeq: orderIds[3] },
    { status: 'FINALIZED', ended: true, sealed: true, orderSeq: orderIds[4] },
    { status: 'FINALIZED', ended: true, sealed: true, orderSeq: 2147483647 },
    { enabled: false },
  ].map((value, index) => ({
    ...value, id: callIds[20 + index], version: index + 7,
    mappings: value.orderSeq ? [{ draftSeq: 111, orderParcelSeq: 222 }] : [],
  }));
  const payment = randomUUID(), live = intakeCases[6];
  const endedAt = '2026-11-01T01:03:00.000Z', sealedAt = '2026-11-01T01:02:00.000Z';
  const finalizedAt = '2026-11-01T01:04:00.000Z', dueAt = '2032-01-03T00:00:00.000Z';
  const intakeStart = apiPairs;
  const pathFor = id => '/api/calls/' + id + '/order-intake';
  const ai = { Cookie: '', Authorization: 'Bearer ' + process.env.PGPASSWORD };
  for (const db of [mono,cons]) for (const value of intakeCases) {
    const result = value.orderSeq === undefined
      ? null : JSON.stringify({ orderSeq: value.orderSeq, parcelMappings: value.mappings });
    await db.query(`UPDATE call_sessions SET order_intake_enabled=$2,order_intake_version=$3,
      started_at=CASE WHEN $4::timestamptz IS NULL THEN NULL ELSE incoming_at END,ended_at=$4,
      order_completion_received_at=$5,order_completion_payload=CASE WHEN $5::timestamptz IS NULL THEN NULL ELSE '{}'::jsonb END,
      order_finalization_result=$6::jsonb,order_finalized_at=$7,order_finalization_error_code=$8,
      order_finalization_attempted_at=clock_timestamp()+interval '1 day' WHERE call_session_seq=$1`,
    [value.id, value.enabled !== false, value.version, value.ended ? endedAt : null,
      value.sealed ? sealedAt : null, result, result === null ? null : finalizedAt, value.error ?? null]);
  }
  const snapshotIntake = async () => (await Promise.all([
    ...[mono,cons].map(db => db.query('SELECT to_jsonb(c) AS row FROM call_sessions c WHERE call_session_seq=ANY($1::int[]) ORDER BY call_session_seq', [intakeCases.map(value => value.id)])),
    ...[mono,orders].map(db => db.query('SELECT to_jsonb(o) AS row FROM orders o WHERE order_seq=$1', [live.orderSeq])),
    ...[mono,orders].map(db => db.query('SELECT to_jsonb(r) AS row FROM order_payment_requests r WHERE payment_request_id=$1', [payment])),
  ])).map(result => result.rows);
  try {
    for (const db of [mono,orders]) {
      await db.query('UPDATE orders SET payment_due_at=$2 WHERE order_seq=$1', [live.orderSeq,dueAt]);
      await db.query("INSERT INTO order_payment_requests(payment_request_id,order_seq,amount,expires_at,notification_status) VALUES($1,$2,12000,$3,'UNKNOWN')",
        [payment,live.orderSeq,dueAt]);
    }
    const before = await snapshotIntake();
    for (const value of intakeCases) {
      const body = await get(pathFor(value.id), value.enabled === false ? 409 : 200);
      if (value.enabled === false) continue;
      const data = body.data;
      assert.equal(data.status,value.status);
      assert.equal(data.intakeVersion,value.version);
      assert.equal(data.endedAt,value.ended ? endedAt : null);
      assert.equal(data.completionReceivedAt,value.sealed ? sealedAt : null);
      assert.equal(data.finalizedAt,value.orderSeq === undefined ? null : finalizedAt);
      assert.equal(data.errorCode,value.error ?? null);
      assert.equal(data.orderSeq,value.orderSeq ?? null);
      assert.deepEqual(data.parcelMappings,value.mappings);
      if (value !== live) assert.equal(data.order,null);
      else {
        assert.equal(data.order.callSessionSeq,live.id);
        assert.equal(data.order.status,'notPaid');
        assert.equal(data.order.paymentDueAt,dueAt);
        assert.equal(data.order.paymentRequest.paymentRequestId,payment);
        assert.equal(data.order.paymentRequest.notificationStatus,'UNKNOWN');
      }
    }
    await get(pathFor(live.id),200,ai);
    await get(pathFor(live.id),200,{...ai,call_session_seq:'0'+live.id});
    await get(pathFor(live.id),200,{call_session_seq:'ignored for admin'});
    for (const authorization of ['', 'Bearer wrong'])
      await get(pathFor(live.id),401,{Cookie:'',Authorization:authorization});
    await get(pathFor(live.id),401,{...ai,Cookie:'dva_session=bad'});
    await get(pathFor(live.id),403,{...ai,call_session_seq:String(intakeCases[0].id)});
    for (const header of ['', '0', 'invalid', '2147483648'])
      await get(pathFor(live.id),400,{...ai,call_session_seq:header});
    for (const id of [callIds[5],callIds[528],callIds[529],2147483647])
      await get(pathFor(id),404);
    await get(pathFor('invalid'),400,ai);

    const orderLock = await orders.connect();
    let pending;
    try {
      await orderLock.query('BEGIN');
      await orderLock.query("SET LOCAL lock_timeout='2s'");
      await orderLock.query('LOCK TABLE order_payment_requests IN ACCESS EXCLUSIVE MODE');
      pending = get(pathFor(live.id),200,ai);
      pending.catch(() => {});
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i++) {
        waiting = (await orders.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE wait_event_type='Lock' AND query LIKE 'SELECT order_seq AS "orderSeq",version,status,%') AS waiting`)).rows[0].waiting;
        if (!waiting) await delay(20);
      }
      assert.ok(waiting,'intake request did not reach the locked order read');
      await assert.rejects(cons.query('SELECT 1 FROM call_sessions WHERE call_session_seq=$1 FOR UPDATE NOWAIT',[live.id]),
        error => error.code === '55P03');
    } finally {
      await orderLock.query('ROLLBACK');
      orderLock.release();
      if (pending) await pending;
    }
    assert.deepEqual(await snapshotIntake(),before);

    for (const db of [mono,orders]) {
      await db.query('UPDATE order_payment_requests SET invalidated_at=$2 WHERE payment_request_id=$1',[payment,finalizedAt]);
      await db.query("UPDATE orders SET status='ACCEPTED',parcel_no='INTAKE01',dver_received_at=$2,pickup_requested_at=$2,version=version+1 WHERE order_seq=$1",
        [live.orderSeq,finalizedAt]);
    }
    const accepted = (await get(pathFor(live.id))).data;
    assert.equal(accepted.order.status,'ACCEPTED');
    assert.equal(accepted.order.parcelNo,'INTAKE01');
    assert.equal(accepted.order.paymentRequest,null);
    assert.deepEqual(accepted.parcelMappings,live.mappings);

    const event = { eventId:randomUUID(), source:'consultation', eventType:'OrderIntakeResultReadRequested',
      payload:{orderSeq:live.orderSeq,callSessionSeq:live.id} };
    const privateRead = (body, token) => fetch(endpoints.order[0]+'/internal/order-intake-result',
      {method:'POST',headers:{'Content-Type':'application/json',Authorization:token},body:JSON.stringify(body)});
    assert.equal((await privateRead(event,'Bearer wrong')).status,403);
    for (const invalid of [{...event,source:'customer'}, {...event,payload:{...event.payload,orderSeq:0}},
      {...event,payload:{...event.payload,extra:true}}]) {
      assert.equal((await privateRead(invalid,'Bearer '+endpoints.order[1])).status,422);
    }
    const replay = await privateRead(event,'Bearer '+endpoints.order[1]);
    assert.equal(replay.status,200);
    assert.deepEqual(await replay.json(),{eventId:event.eventId,status:'processed',payload:accepted.order});
    assert.equal((await orders.query("SELECT count(*)::int AS n FROM inbox_events WHERE event_type='OrderIntakeResultReadRequested'")).rows[0].n,0);
  } finally {
    for (const db of [mono,orders]) await db.query('DELETE FROM order_payment_requests WHERE payment_request_id=$1',[payment]);
  }
  t.diagnostic(`order intake HTTP pairs: ${apiPairs-intakeStart}; seven states, request authentication, retention, payment and held call lock`);
});
