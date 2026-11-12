const { truncateFixture } = require('./fixture-reset.cjs');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {Pool}=require('pg');
const {hashPassword}=require('./seed-password.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('consultation retention claims preserve source expiry, upload leases, locks and stale-worker fencing',async t=>{
  assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.PGDATABASE,'dva_webhook_test');
  const {RetentionRepository}=require('../dist/retention/retention.repository'),{createHash}=require('node:crypto');
  const db=new Pool();t.after(()=>db.end());
  await truncateFixture(db,'TRUNCATE pbx_webhooks.call_ended_events,recordings,call_sessions RESTART IDENTITY CASCADE');
  const transaction=async work=>{const client=await db.connect();try{await client.query('BEGIN');const value=await work(client);await client.query('COMMIT');return value;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}};
  const repo=new RetentionRepository({pool:db,transaction});
  await db.query(`INSERT INTO call_sessions(provider_call_id,caller_phone_number,incoming_at,started_at,ended_at)
    VALUES('retention-recent','01098880001',clock_timestamp()-interval '4 years',clock_timestamp()-interval '6 years',clock_timestamp()-interval '6 years'),
    ('retention-legacy','01098880002',NULL,clock_timestamp()-interval '6 years',clock_timestamp()-interval '6 years')`);
  assert.equal(await repo.claimCall(),undefined);
  await db.query("INSERT INTO call_sessions(provider_call_id,caller_phone_number,incoming_at,started_at,ended_at) VALUES('retention-expired','01098880003',clock_timestamp()-interval '6 years',clock_timestamp()-interval '6 years',clock_timestamp()-interval '6 years')");
  const recordings=['10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002'];
  const keys=recordings.map(id=>'recordings/'+createHash('sha256').update(id).digest('hex'));
  await db.query('INSERT INTO recordings(call_session_seq,object_key) VALUES(3,$1)',[keys[0]]);
  for(const id of recordings)await db.query("INSERT INTO pbx_webhooks.call_ended_events(recording_id,payload,call_session_seq) VALUES($1,'{}',3)",[id]);
  const gate=await db.connect();
  try{
    await gate.query("SELECT pg_advisory_lock(hashtextextended('call-end:01098880003',0))");
    try{assert.equal(await repo.claimCall(),undefined);}finally{await gate.query("SELECT pg_advisory_unlock(hashtextextended('call-end:01098880003',0))");}
    for(const sql of ["SELECT 1 FROM pbx_webhooks.call_ended_events WHERE call_session_seq=3 FOR UPDATE",'SELECT 1 FROM call_sessions WHERE call_session_seq=3 FOR UPDATE']){
      await gate.query('BEGIN');await gate.query(sql);try{assert.equal(await repo.claimCall(),undefined);}finally{await gate.query('ROLLBACK');}
    }
    await db.query("UPDATE pbx_webhooks.call_ended_events SET claim_id=gen_random_uuid(),claimed_until=clock_timestamp()+interval '5 minutes' WHERE recording_id=$1",[recordings[0]]);
    assert.equal(await repo.claimCall(),undefined);await db.query('UPDATE pbx_webhooks.call_ended_events SET claim_id=NULL,claimed_until=NULL');
    const claims=await Promise.all([repo.claimCall(),repo.claimCall()]);assert.equal(claims.filter(Boolean).length,1);const claim=claims.find(Boolean);
    assert.equal(claim.id,3);assert.equal(claim.phone,'01098880003');assert.deepEqual(claim.keys.sort(),keys.sort());assert.match(claim.claimId,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    await gate.query('BEGIN');await gate.query('SELECT 1 FROM call_sessions WHERE call_session_seq=3 FOR UPDATE NOWAIT');await gate.query('SELECT 1 FROM pbx_webhooks.call_ended_events WHERE call_session_seq=3 FOR UPDATE NOWAIT');await gate.query('ROLLBACK');
    assert.equal(await repo.renew({...claim,claimId:randomUUID()}),false);assert.equal(await repo.renew(claim),true);
    await repo.defer(claim);let lease=(await db.query('SELECT purge_claimed_until FROM call_sessions WHERE call_session_seq=3')).rows[0].purge_claimed_until;assert.ok(lease-Date.now()>50000&&lease-Date.now()<65000);
    await db.query("UPDATE call_sessions SET purge_claimed_until=clock_timestamp()-interval '1 second' WHERE call_session_seq=3");assert.equal(await repo.renew(claim),false);
    const next=await repo.claimCall();assert.notEqual(next.claimId,claim.claimId);assert.deepEqual(next.keys.sort(),keys.sort());
    lease=(await db.query('SELECT purge_claimed_until FROM call_sessions WHERE call_session_seq=3')).rows[0].purge_claimed_until;await repo.defer(claim);assert.equal((await db.query('SELECT purge_claimed_until FROM call_sessions WHERE call_session_seq=3')).rows[0].purge_claimed_until.getTime(),lease.getTime());
    assert.equal(await repo.claimCall(),undefined);assert.equal((await db.query('SELECT count(*)::int AS n FROM call_sessions')).rows[0].n,3);
    console.log(JSON.stringify({retentionClaims:{claimed:1,uploadKeys:keys,onlyIncomingAt:true,busyUploadPreserved:true,locksReleased:true,staleWorkerFenced:true}}));
  }finally{await gate.query('ROLLBACK');gate.release();}
});
test('production PBX, active count and SSE match with independent operations sessions',async t=>{
  assert.equal(process.env.PGDATABASE,'dva_webhook_test');
  const started=Date.now(),origin='http://localhost:5173',pbx=process.env.PBX_WEBHOOK_TOKEN;
  const mono=new Pool({host:'monolith-db',user:'monolith_app'}),consultation=new Pool({host:'consultation-db',user:'consultation_app'}),operations=new Pool({host:'operations-db',user:'operations_app'});
  t.after(async()=>{await Promise.all([mono.end(),consultation.end(),operations.end()]);});
  const sides=[{base:'http://monolith-app:3000',auth:'http://monolith-app:3000',db:mono,identity:mono,health:'/health'},
    {base:'http://consultation-app:3004',auth:'http://operations-app:3005',db:consultation,identity:operations,health:'/consultation/health/ready'}];
  for(const side of sides)for(let retry=0;;retry++){
    try{if((await fetch(side.base+side.health)).status===200)break;}catch{}
    assert.ok(retry<60,'production application did not start');await delay(250);
  }
  const password='private-parity-test-password',hashStart=Date.now(),hash=await hashPassword(password);
  t.diagnostic('PBX fixture password hash: '+(Date.now()-hashStart)+'ms');
  for(const side of sides){
    await truncateFixture(side.db, 'TRUNCATE pbx_webhooks.call_ended_events,recordings,call_utterances,call_sessions RESTART IDENTITY CASCADE');
    await truncateFixture(side.identity, 'TRUNCATE admin_users,audit_logs RESTART IDENTITY CASCADE');
    await side.identity.query("INSERT INTO admin_users(admin_user_seq,login_id,name,password_hash,role,status,created_at) OVERRIDING SYSTEM VALUE VALUES(1,'operator','비교 운영자',$1,'OPERATOR','ACTIVE','2026-01-01T00:00:00Z')",[hash]);
    await side.db.query(`INSERT INTO call_sessions(provider_call_id,caller_phone_number,incoming_at,registered_at,deleted_at) VALUES
      ('unique','01098880001','2026-10-27T01:00:00Z','2026-10-27T01:00:00Z',NULL),
      ('legacy','01098880002',NULL,NULL,NULL),
      ('hidden','01098880003','2026-10-27T01:00:00Z','2026-10-27T01:00:00Z','2026-10-28T00:00:00Z'),
      ('ambiguous-one','01098880004','2026-10-27T01:00:00Z','2026-10-27T01:00:00Z',NULL),
      ('ambiguous-two','01098880004','2026-10-27T01:00:00Z','2026-10-27T01:00:00Z',NULL)`);
  }
  const normalize=value=>{
    if(value instanceof Date){assert.ok(value.getTime()>=started-1000&&value.getTime()<=Date.now()+1000);return'<received-time>';}
    if(Array.isArray(value))return value.map(normalize);
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>{
      if(['observedAt','expiresAt','lastLoginAt'].includes(key)&&typeof item==='string'){
        const time=Date.parse(item);assert.ok(Number.isFinite(time));
        if(key==='expiresAt')assert.ok(Math.abs(time-Date.now()-9*3600_000)<15000);
        else assert.ok(time>=started-1000&&time<=Date.now()+1000);
        item=key==='expiresAt'?'<nine-hours>':'<observed-time>';
      }
      return[key,normalize(item)];
    }));
    return value;
  };
  const sql=[
    // Monolith 047 retired end_reason; MSA retains that legacy field without exposing or writing it.
    'SELECT call_session_seq,order_seq,provider_call_id,caller_phone_number,incoming_at::text,registered_at::text,started_at::text,ended_at::text,deleted_at::text FROM call_sessions ORDER BY call_session_seq',
    'SELECT recording_id,payload,received_at,processing_status,call_session_seq,last_attempt_at,claim_id,claimed_until FROM pbx_webhooks.call_ended_events ORDER BY recording_id',
    'SELECT recording_seq,call_session_seq,object_key FROM recordings ORDER BY recording_seq'];
  async function compare(){for(const statement of sql)assert.deepEqual(normalize((await consultation.query(statement)).rows),normalize((await mono.query(statement)).rows),statement);}
  let requests=0;
  async function request(method,path,body,status,options={}){
    const requestId=randomUUID(),results=[];
    for(const side of sides){
      const auth=path.startsWith('/api/auth/'),url=(auth?side.auth:side.base)+(options.proxy&&side===sides[1]?'/api'+path:path);
      // Password hashing shares the CI daemon's single CPU with the other parity containers.
      const requestTimeout=path==='/api/auth/login'?30000:10000;
      const began=Date.now();let response,text;
      try{
        response=await fetch(url,{method,redirect:'error',signal:AbortSignal.timeout(requestTimeout),headers:{Origin:options.origin??origin,'X-Request-Id':requestId,
          ...(side.cookie&&options.session!==false?{Cookie:side.cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json'}),
          ...(options.bearer===undefined?{}:{Authorization:'Bearer '+options.bearer})},body:body===undefined?undefined:JSON.stringify(body)});
        text=await response.text();
      }catch(error){
        let activity;try{activity=(await side.db.query({text:"SELECT state,wait_event_type,wait_event,pg_blocking_pids(pid) AS blockers,left(query,180) AS query FROM pg_stat_activity WHERE usename=current_user AND pid<>pg_backend_pid()",query_timeout:1500})).rows;}catch{activity='unavailable';}
        console.error('PBX request diagnostic '+JSON.stringify({method,url,elapsedMs:Date.now()-began,activity}));
        throw new Error(method+' '+url+' failed after '+(Date.now()-began)+'ms',{cause:error});
      }
      if(options.login)t.diagnostic('PBX login '+side.base+': '+(Date.now()-began)+'ms');
      assert.equal(response.status,status,method+' '+path+' '+text);
      const cookie=response.headers.get('set-cookie');
      if(options.login){assert.match(cookie,/^dva_session=[a-f0-9]{64};/);assert.match(cookie,/; Secure/);side.cookie=cookie.split(';')[0];}
      const data=text?normalize(JSON.parse(text)):undefined;
      results.push({data,requestId:response.headers.get('x-request-id'),cors:response.headers.get('access-control-allow-origin'),
        cache:response.headers.get('cache-control'),cookie:cookie?.replace(/^dva_session=[^;]*/,'dva_session=<opaque>').replace(/Expires=[^;]+/,'Expires=<valid>')});
    }
    assert.deepEqual(results[1],results[0],method+' '+path);await compare();requests++;return results[0].data;
  }
  await request('GET','/api/calls/active-count',undefined,401,{session:false});
  await request('GET','/api/calls/active-count/stream',undefined,401,{session:false});
  await request('POST','/api/auth/login',{loginId:'operator',password},200,{login:true,session:false});
  assert.equal((await request('GET','/api/calls/active-count',undefined,200)).data.activeCallCount,3);
  const payload={recordingId:'parity-recording',callFrom:'+821098880001',callTo:'07012345678',startedAt:'2026-10-27T01:00:00Z',endedAt:'2026-10-27T01:03:00Z',durationSeconds:180,recordingUrl:'https://recordings.example.test/audio.mp3?signed=private-test'};
  await request('POST','/webhooks/pbx/call-ended',payload,401);
  await request('POST','/webhooks/pbx/call-ended',payload,401,{bearer:'incorrect'});
  for(const change of [{durationSeconds:'180'},{startedAt:'2026-02-30T00:00:00Z'},{recordingUrl:'http://recordings.example.test/audio.mp3'},{recordingId:'bad\u0000id'}])
    await request('POST','/webhooks/pbx/call-ended',{...payload,...change},400,{bearer:pbx});
  await request('POST','/webhooks/pbx/call-ended',payload,200,{bearer:pbx});
  await request('POST','/webhooks/pbx/call-ended',payload,200,{bearer:pbx,proxy:true});
  await request('POST','/webhooks/pbx/call-ended',{...payload,startedAt:'2026-10-27T10:00:00+09:00',ignoredProviderField:true},200,{bearer:pbx});
  await request('POST','/webhooks/pbx/call-ended',{...payload,callTo:'07000000000'},409,{bearer:pbx});
  assert.equal((await request('GET','/api/calls/active-count',undefined,200)).data.activeCallCount,2);
  await request('POST','/webhooks/pbx/call-ended',{...payload,recordingId:'ambiguous',callFrom:'01098880004'},200,{bearer:pbx});
  await request('POST','/webhooks/pbx/call-ended',{...payload,recordingId:'expired',startedAt:'2020-01-01T00:00:00Z',endedAt:'2020-01-01T00:03:00Z'},200,{bearer:pbx});
  const docs=await Promise.all(sides.map(async side=>(await fetch(side.base+'/api/docs-json')).json()));
  for(const [path,method]of[['/api/calls/active-count','get'],['/api/calls/active-count/stream','get'],['/webhooks/pbx/call-ended','post']])
    assert.deepEqual(docs[1].paths[path][method],docs[0].paths[path][method],path+' OpenAPI');
  const seen=new Set();function schemas(value){if(Array.isArray(value)){for(const item of value)schemas(item);}else if(value&&typeof value==='object'){
    if(value.$ref){const name=value.$ref.replace('#/components/schemas/','');if(seen.has(name))return;seen.add(name);assert.deepEqual(docs[1].components.schemas[name],docs[0].components.schemas[name],name);schemas(docs[0].components.schemas[name]);}
    for(const item of Object.values(value))schemas(item);
  }}
  for(const path of ['/api/calls/active-count','/api/calls/active-count/stream','/webhooks/pbx/call-ended'])schemas(docs[0].paths[path]);
  async function stream(side){
    const abort=new AbortController();t.after(()=>abort.abort());
    const response=await fetch(side.base+'/api/calls/active-count/stream',{headers:{Cookie:side.cookie},signal:abort.signal});
    assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/^text\/event-stream/);assert.equal(response.headers.get('x-accel-buffering'),'no');
    const reader=response.body.getReader(),decoder=new TextDecoder();let buffered='';
    return{async next(type){
      for(;;){const end=buffered.indexOf('\n\n');if(end>=0){const frame=buffered.slice(0,end);buffered=buffered.slice(end+2);
        const event=frame.split('\n').find(line=>line.startsWith('event:'))?.slice(6).trim();const data=frame.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim()).join('\n');
        if(event===type)return normalize(JSON.parse(data));continue;}
        let timer,read;
        try{read=await Promise.race([reader.read(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('SSE frame timed out: '+type)),12000);})]);}
        finally{clearTimeout(timer);}
        assert.equal(read.done,false,'SSE ended before '+type);buffered+=decoder.decode(read.value,{stream:true}).replaceAll('\r\n','\n');
      }
    },async ended(){
      let timer;
      try{const end=await Promise.race([reader.read(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('SSE did not close after session revocation')),3000);})]);assert.equal(end.done,true);}
      finally{clearTimeout(timer);}
    }};
  }
  const streams=[];for(const side of sides)streams.push(await stream(side));
  const initial=await Promise.all(streams.map(s=>s.next('active-call-count')));assert.deepEqual(initial[1],initial[0]);assert.equal(initial[0].activeCallCount,2);
  for(const side of sides)await side.db.query("INSERT INTO call_sessions(provider_call_id,caller_phone_number,incoming_at,registered_at) VALUES('sse-change','01090000000','2026-10-27T01:00:00Z','2026-10-27T01:00:00Z'); SELECT pg_notify('call_sessions_changed','')");
  const changed=await Promise.all(streams.map(s=>s.next('active-call-count')));assert.deepEqual(changed[1],changed[0]);assert.equal(changed[0].activeCallCount,3);
  for(const side of sides){
    await side.db.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename=current_user AND pid<>pg_backend_pid() AND query='LISTEN call_sessions_changed'");
    await side.db.query("UPDATE call_sessions SET deleted_at='2026-10-28T00:00:00Z' WHERE provider_call_id='sse-change'");
  }
  const recovered=await Promise.all(streams.map(s=>s.next('active-call-count')));assert.deepEqual(recovered[1],recovered[0]);assert.equal(recovered[0].activeCallCount,2);
  const heartbeats=await Promise.all(streams.map(s=>s.next('heartbeat')));assert.deepEqual(heartbeats[1],heartbeats[0]);
  await request('POST','/api/auth/logout',{},204);
  const expired=await Promise.all(streams.map(s=>s.next('session-expired')));assert.deepEqual(expired,[{code:'UNAUTHORIZED'},{code:'UNAUTHORIZED'}]);
  await Promise.all(streams.map(s=>s.ended()));
  await request('GET','/api/calls/active-count',undefined,401);
  t.diagnostic(`${requests} identical production HTTP requests, three OpenAPI operations, SSE updates/listener recovery/session revocation and PBX business rows compared`);
});
