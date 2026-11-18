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
      started_at::text,ended_at::text,deleted_at::text,analysis_failed_at FROM call_sessions ORDER BY call_session_seq`)).rows;
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
  for(const [section,input]of[['analysis',body(c.provider)],['analysis/failure',{providerCallId:c.provider}],['stage-metrics',stage(c.provider)],['response-wait-metrics',wait(c.provider)]]){
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
  await t.test('historical and late call analyses retain publicly deleted persona version references',async()=>{
    const versionSeq=9200999,ids=[];
    for(const side of sides){
      const persona=(await side.identity.query("INSERT INTO ai_personas(code) VALUES('analysis-deleted') RETURNING ai_persona_seq")).rows[0].ai_persona_seq;
      ids.push(persona);
      await side.identity.query(`INSERT INTO ai_persona_versions(ai_persona_version_seq,ai_persona_seq,version,prompt_text,name,turn_wait_level)
        OVERRIDING SYSTEM VALUE VALUES($1,$2,1,'보존 원문','삭제된 실제 버전','NORMAL')`,[versionSeq,persona]);
    }
    assert.equal(ids[1],ids[0]);
    const historical=await call(),late=await call();
    await post(historical.id,'analysis',body(historical.provider,{aiPersonaVersionSeq:versionSeq}),204);
    const requestId=randomUUID();requestIds.add(requestId);
    for(const side of sides){
      await side.identity.query("UPDATE admin_users SET role='SYSTEM_ADMIN' WHERE admin_user_seq=$1",[side.adminId]);
      try{
        const response=await fetch((side===sides[0]?side.base:'http://operations-app:3005')+'/api/personas',{
          method:'DELETE',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json','X-Request-Id':requestId},
          body:JSON.stringify({aiPersonaSeqs:[ids[0]]})});
        assert.equal(response.status,204,await response.text());
      }finally{await side.identity.query("UPDATE admin_users SET role='OPERATOR' WHERE admin_user_seq=$1",[side.adminId]);}
      const version=(await side.identity.query('SELECT status,deleted_at FROM ai_persona_versions WHERE ai_persona_version_seq=$1',[versionSeq])).rows[0];
      assert.equal(version.status,'INACTIVE');assert.ok(version.deleted_at instanceof Date);normalize(version.deleted_at);
    }
    await post(late.id,'analysis',body(late.provider,{aiPersonaVersionSeq:versionSeq}),204);
    for(const id of [historical.id,late.id])for(const side of sides){
      const response=await fetch(`${side.base}/api/calls/${id}`,{headers:{Cookie:cookie}});
      assert.equal(response.status,200,await response.clone().text());
      const detail=(await response.json()).data;
      assert.equal(detail.analysis.aiPersonaVersionSeq,versionSeq);
      assert.equal(detail.analysis.personaName,'삭제된 실제 버전');assert.equal(detail.analysis.personaVersion,1);
    }
    await compare();
  });
  for(const extra of [{incoming:'2020-01-01T00:00:00Z'},{deleted:'2026-11-01T02:00:00Z'}]){
    const hidden=await call(extra);
    for(const [section,input]of[['analysis',body(hidden.provider)],['analysis/failure',{providerCallId:hidden.provider}],['stage-metrics',stage(hidden.provider)],['response-wait-metrics',wait(hidden.provider)]])
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
  const reported=await call();
  for(const invalid of [{},{providerCallId:''},{providerCallId:7},{providerCallId:reported.provider,reason:'extra'}])await post(reported.id,'analysis/failure',invalid,400);
  await post(reported.id,'analysis/failure',{providerCallId:'wrong-provider'},403);
  await post(2147483647,'analysis/failure',{providerCallId:reported.provider},404);
  await Promise.all(Array.from({length:6},()=>post(reported.id,'analysis/failure',{providerCallId:reported.provider},204,{concurrent:true})));
  await compare();
  const firstFailure=[];
  for(const side of sides){firstFailure.push((await side.db.query('SELECT analysis_failed_at FROM call_sessions WHERE call_session_seq=$1',[reported.id])).rows[0].analysis_failed_at.getTime());assert.equal((await side.identity.query("SELECT count(*)::int n FROM audit_logs WHERE action='CALL_ANALYSIS_FAILED' AND result='SUCCESS' AND target_seq=$1",[reported.id])).rows[0].n,1);}
  await post(reported.id,'analysis/failure',{providerCallId:reported.provider},204);
  await post(reported.id,'analysis',body(reported.provider),204);
  await post(reported.id,'analysis/failure',{providerCallId:reported.provider},204);
  for(const [index,side]of sides.entries())assert.equal((await side.db.query('SELECT analysis_failed_at FROM call_sessions WHERE call_session_seq=$1',[reported.id])).rows[0].analysis_failed_at.getTime(),firstFailure[index]);
  await post(c.id,'analysis/failure',{providerCallId:c.provider},204);
  for(const side of sides)assert.equal((await side.db.query('SELECT analysis_failed_at FROM call_sessions WHERE call_session_seq=$1',[c.id])).rows[0].analysis_failed_at,null);
  const failureAudit=await call();
  for(const side of sides)await side.identity.query(`CREATE FUNCTION reject_failure_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='CALL_ANALYSIS_FAILED' AND NEW.result='SUCCESS' THEN RAISE EXCEPTION 'injected audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_failure_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_failure_audit()`);
  try{await post(failureAudit.id,'analysis/failure',{providerCallId:failureAudit.provider},500);}finally{for(const side of sides)await side.identity.query('DROP TRIGGER reject_failure_audit ON audit_logs; DROP FUNCTION reject_failure_audit()');}
  for(const side of sides)assert.equal((await side.db.query('SELECT analysis_failed_at FROM call_sessions WHERE call_session_seq=$1',[failureAudit.id])).rows[0].analysis_failed_at,null);
  await compare();
  const docs=await Promise.all(sides.map(async side=>(await fetch(side.base+'/api/docs-json')).json()));
  for(const suffix of ['analysis','analysis/failure','stage-metrics','response-wait-metrics']){
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

test('event order references match the source permission decision and retain one owner transaction',async t=>{
  const {createServer}=require('node:http'),{networkInterfaces}=require('node:os');
  const {privateAddress,validateScopeResult}=require('@dva/events/call-event-reference.cjs');
  const reference=new Pool({host:'monolith-db',user:'monolith_app'}),orders=new Pool({host:'order-db',user:'order_app'});
  const customers=[9100001,9100002],ids=[9100101,9100102,9100103,9100104],calls=[],requestIds=[],retainedOrders=[];
  const scripts=new Map(),address=Object.values(networkInterfaces()).flat().find(v=>v?.family==='IPv4'&&privateAddress(v.address))?.address;
  assert.ok(address);
  const headers={Authorization:'Bearer '+process.env.PGPASSWORD,'Content-Type':'application/json'};
  const probe=async(id,locked)=>{
    const client=await orders.connect();
    try{await client.query('BEGIN');const work=client.query('SELECT order_seq FROM orders WHERE order_seq=$1 FOR UPDATE NOWAIT',[id]);if(locked)await assert.rejects(work,{code:'55P03'});else assert.equal((await work).rowCount,1);}
    finally{await client.query('ROLLBACK');client.release();}
  };
  const server=createServer(async(req,res)=>{
    try{
      assert.equal(req.url,'/internal/call-event-order-scope/continue');assert.equal(req.headers.authorization,headers.Authorization);
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const input=JSON.parse(Buffer.concat(chunks));validateScopeResult(input);
      const p=input.payload,script=scripts.get(p.scopeId);assert.ok(script);script.seen++;
      assert.deepEqual(p.lookup,script.steps[p.step].lookup);
      assert.equal(p.exists?p.allowed===true:undefined,script.steps[p.step].expected);
      if(p.exists)await probe(p.lookup.orderSeq,true);
      if(script.fail){res.writeHead(503,{'Content-Type':'application/json'}).end('{}');return;}
      res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({eventId:input.eventId,status:'processed',payload:{next:script.steps[p.step+1]?.lookup??null}}));
    }catch(error){if(!res.destroyed&&!res.writableEnded)res.writeHead(503,{'Content-Type':'application/json'}).end(JSON.stringify({error:String(error)}));}
  });
  await new Promise(resolve=>server.listen(3004,'0.0.0.0',resolve));
  t.after(async()=>{
    await new Promise(resolve=>server.close(resolve));
    for(const fixture of retainedOrders){await fixture.query('ROLLBACK');fixture.release();}
    await reference.query('DELETE FROM call_insight_events WHERE call_session_seq=ANY($1::int[])',[calls]);
    await reference.query('DELETE FROM call_sessions WHERE call_session_seq=ANY($1::int[])',[calls]);
    await reference.query('DELETE FROM audit_logs WHERE request_id=ANY($1::uuid[])',[requestIds]);
    for(const db of [reference,orders])await db.query('DELETE FROM orders WHERE order_seq=ANY($1::int[])',[ids]);
    await reference.query('DELETE FROM customers WHERE customer_seq=ANY($1::int[])',[customers]);
    await Promise.all([reference.end(),orders.end()]);
  });
  for(const [index,id]of customers.entries())await reference.query("INSERT INTO customers(customer_seq,name,phone_number,status) OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4)",[id,'참조 고객 '+index,'0107777000'+(index+1),index?'WITHDRAWN':'ACTIVE']);
  for(const db of [reference,orders]){
    for(const [index,id]of ids.entries())await db.query("INSERT INTO orders(order_seq,customer_seq,status,creation_source) OVERRIDING SYSTEM VALUE VALUES($1,$2,'COLLECTING','AI')",[id,customers[index===1?1:0]]);
    await db.query('UPDATE orders SET deleted_at=clock_timestamp() WHERE order_seq=$1',[ids[2]]);
    // Pause expiry cleanup without masking the owner's row-lock assertions.
    const fixture=await db.connect();retainedOrders.push(fixture);await fixture.query('BEGIN');
    await fixture.query('SELECT pg_advisory_xact_lock(20261103,157)');
    await db.query("UPDATE orders SET created_at=clock_timestamp()-interval '6 years' WHERE order_seq=$1",[ids[3]]);
  }
  const lookups=[
    {orderSeq:ids[0],callOrderSeq:null,customerSeq:customers[0]},
    {orderSeq:ids[1],callOrderSeq:null,customerSeq:customers[0]},
    {orderSeq:ids[0],callOrderSeq:ids[1],customerSeq:customers[0]},
    {orderSeq:ids[0],callOrderSeq:ids[0],customerSeq:null},
    {orderSeq:2147483647,callOrderSeq:null,customerSeq:customers[0]},
    {orderSeq:ids[2],callOrderSeq:null,customerSeq:customers[0]},
    {orderSeq:ids[3],callOrderSeq:null,customerSeq:customers[0]},
    {orderSeq:ids[1],callOrderSeq:null,customerSeq:customers[1]},
    {orderSeq:ids[0],callOrderSeq:ids[2],customerSeq:customers[0]},
  ];
  const decisions=[];
  for(const lookup of lookups){
    const provider='scope-'+randomUUID(),requestId=randomUUID();requestIds.push(requestId);
    const phone=lookup.customerSeq===customers[1]?'01077770002':lookup.customerSeq===null?'01077779999':'01077770001';
    const id=(await reference.query('INSERT INTO call_sessions(provider_call_id,caller_phone_number,incoming_at,order_seq) VALUES($1,$2,clock_timestamp(),$3) RETURNING call_session_seq',[provider,phone,lookup.callOrderSeq])).rows[0].call_session_seq;calls.push(id);
    const response=await fetch(`http://monolith-app:3000/api/ai/calls/${id}/events`,{method:'POST',headers:{Authorization:'Bearer '+process.env.AI_INSIGHTS_TOKEN,'Content-Type':'application/json','X-Request-Id':requestId},body:JSON.stringify({providerCallId:provider,events:[{eventId:randomUUID(),eventOrder:1,kind:'AI_ACTION',occurredAt:new Date().toISOString(),offsetSeconds:null,payload:{action:'ORDER_LOOKUP',summaryText:'참조',orderSeq:lookup.orderSeq}}]})});
    assert.ok([204,403,404].includes(response.status),await response.text());
    decisions.push({lookup,expected:response.status===204?true:response.status===403?false:undefined});
  }
  const run=async(steps,fail=false)=>{
    const eventId=randomUUID(),script={steps,seen:0,fail};scripts.set(eventId,script);
    const response=await fetch('http://order-app:3002/internal/call-event-order-scope',{method:'POST',headers,signal:AbortSignal.timeout(30000),body:JSON.stringify({eventId,source:'consultation',eventType:'CallEventOrderScopeRequested',payload:{callbackAddress:address,lookup:steps[0].lookup}})});
    const text=await response.text();assert.equal(response.status,fail?500:200,text);if(!fail)assert.deepEqual(JSON.parse(text),{eventId,status:'processed',payload:null});assert.equal(script.seen,fail?1:steps.length);scripts.delete(eventId);
  };
  const initial={eventId:randomUUID(),source:'consultation',eventType:'CallEventOrderScopeRequested',payload:{callbackAddress:address,lookup:decisions[0].lookup}};
  for(const authorization of ['', 'Bearer wrong'])assert.equal((await fetch('http://order-app:3002/internal/call-event-order-scope',{method:'POST',headers:{...headers,Authorization:authorization},body:JSON.stringify(initial)})).status,403);
  assert.equal((await fetch('http://order-app:3002/internal/call-event-order-scope',{method:'POST',headers,body:JSON.stringify({...initial,payload:{...initial.payload,callbackAddress:'169.254.169.254'}})})).status,422);
  assert.equal((await fetch('http://order-app:3002/api/internal/call-event-order-scope',{method:'POST',headers,body:JSON.stringify(initial)})).status,404);
  assert.ok(!Object.keys((await(await fetch('http://order-app:3002/api/docs-json')).json()).paths).some(path=>path.includes('call-event-order-scope')));
  const before=(await orders.query('SELECT * FROM orders WHERE order_seq=ANY($1::int[]) ORDER BY order_seq',[ids])).rows;
  await run(decisions);
  await Promise.all(Array.from({length:5},()=>run(decisions.slice(0,2))));
  await run(Array.from({length:50},()=>decisions[0]));
  await run(decisions.slice(0,1),true);await probe(ids[0],false);
  assert.deepEqual((await orders.query('SELECT * FROM orders WHERE order_seq=ANY($1::int[]) ORDER BY order_seq',[ids])).rows,before);
});

test('public call events preserve the source batch, references, FAQ examples and audit outcomes',async t=>{
  const mono=new Pool({host:'monolith-db',user:'monolith_app'}),cons=new Pool({host:'consultation-db',user:'consultation_app'}),ops=new Pool({host:'operations-db',user:'operations_app'});
  const customer=new Pool({host:'customer-db',user:'customer_app'}),orders=new Pool({host:'order-db',user:'order_app'});
  const sides=[{base:'http://monolith-app:3000',db:mono,audit:mono},{base:'http://consultation-app:3004',db:cons,audit:ops}];
  const faqIds=[9200001,9200002,9200003,9200004],callIds=[9200101,9200102,9200103],customerIds=[9200201,9200202],orderIds=[9200301,9200302,9200303,9200304],questionId=9200401;
  const providers=callIds.map(()=> 'public-events-'+randomUUID()),requestIds=new Set(),concurrentIds=new Set(),gates=[],retainedOrders=[];
  const exampleIds=new Map(),reverseExampleIds=new Map(),sessionToken='c'.repeat(64);
  const headers={Authorization:'Bearer '+process.env.AI_INSIGHTS_TOKEN,'Content-Type':'application/json'};
  t.after(async()=>{
    for(const gate of gates){await gate.query('SELECT pg_advisory_unlock(20261110,$1)',[faqIds[0]]);gate.release();}
    for(const fixture of retainedOrders){await fixture.query('ROLLBACK');fixture.release();}
    for(const db of [mono,ops]){
      await db.query('DROP TRIGGER IF EXISTS gate_event_audit ON audit_logs; DROP FUNCTION IF EXISTS gate_event_audit(); DROP TRIGGER IF EXISTS reject_event_audit ON audit_logs; DROP FUNCTION IF EXISTS reject_event_audit()');
      await db.query('DELETE FROM faq_entries WHERE faq_entry_seq=ANY($1::int[])',[faqIds]);
      await db.query('DELETE FROM audit_logs WHERE request_id=ANY($1::uuid[])',[[...requestIds]]);
      await db.query('DELETE FROM admin_sessions WHERE admin_user_seq=9200501');
      await db.query('DELETE FROM admin_users WHERE admin_user_seq=9200501');
    }
    for(const db of [mono,cons]){
      await db.query('DELETE FROM call_insight_events WHERE call_session_seq=ANY($1::int[])',[callIds]);
      await db.query('DELETE FROM call_utterances WHERE call_session_seq=ANY($1::int[])',[callIds]);
      await db.query('DELETE FROM unanswered_questions WHERE unanswered_question_seq=$1',[questionId]);
      await db.query('DELETE FROM call_sessions WHERE call_session_seq=ANY($1::int[])',[callIds]);
    }
    for(const db of [mono,orders])await db.query('DELETE FROM orders WHERE order_seq=ANY($1::int[])',[orderIds]);
    for(const db of [mono,customer])await db.query('DELETE FROM customers WHERE customer_seq=ANY($1::int[])',[customerIds]);
    await Promise.all([mono.end(),cons.end(),ops.end(),customer.end(),orders.end()]);
  });
  for(const url of ['http://monolith-app:3000/health','http://consultation-app:3004/consultation/health/ready',
    'http://operations-app:3005/operations/health/ready','http://customer-app:3001/customer/health/ready','http://order-app:3002/order/health/ready'])for(let retry=0;;retry++){
    try{if((await fetch(url)).status===200)break;}catch{}
    assert.ok(retry<100,'event fixture service did not start: '+url);await delay(100);
  }
  for(const db of [mono,customer])for(const [n,id]of customerIds.entries())await db.query("INSERT INTO customers(customer_seq,name,phone_number,status) OVERRIDING SYSTEM VALUE VALUES($1,'이벤트 고객',$2,$3)",[id,'0107777888'+(n+8),n?'WITHDRAWN':'ACTIVE']);
  for(const db of [mono,orders]){
    for(const [n,id]of orderIds.entries())await db.query("INSERT INTO orders(order_seq,customer_seq,status,creation_source) OVERRIDING SYSTEM VALUE VALUES($1,$2,'COLLECTING','AI')",[id,customerIds[n===1?1:0]]);
    await db.query('UPDATE orders SET deleted_at=clock_timestamp() WHERE order_seq=$1',[orderIds[2]]);
    const fixture=await db.connect();retainedOrders.push(fixture);await fixture.query('BEGIN');
    await fixture.query('SELECT pg_advisory_xact_lock(20261103,157)');
    await db.query("UPDATE orders SET created_at=clock_timestamp()-interval '6 years' WHERE order_seq=$1",[orderIds[3]]);
  }
  for(const db of [mono,cons]){
    for(const [n,id]of callIds.entries())await db.query('INSERT INTO call_sessions(call_session_seq,provider_call_id,caller_phone_number,incoming_at,order_seq) OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,clock_timestamp(),$4)',[id,providers[n],n===2?'01077778889':'01077778888',n===1?orderIds[1]:null]);
    await db.query("INSERT INTO unanswered_questions(unanswered_question_seq,event_id,call_session_seq,question_text,occurred_at,payload_hash,status) OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,'다른 통화 질문',clock_timestamp(),$4,'OPEN')",[questionId,randomUUID(),callIds[1],'a'.repeat(64)]);
  }
  for(const db of [mono,ops]){
    await db.query("INSERT INTO admin_users(admin_user_seq,login_id,name,password_hash,role,status) OVERRIDING SYSTEM VALUE VALUES(9200501,'evparity','이벤트 운영자','not-a-login','OPERATOR','ACTIVE')");
    await db.query('INSERT INTO admin_sessions(session_token_hash,admin_user_seq) VALUES($1,9200501)',[createHash('sha256').update(sessionToken).digest('hex')]);
    for(const id of faqIds)await db.query("INSERT INTO faq_entries(faq_entry_seq,question,answer,category,updated_by_admin_user_seq,created_at,updated_at,deleted_at) OVERRIDING SYSTEM VALUE VALUES($1::int,'원본 FAQ '||$1::text,'답변','기타',9200501,'2026-11-01T00:00:00Z',$2,$3)",[id,id===faqIds[3]?'2100-01-01T00:00:00Z':'2026-11-01T00:00:00Z',id===faqIds[2]?new Date():null]);
  }
  const begun=Date.now(),base=Date.now()+30000;
  const action=(order,changes={})=>({eventId:randomUUID(),eventOrder:order,kind:'AI_ACTION',occurredAt:new Date(base).toISOString(),offsetSeconds:null,payload:{action:'PIN_SEARCH',summaryText:'동작 원문\n',orderSeq:null},...changes});
  const utterance=(order,text,speaker,eventOrder)=>action(eventOrder,{kind:'UTTERANCE',payload:{utteranceOrder:order,utteranceText:text,speaker,lastSentenceSeq:order}});
  const result=(order,eventOrder,at=base)=>action(eventOrder,{kind:'BUSINESS_RESULT',occurredAt:new Date(at).toISOString(),payload:{action:'FAQ_ANSWERED',orderSeq:null,unansweredQuestionSeq:null,summaryText:'FAQ 응답',faqEntrySeqs:[...faqIds,2147483647],questionUtteranceOrder:order,answerUtteranceOrder:2}});
  const sampleSQL='SELECT faq_question_example_seq,faq_entry_seq,event_id,question_text,occurred_at::text FROM faq_question_examples WHERE faq_entry_seq=ANY($1::int[]) ORDER BY faq_entry_seq,occurred_at,event_id';
  const eventSQL=`SELECT e.event_id,e.call_session_seq,e.event_order,e.kind,e.occurred_at,e.offset_seconds,e.unanswered_question_seq,e.payload,e.payload_hash,u.utterance_order
    FROM call_insight_events e LEFT JOIN call_utterances u ON u.call_utterance_seq=e.call_utterance_seq WHERE e.call_session_seq=ANY($1::int[]) ORDER BY e.event_id`;
  const utteranceSQL='SELECT call_session_seq,utterance_order,speaker,utterance_text,last_sentence_seq FROM call_utterances WHERE call_session_seq=ANY($1::int[]) ORDER BY call_session_seq,utterance_order';
  const auditSQL='SELECT actor_type,actor_seq,actor_name,action,target_type,target_seq,target_admin_name,request_id,result,metadata FROM audit_logs WHERE request_id=ANY($1::uuid[]) ORDER BY request_id,action,result,target_seq';
  const compare=async()=>{
    assert.deepEqual((await cons.query(eventSQL,[callIds])).rows,(await mono.query(eventSQL,[callIds])).rows);
    assert.deepEqual((await cons.query(utteranceSQL,[callIds])).rows,(await mono.query(utteranceSQL,[callIds])).rows);
    const actual=(await ops.query(sampleSQL,[faqIds])).rows,expected=(await mono.query(sampleSQL,[faqIds])).rows;
    assert.equal(actual.length,expected.length);
    // The source sorts by time/event only, so cross-FAQ identity assignment within one event is unspecified.
    for(let n=0;n<actual.length;n++){
      const sourceId=expected[n].faq_question_example_seq,splitId=actual[n].faq_question_example_seq;
      if(exampleIds.has(sourceId))assert.equal(exampleIds.get(sourceId),splitId);
      else{assert.ok(!reverseExampleIds.has(splitId));exampleIds.set(sourceId,splitId);reverseExampleIds.set(splitId,sourceId);}
      assert.deepEqual({...actual[n],faq_question_example_seq:sourceId},expected[n]);
    }
    assert.deepEqual([...exampleIds.keys()].sort((a,b)=>a-b),[...exampleIds.values()].sort((a,b)=>a-b));
    const sequenceSQL="SELECT last_value FROM pg_sequences WHERE schemaname='public' AND sequencename=(SELECT relname FROM pg_class WHERE oid=pg_get_serial_sequence('faq_question_examples','faq_question_example_seq')::regclass)";
    assert.deepEqual((await ops.query(sequenceSQL)).rows,(await mono.query(sequenceSQL)).rows);
    const auditRows=async db=>(await db.query(auditSQL,[[...requestIds]])).rows.map(row=>({...row,request_id:concurrentIds.has(row.request_id)?'<same-event winner>':row.request_id})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
    assert.deepEqual(await auditRows(ops),await auditRows(mono));
  };
  let requests=0;
  const send=async(side,input,requestId,options={})=>{
    const response=await fetch(`${side.base}/api/ai/calls/${options.id??callIds[0]}/events`,{method:'POST',headers:{...headers,'X-Request-Id':requestId,...options.headers},body:JSON.stringify(input)});
    const text=await response.text();return{status:response.status,body:text?JSON.parse(text):null,cache:response.headers.get('cache-control')};
  };
  const post=async(events,status,options={})=>{
    const requestId=options.requestId??randomUUID();requestIds.add(requestId);
    if(options.concurrent)concurrentIds.add(requestId);
    const input=options.input??{providerCallId:options.provider??providers[0],events};
    const responses=await Promise.all(sides.map(side=>send(side,input,requestId,options)));requests++;
    assert.equal(responses[1].status,responses[0].status,JSON.stringify(responses));
    if(status!==undefined)assert.equal(responses[0].status,status,JSON.stringify(responses));
    assert.deepEqual(responses[1].body,responses[0].body);assert.equal(responses[1].cache,responses[0].cache);
    if(options.compare!==false)await compare();
    return responses;
  };
  for(const authorization of ['', 'Bearer wrong'])await post([action(1)],401,{headers:{Authorization:authorization}});
  await post([],400);await post([action(1)],400,{input:{providerCallId:providers[0],events:[action(1)],extra:1}});
  const duplicate=action(1);await post([duplicate,duplicate],400);await post([action(1),action(1)],400);
  await post([action(1,{payload:{action:'PIN_SEARCH',summaryText:'x',orderSeq:null,status:'SUCCEEDED'}})],400);
  await post([action(1)],404,{id:2147483647});await post([action(1)],403,{provider:'wrong-provider'});
  const first=randomUUID(),question=' 원본 질문\n공백 보존 ',examples=Array.from({length:12},(_,n)=>result(1,n+3,base+n*1000));requestIds.add(first);
  for(const db of [mono,ops]){
    const gate=await db.connect();await gate.query('SELECT pg_advisory_lock(20261110,$1)',[faqIds[0]]);gates.push(gate);
    await db.query(`CREATE FUNCTION gate_event_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.request_id='${first}'::uuid AND NEW.action='CALL_EVENTS_RECORDED' AND NEW.result='SUCCESS'
      THEN PERFORM pg_advisory_xact_lock(20261110,${faqIds[0]}); END IF; RETURN NEW; END $$;
      CREATE TRIGGER gate_event_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION gate_event_audit()`);
  }
  const initial=[utterance(1,question,'CUSTOMER',1),utterance(2,'답변','AI',2),...examples];
  const pending=post(initial,204,{requestId:first,compare:false});void pending.catch(()=>undefined);
  try{
    for(const db of [mono,ops])for(let retry=0;;retry++){
      if((await db.query('SELECT 1 FROM pg_locks WHERE locktype=$1 AND classid=20261110 AND objid=$2 AND NOT granted',['advisory',faqIds[0]])).rowCount)break;
      assert.ok(retry<200,'request did not reach the real audit gate');await delay(25);
    }
    for(const side of sides){assert.equal((await side.audit.query(sampleSQL,[faqIds])).rowCount,0);assert.equal((await side.db.query(eventSQL,[callIds])).rowCount,0);}
  }finally{for(const gate of gates.splice(0)){await gate.query('SELECT pg_advisory_unlock(20261110,$1)',[faqIds[0]]);gate.release();}}
  await pending;await compare();assert.equal((await ops.query(sampleSQL,[faqIds])).rowCount,20);
  for(const db of [mono,ops])await db.query('DROP TRIGGER gate_event_audit ON audit_logs; DROP FUNCTION gate_event_audit()');
  await post(initial,204);
  const reordered=structuredClone(examples);for(const e of reordered)e.payload.faqEntrySeqs.reverse();await post(reordered,204);
  await post([{...initial[0],payload:{...initial[0].payload,utteranceText:'다른 원문'}}],409);
  await post([initial[0]],409,{id:callIds[1],provider:providers[1]});
  await post([result(999,20)],404);await post([result(2,20)],422);
  await post([action(20,{kind:'BUSINESS_RESULT',payload:{action:'QUESTION_UNANSWERED',summaryText:'다른 통화',orderSeq:null,unansweredQuestionSeq:questionId}})],403);
  await post([action(20,{kind:'BUSINESS_RESULT',payload:{action:'QUESTION_UNANSWERED',summaryText:'없는 질문',orderSeq:null,unansweredQuestionSeq:2147483647}})],404);
  for(const [n,id]of orderIds.entries())await post([action(24+n,{payload:{action:'PREVIOUS_ORDER_SEARCH',summaryText:'주문 참조',orderSeq:id}})],n===0?204:n===1?403:404);
  const legacySingle=result(1,28,base+15000);delete legacySingle.payload.faqEntrySeqs;legacySingle.payload.faqEntrySeq=faqIds[0];await post([legacySingle],204);
  const legacyChanged=structuredClone(legacySingle);delete legacyChanged.payload.faqEntrySeq;legacyChanged.payload.faqEntrySeqs=[faqIds[0]];await post([legacyChanged],409);
  await post([action(21,{payload:{action:'ORDER_LOOKUP',summaryText:'연결 주문 우선',orderSeq:orderIds[0]}})],403,{id:callIds[1],provider:providers[1]});
  await post([action(21,{payload:{action:'ORDER_LOOKUP',summaryText:'연결 주문',orderSeq:orderIds[1]}})],204,{id:callIds[1],provider:providers[1]});
  await post([action(21,{payload:{action:'ORDER_LOOKUP',summaryText:'탈퇴 고객',orderSeq:orderIds[1]}})],204,{id:callIds[2],provider:providers[2]});
  for(const db of [mono,ops])await db.query("CREATE FUNCTION reject_event_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='CALL_EVENTS_RECORDED' AND NEW.result='SUCCESS' THEN RAISE EXCEPTION 'injected event audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_event_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_event_audit()");
  const retryBatch=[utterance(3,'롤백 질문','CUSTOMER',22),result(3,23,base+20000)];
  try{await post(retryBatch,500);}finally{for(const db of [mono,ops])await db.query('DROP TRIGGER reject_event_audit ON audit_logs; DROP FUNCTION reject_event_audit()');}
  await post(retryBatch,204);
  await post([result(1,30,base+17000),result(1,31,base+17000)],204);
  for(const id of faqIds.slice(0,2)){
    const requestId=randomUUID(),responses=await Promise.all(['http://monolith-app:3000','http://operations-app:3005'].map(async base=>{
      const response=await fetch(base+'/api/faqs/'+id,{headers:{Cookie:'dva_session='+sessionToken,'X-Request-Id':requestId}});assert.equal(response.status,200);return response.json();
    }));
    for(const example of responses[1].data.recentQuestions){assert.ok(reverseExampleIds.has(example.faqQuestionExampleSeq));example.faqQuestionExampleSeq=reverseExampleIds.get(example.faqQuestionExampleSeq);}
    assert.deepEqual(responses[1],responses[0]);
  }
  const legacyResults=[];
  for(let n=0;n<10;n++){
    const text='\u0001'.repeat(19999)+String.fromCodePoint(0x4e00+n),order=100+n;
    for(const db of [mono,cons])await db.query('INSERT INTO call_utterances(call_session_seq,utterance_order,speaker,utterance_text,last_sentence_seq) VALUES($1,$2,$3,$4,$2)',[callIds[0],order,'CUSTOMER',text]);
    legacyResults.push(result(order,100+n,base+30000+n*1000));
  }
  await post(legacyResults,204);
  assert.ok((await ops.query("SELECT count(*)::int n FROM inbox_events WHERE event_type='FaqQuestionExamplesChunkPrepared'")).rows[0].n>=3);
  assert.equal((await ops.query('SELECT count(*)::int n FROM consultation_audit_preparations WHERE NOT aborted')).rows[0].n,0);
  const invalidChunk={eventId:randomUUID(),source:'consultation',eventType:'FaqQuestionExamplesChunkPrepared',payload:{transactionId:'00000000-0000-0000-0000-000000000000',questions:[{utteranceOrder:1,text:'question'}],results:[{eventId:randomUUID(),occurredAt:new Date(base).toISOString(),questionUtteranceOrder:1,faqEntrySeqs:[faqIds[0]]}]}};
  assert.equal((await fetch('http://operations-app:3005/internal/events',{method:'POST',headers:{Authorization:'Bearer '+process.env.CONSULTATION_AUTH_TOKEN,'Content-Type':'application/json'},body:JSON.stringify(invalidChunk)})).status,422);
  assert.equal((await ops.query('SELECT count(*)::int n FROM inbox_events WHERE event_id=$1',[invalidChunk.eventId])).rows[0].n,0);
  const concurrent=[action(200,{payload:{action:'ORDER_LOOKUP',summaryText:'동시 동일 재전송',orderSeq:orderIds[0]}})];
  await Promise.all(Array.from({length:5},()=>post(concurrent,204,{compare:false,concurrent:true})));await compare();
  for(const db of [mono,ops])assert.equal((await db.query("SELECT count(*)::int n FROM audit_logs WHERE request_id=ANY($1::uuid[]) AND action='CALL_EVENTS_RECORDED' AND result='SUCCESS'",[[...concurrentIds]])).rows[0].n,1);
  await post(Array.from({length:50},(_,n)=>action(300+n,{payload:{action:'ORDER_LOOKUP',summaryText:'최대 묶음',orderSeq:orderIds[0]}})),204);
  const huge=utterance(500,'\u0001'.repeat(19999)+'끝','CUSTOMER',500);await post([huge],413);
  const docs=await Promise.all(sides.map(async side=>(await fetch(side.base+'/api/docs-json')).json()));
  assert.deepEqual(docs[1].paths['/api/ai/calls/{id}/events'],docs[0].paths['/api/ai/calls/{id}/events']);
  for(const name of ['CreateCallEventsDto','CallEventInputDto','UtterancePayloadDto','AiActionPayloadDto','BusinessResultPayloadDto'])assert.deepEqual(docs[1].components.schemas[name],docs[0].components.schemas[name]);
  t.diagnostic(`event HTTP comparisons: ${requests}; event/hash/utterance/FAQ identity mapping/audits match; public gate, retry, large derived inputs and 50 references verified in ${Date.now()-begun}ms`);
});
