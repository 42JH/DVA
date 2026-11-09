const { truncateFixture } = require('./fixture-reset.cjs');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID,createHash}=require('node:crypto');
const {request:httpRequest}=require('node:http');
const {fork}=require('node:child_process');
const {once}=require('node:events');
const {Pool}=require('pg');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const body=(providerCallId,changes={})=>({providerCallId,startedAt:'2026-11-01T10:00:00+09:00',endedAt:'2026-11-01T10:03:00+09:00',
  aiPersonaVersionSeq:null,repeatQuestionCount:2,hasComplaint:true,
  complaints:[{type:'REPEATED_QUESTION',evidenceText:' 원본 근거 보존\n',offsetSeconds:31,utteranceOrders:[4,2]}],...changes});
const stage=(providerCallId,dropoffStage='NONE')=>({providerCallId,dropoffStage});
const wait=(providerCallId,changes={})=>({providerCallId,totalWaitMs:12000,latencyStats:[
  {processType:'ORDER_SAVE',totalLatencyMs:8000,measurementCount:2},
  {processType:'CUSTOMER_LOOKUP',totalLatencyMs:4000,measurementCount:1}],...changes});

test('production analysis and metrics match the unchanged monolith and preserve split references',async t=>{
  assert.equal(process.env.PGDATABASE,'dva_webhook_test');
  const begun=Date.now(),token=process.env.AI_INSIGHTS_TOKEN,origin='http://localhost:5173';
  const mono=new Pool({host:'monolith-db',user:'monolith_app'}),cons=new Pool({host:'consultation-db',user:'consultation_app'}),ops=new Pool({host:'operations-db',user:'operations_app'});
  // The source readiness also probes the external AI app, absent from this API-input fixture.
  const sides=[{base:'http://monolith-app:3000',db:mono,identity:mono,health:'/health'},
    {base:'http://consultation-app:3004',db:cons,identity:ops,health:'/consultation/health/ready'}];
  const expiryFixtures=[];
  t.after(async()=>{for(const fixture of expiryFixtures){await fixture.query('ROLLBACK');fixture.release();}await Promise.all([mono.end(),cons.end(),ops.end()]);});
  for(const side of sides)for(let retry=0;;retry++){
    try{if((await fetch(side.base+side.health)).status===200)break;}catch{}
    assert.ok(retry<60,'production app did not start');await delay(250);
  }
  const sessionToken='b'.repeat(64),cookie='dva_session='+sessionToken,requestIds=new Set(),equivalentRequests=new Map();
  for(const side of sides){
    await truncateFixture(side.db, 'TRUNCATE call_sessions RESTART IDENTITY CASCADE');
    // The preceding PBX fixture seeds admin 1 with OVERRIDING SYSTEM VALUE.
    await side.identity.query("SELECT setval(pg_get_serial_sequence('admin_users','admin_user_seq'),GREATEST(COALESCE(max(admin_user_seq),1),1),true) FROM admin_users");
    const admin=(await side.identity.query(`INSERT INTO admin_users(login_id,name,password_hash,role,status)
      VALUES('anlparity','분석 운영자','not-a-login','OPERATOR','ACTIVE') RETURNING admin_user_seq`)).rows[0].admin_user_seq;
    side.adminId=admin;
    await side.identity.query('INSERT INTO admin_sessions(session_token_hash,admin_user_seq) VALUES($1,$2)',[createHash('sha256').update(sessionToken).digest('hex'),admin]);
    await side.identity.query(`INSERT INTO ai_personas(code) VALUES('analysis-parity')`);
    await side.identity.query(`INSERT INTO ai_persona_versions(ai_persona_version_seq,ai_persona_seq,version,prompt_text,name,turn_wait_level,status)
      OVERRIDING SYSTEM VALUE SELECT 900001,ai_persona_seq,1,'실제 설정 원문','실제 버전','NORMAL','INACTIVE' FROM ai_personas WHERE code='analysis-parity'`);
  }
  const normalize=value=>{
    if(value instanceof Date){assert.ok(value.getTime()>=begun-2000&&value.getTime()<=Date.now()+1000,'receipt time in request window');return'<receipt>';}
    if(Array.isArray(value))return value.map(normalize);
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,normalize(item)]));
    return value;
  };
  async function snapshot(side){
    const analysis=(await side.db.query(`SELECT call_session_seq,ai_persona_version_seq,ai_started_at::text,ai_ended_at::text,
      repeat_question_count,has_complaint,complaints,payload_hash,analysed_at,is_new_customer,registered_parcel_count,faq_answer_count,
      order_lookup_count,cancelled_parcel_count,has_handoff_request,has_callback_request FROM call_analyses ORDER BY call_session_seq`)).rows;
    const metrics=(await side.db.query('SELECT * FROM call_dashboard_metrics ORDER BY call_session_seq')).rows;
    const calls=(await side.db.query(`SELECT call_session_seq,provider_call_id,caller_phone_number,incoming_at::text,registered_at::text,
      started_at::text,ended_at::text,deleted_at::text FROM call_sessions ORDER BY call_session_seq`)).rows;
    // Provisional audit allocation can leave sequence gaps; compare all business audit fields.
    const audit=(await side.identity.query(`SELECT actor_type,actor_seq,actor_name,action,target_type,target_seq,target_admin_name,request_id,result,metadata,occurred_at
      FROM audit_logs WHERE request_id=ANY($1::uuid[]) ORDER BY request_id,action,result`,[[...requestIds]])).rows;
    for(const row of audit)if(row.actor_seq!==null){assert.equal(row.actor_seq,side.adminId);row.actor_seq='<verified-admin>';}
    // Equivalent parallel retries may elect different HTTP winners on independent databases.
    for(const row of audit)if(equivalentRequests.has(row.request_id))row.request_id=equivalentRequests.get(row.request_id);
    const key=row=>[row.request_id,row.action,row.result,row.target_seq].join('|');
    audit.sort((a,b)=>key(a)<key(b)?-1:key(a)>key(b)?1:0);
    return normalize({analysis,metrics,calls,audit});
  }
  async function compare(){assert.deepEqual(await snapshot(sides[1]),await snapshot(sides[0]));}
  let requests=0;
  async function post(id,section,input,status,options={}){
    const requestId=randomUUID();requestIds.add(requestId);
    if(options.concurrent)equivalentRequests.set(requestId,`concurrent:${id}/${section}`);
    const responses=[];
    for(const side of sides){
      const response=await fetch(`${side.base}/api/ai/calls/${id}/${section}`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),
        headers:{'Content-Type':'application/json','X-Request-Id':requestId,Authorization:'Bearer '+token,...options.headers},body:JSON.stringify(input)});
      const text=await response.text();assert.equal(response.status,status,section+' '+text);
      if(status===204)assert.equal(text,'');
      responses.push({body:text?JSON.parse(text):null,cache:response.headers.get('cache-control'),id:response.headers.get('x-request-id')});
    }
    assert.deepEqual(responses[1],responses[0]);assert.equal(responses[0].cache,'no-store');
    assert.equal(responses[0].id,requestId);requests++;
    if(!options.concurrent)await compare();
  }
  async function call(extra={}){
    const provider='analysis-'+randomUUID(),ids=[];
    for(const side of sides)ids.push((await side.db.query(`INSERT INTO call_sessions(provider_call_id,caller_phone_number,incoming_at,started_at,ended_at,deleted_at,registered_at)
      VALUES($1,'01012345678',$2,$3,$4,$5,'2026-11-01T01:00:00Z') RETURNING call_session_seq`,[provider,'2026-11-01T01:00:00Z',
      extra.fallback?null:'2026-11-01T01:00:00Z',extra.fallback?null:'2026-11-01T01:03:00Z',extra.deleted??null])).rows[0].call_session_seq);
    // Keep foreground expiry fixtures stable while production retention uses FOR UPDATE SKIP LOCKED.
    if(extra.incoming)for(const [index,side]of sides.entries()){
      const fixture=await side.db.connect();expiryFixtures.push(fixture);await fixture.query('BEGIN');
      await fixture.query('SELECT 1 FROM call_sessions WHERE call_session_seq=$1 FOR KEY SHARE',[ids[index]]);
      await side.db.query('UPDATE call_sessions SET incoming_at=$2 WHERE call_session_seq=$1',[ids[index],extra.incoming]);
    }
    assert.equal(ids[0],ids[1]);return{id:ids[0],provider};
  }
  const c=await call();
  for(const [section,input]of[['analysis',body(c.provider)],['stage-metrics',stage(c.provider)],['response-wait-metrics',wait(c.provider)]]){
    for(const headers of [{Authorization:''},{Authorization:'Bearer wrong'},{Authorization:'Bearer '+token+', Bearer '+token},
      {Authorization:'',Cookie:cookie,Origin:origin}])await post(c.id,section,input,401,{headers});
    await post(c.id,section,input,403,{headers:{Cookie:cookie}});
    await post(c.id,section,input,401,{headers:{Cookie:'dva_session=invalid',Origin:origin}});
    for(const id of ['abc',0,-1,2147483648])await post(id,section,input,400);
    await post(2147483647,section,input,404);
    await post(c.id,section,{...input,providerCallId:'wrong-call'},403);
    const duplicateId=randomUUID();requestIds.add(duplicateId);
    const statuses=await Promise.all(sides.map(side=>new Promise((resolve,reject)=>{
      const request=httpRequest(`${side.base}/api/ai/calls/${c.id}/${section}`,{method:'POST',headers:{'X-Request-Id':duplicateId,Authorization:['Bearer '+token,'Bearer '+token]}},
        response=>{response.resume();response.once('end',()=>resolve(response.statusCode));});request.once('error',reject);request.end();
    })));
    assert.deepEqual(statuses,[401,401]);
    requests++;await compare();
  }
  await post(c.id,'stage-metrics',stage(c.provider),409);
  await post(c.id,'response-wait-metrics',wait(c.provider),409);
  await post(c.id,'analysis',body(c.provider,{aiPersonaVersionSeq:2147483647}),404);
  for(const changes of [{providerCallId:'x\u0000y'},{result:'REGISTERED'},{registeredParcelCount:'1'},
    {hasComplaint:false},{hasComplaint:null},{hasComplaint:true,complaints:[]}])await post(c.id,'analysis',body(c.provider,changes),400);
  await post(c.id,'analysis',body(c.provider,{endedAt:'2026-11-01T09:59:59+09:00'}),422);
  const full=body(c.provider,{aiPersonaVersionSeq:900001,isNewCustomer:false,registeredParcelCount:0,faqAnswerCount:2,orderLookupCount:1,
    cancelledParcelCount:0,hasHandoffRequest:true,hasCallbackRequest:false});
  await post(c.id,'analysis',full,204,{headers:{Cookie:cookie,Origin:origin}});
  await post(c.id,'analysis',{...full,startedAt:'2026-11-01T01:00:00.000Z',endedAt:'2026-11-01T01:03:00Z',
    complaints:[{...full.complaints[0],utteranceOrders:[2,4]}]},204);
  await post(c.id,'analysis',{...full,repeatQuestionCount:3},409);
  for(const side of sides)await assert.rejects(side.identity.query('DELETE FROM ai_persona_versions WHERE ai_persona_version_seq=900001'),{code:'23503'});
  await post(c.id,'response-wait-metrics',wait(c.provider,{totalWaitMs:180001}),422);
  for(const changes of [{totalWaitMs:'0'},{totalWaitMs:-1},{p95:1},{latencyStats:[null]},
    {latencyStats:[wait(c.provider).latencyStats[0],wait(c.provider).latencyStats[0]]}])
    await post(c.id,'response-wait-metrics',wait(c.provider,changes),400);
  for(const changes of [{dropoffStage:null},{dropoffStage:'BAD'},{enteredStages:[]}])await post(c.id,'stage-metrics',{...stage(c.provider),...changes},400);
  await post(c.id,'response-wait-metrics',wait(c.provider),204);
  await post(c.id,'stage-metrics',stage(c.provider,'RECIPIENT_INFO'),204);
  await post(c.id,'response-wait-metrics',wait(c.provider,{latencyStats:wait(c.provider).latencyStats.toReversed()}),204);
  await post(c.id,'stage-metrics',stage(c.provider,'ITEM_INFO'),409);
  await post(c.id,'response-wait-metrics',wait(c.provider,{totalWaitMs:11000}),409);
  for(const side of sides)await side.db.query("UPDATE call_sessions SET ended_at=started_at+interval '5 seconds' WHERE call_session_seq=$1",[c.id]);
  await post(c.id,'response-wait-metrics',wait(c.provider),204);
  const fallback=await call({fallback:true});
  await post(fallback.id,'analysis',body(fallback.provider,{hasComplaint:null,complaints:[],repeatQuestionCount:null}),204);
  await post(fallback.id,'analysis',body(fallback.provider,{hasComplaint:null,complaints:[],repeatQuestionCount:null,
    isNewCustomer:null,hasCallbackRequest:null}),204);
  await post(fallback.id,'response-wait-metrics',wait(fallback.provider,{totalWaitMs:180001}),422);
  await post(fallback.id,'response-wait-metrics',wait(fallback.provider,{totalWaitMs:0,latencyStats:[]}),204);
  for(const extra of [{incoming:'2020-01-01T00:00:00Z'},{deleted:'2026-11-01T02:00:00Z'}]){
    const hidden=await call(extra);
    for(const [section,input]of[['analysis',body(hidden.provider)],['stage-metrics',stage(hidden.provider)],['response-wait-metrics',wait(hidden.provider)]])
      await post(hidden.id,section,input,404);
  }
  const concurrent=await call();
  await Promise.all(Array.from({length:8},()=>post(concurrent.id,'analysis',body(concurrent.provider,{aiPersonaVersionSeq:900001}),204,{concurrent:true})));
  await Promise.all(Array.from({length:6},()=>Promise.all([
    post(concurrent.id,'stage-metrics',stage(concurrent.provider),204,{concurrent:true}),
    post(concurrent.id,'response-wait-metrics',wait(concurrent.provider),204,{concurrent:true})])));
  await compare();
  assert.deepEqual((await ops.query('SELECT committed FROM consultation_persona_references WHERE call_session_seq=$1',[concurrent.id])).rows,[{committed:true}]);
  for(const side of sides)assert.equal((await side.identity.query(`SELECT count(*) FROM audit_logs WHERE request_id=ANY($1::uuid[]) AND target_seq=$2 AND result='SUCCESS'`,[[...requestIds],concurrent.id])).rows[0].count,'3');
  const failed=await call();
  for(const side of sides)await side.identity.query(`CREATE FUNCTION fail_analysis_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.target_type='CALL_SESSION' AND NEW.target_seq=${failed.id} AND NEW.action='CALL_ANALYSIS_RECORDED' AND NEW.result='SUCCESS'
    THEN RAISE EXCEPTION 'test-only audit failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_analysis_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_analysis_audit();`);
  try{await post(failed.id,'analysis',body(failed.provider,{aiPersonaVersionSeq:900001}),500);}
  finally{for(const side of sides)await side.identity.query('DROP TRIGGER fail_analysis_audit ON audit_logs; DROP FUNCTION fail_analysis_audit();');}
  for(const side of sides)assert.equal((await side.db.query('SELECT count(*) FROM call_analyses WHERE call_session_seq=$1',[failed.id])).rows[0].count,'0');
  await post(failed.id,'analysis',body(failed.provider),204);
  await compare();
  const docs=await Promise.all(sides.map(async side=>(await fetch(side.base+'/api/docs-json')).json()));
  for(const suffix of ['analysis','stage-metrics','response-wait-metrics']){
    const path='/api/ai/calls/{id}/'+suffix;
    assert.deepEqual(docs[1].paths[path],docs[0].paths[path]);
  }
  assert.ok(!Object.keys(docs[1].paths).some(path=>path.includes('/internal/')));
  t.diagnostic(`production HTTP comparisons: ${requests}; source and split business rows, hashes and unfiltered request audits match`);

  const privateQuery={eventId:randomUUID(),source:'consultation',eventType:'PersonaVersionRequested',payload:{versionSeq:900001,callSessionSeq:c.id,transactionId:randomUUID()}};
  const query=async(event,credential=process.env.CONSULTATION_AUTH_TOKEN)=>fetch('http://operations-app:3005/internal/persona-version',{
    method:'POST',headers:{Authorization:'Bearer '+credential,'Content-Type':'application/json'},body:JSON.stringify(event)});
  assert.equal((await query(privateQuery,process.env.CUSTOMER_AUTH_TOKEN)).status,403);
  assert.equal((await query({...privateQuery,source:'customer'})).status,422);
  assert.equal((await query({...privateQuery,payload:{...privateQuery.payload,versionSeq:'900001'}})).status,422);
  assert.equal((await(await query(privateQuery)).json()).payload.exists,true);
  for(const side of sides)assert.equal((await side.db.query("SELECT to_regclass('ai_persona_versions') AS name")).rows[0].name,side===sides[0]?'ai_persona_versions':null);
  const eventHeaders={Authorization:'Bearer '+process.env.CONSULTATION_AUTH_TOKEN,'Content-Type':'application/json'};
  for(const audit of [
    {actorId:null,actorType:'AI',action:'CUSTOMER_UPDATED',targetId:1},
    {actorId:null,actorType:'SYSTEM',action:'CALL_ANALYSIS_RECORDED',targetId:1},
    {actorId:null,actorType:'AI',action:'CALL_DROPOFF_RECORDED',targetId:null}]){
    const response=await fetch('http://operations-app:3005/internal/events',{method:'POST',headers:eventHeaders,body:JSON.stringify({
      eventId:randomUUID(),source:'consultation',eventType:'AuditPrepared',payload:{transactionId:randomUUID(),occurredAt:new Date().toISOString(),result:'SUCCESS',
        audit:{...audit,targetType:'CALL_SESSION',requestId:randomUUID()}}})});assert.equal(response.status,422);
  }
  async function until(check,message){for(let retry=0;;retry++){if(await check())return;assert.ok(retry<100,message);await delay(100);}}
  let version=900002;
  const children=new Set();
  t.after(()=>{for(const child of children)child.kill('SIGKILL');});
  async function childFixture(mode){
    const versionSeq=version++;
    await ops.query(`INSERT INTO ai_persona_versions(ai_persona_version_seq,ai_persona_seq,version,prompt_text,name,turn_wait_level,status)
      OVERRIDING SYSTEM VALUE SELECT $1,ai_persona_seq,$2,'실제 설정','복구 버전','NORMAL','INACTIVE' FROM ai_personas WHERE code='analysis-parity'`,[versionSeq,versionSeq]);
    const provider='analysis-crash-'+randomUUID(),id=(await cons.query(`INSERT INTO call_sessions(provider_call_id,caller_phone_number,incoming_at)
      VALUES($1,'01011112222',now()) RETURNING call_session_seq`,[provider])).rows[0].call_session_seq,requestId=randomUUID();
    const child=fork(require.resolve('./analysis-claimant.cjs'),[],{env:{...process.env,ANALYSIS_CRASH_PAYLOAD:JSON.stringify({mode,id,input:body(provider,{aiPersonaVersionSeq:versionSeq}),requestId})},stdio:['ignore','pipe','pipe','ipc']});
    children.add(child);child.once('exit',()=>children.delete(child));
    const [ready]=await once(child,'message',{signal:AbortSignal.timeout(15000)});assert.deepEqual(ready,{ready:true});
    return{child,id,provider,requestId,versionSeq};
  }
  const race=await childFixture('read');
  await assert.rejects(ops.query('DELETE FROM ai_persona_versions WHERE ai_persona_version_seq=$1',[race.versionSeq]),{code:'23503'});
  const outcome=once(race.child,'message',{signal:AbortSignal.timeout(15000)});race.child.send('resume');
  assert.deepEqual((await outcome)[0],{status:204});await once(race.child,'exit');
  assert.equal((await cons.query('SELECT count(*) FROM call_analyses WHERE call_session_seq=$1',[race.id])).rows[0].count,'1');
  await assert.rejects(ops.query('DELETE FROM ai_persona_versions WHERE ai_persona_version_seq=$1',[race.versionSeq]),{code:'23503'});
  const unprepared=await childFixture('read');
  unprepared.child.kill('SIGKILL');await once(unprepared.child,'exit');
  await until(async()=>(await ops.query('SELECT count(*) FROM consultation_persona_references WHERE call_session_seq=$1',[unprepared.id])).rows[0].count==='0','version-only dead producer reference was not reclaimed');
  assert.equal((await cons.query('SELECT count(*) FROM call_analyses WHERE call_session_seq=$1',[unprepared.id])).rows[0].count,'0');
  await ops.query('DELETE FROM ai_persona_versions WHERE ai_persona_version_seq=$1',[unprepared.versionSeq]);
  const prepared=await childFixture('prepared');
  assert.equal((await ops.query('SELECT committed FROM consultation_persona_references WHERE call_session_seq=$1',[prepared.id])).rows[0].committed,false);
  await assert.rejects(ops.query('DELETE FROM ai_persona_versions WHERE ai_persona_version_seq=$1',[prepared.versionSeq]),{code:'23503'});
  prepared.child.kill('SIGKILL');await once(prepared.child,'exit');
  await until(async()=>(await ops.query('SELECT count(*) FROM consultation_persona_references WHERE call_session_seq=$1',[prepared.id])).rows[0].count==='0','dead producer reference was not reclaimed');
  assert.equal((await cons.query('SELECT count(*) FROM call_analyses WHERE call_session_seq=$1',[prepared.id])).rows[0].count,'0');
  assert.equal((await ops.query("SELECT count(*) FROM audit_logs WHERE request_id=$1 AND result='SUCCESS'",[prepared.requestId])).rows[0].count,'0');
  await ops.query('DELETE FROM ai_persona_versions WHERE ai_persona_version_seq=$1',[prepared.versionSeq]);
  const committed=await childFixture('committed');
  committed.child.kill('SIGKILL');await once(committed.child,'exit');
  await until(async()=>(await ops.query('SELECT committed FROM consultation_persona_references WHERE call_session_seq=$1',[committed.id])).rows[0]?.committed===true,'committed analysis reference did not recover');
  assert.equal((await cons.query('SELECT count(*) FROM call_analyses WHERE call_session_seq=$1',[committed.id])).rows[0].count,'1');
  assert.equal((await ops.query("SELECT count(*) FROM audit_logs WHERE request_id=$1 AND result='SUCCESS'",[committed.requestId])).rows[0].count,'1');
  await assert.rejects(ops.query('DELETE FROM ai_persona_versions WHERE ai_persona_version_seq=$1',[committed.versionSeq]),{code:'23503'});
  const replay=await fetch(`http://consultation-app:3004/api/ai/calls/${committed.id}/analysis`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body(committed.provider,{aiPersonaVersionSeq:committed.versionSeq}))});
  assert.equal(replay.status,204);
  // A late abort cannot erase a reference that already protects committed business data.
  const reference=(await ops.query('SELECT transaction_id FROM consultation_persona_references WHERE call_session_seq=$1',[committed.id])).rows[0];
  const late=await fetch('http://operations-app:3005/internal/events',{method:'POST',headers:eventHeaders,body:JSON.stringify({eventId:randomUUID(),source:'consultation',eventType:'AuditAborted',payload:{transactionId:reference.transaction_id}})});
  assert.equal(late.status,200);
  assert.equal((await ops.query('SELECT committed FROM consultation_persona_references WHERE call_session_seq=$1',[committed.id])).rows[0].committed,true);
  const fresh={...privateQuery,eventId:randomUUID(),payload:{versionSeq:900099,callSessionSeq:c.id,transactionId:randomUUID()}};
  await ops.query(`INSERT INTO ai_persona_versions(ai_persona_version_seq,ai_persona_seq,version,prompt_text,name,turn_wait_level,status)
    OVERRIDING SYSTEM VALUE SELECT 900099,ai_persona_seq,900099,'설정','조회 재시도','NORMAL','INACTIVE' FROM ai_personas WHERE code='analysis-parity'`);
  const proof=await cons.connect();
  try{
    await proof.query('BEGIN');await proof.query('SELECT pg_advisory_xact_lock(20261106,hashtext($1))',[fresh.payload.transactionId]);
    assert.equal((await(await query(fresh)).json()).payload.exists,true);
    await assert.rejects(ops.query('DELETE FROM ai_persona_versions WHERE ai_persona_version_seq=900099'),{code:'23503'});
  }finally{await proof.query('ROLLBACK');proof.release();}
  const release=await fetch('http://operations-app:3005/internal/events',{method:'POST',headers:eventHeaders,body:JSON.stringify({eventId:randomUUID(),source:'consultation',eventType:'AuditAborted',payload:{transactionId:fresh.payload.transactionId}})});
  assert.equal(release.status,200);
  await ops.query('DELETE FROM ai_persona_versions WHERE ai_persona_version_seq=900099');
  const freshRetry={...fresh,eventId:randomUUID(),payload:{...fresh.payload,transactionId:randomUUID()}};
  assert.equal((await(await query(freshRetry)).json()).payload.exists,false);
  assert.equal((await ops.query('SELECT count(*) FROM inbox_events WHERE event_id=$1',[fresh.eventId])).rows[0].count,'0');
  t.diagnostic('split reference checks: authenticated current lookup, invalid events, delete protection from lookup ACK, lookup-only/prepared SIGKILL rollback, committed SIGKILL recovery, replay and late abort');
});
