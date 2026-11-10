require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { hashPassword } = require('../dist/auth/password');

test('FAQ production APIs preserve HTTP, snapshots, audits and durable notification intent', async (t) => {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.PGDATABASE, 'dva_webhook_test');
  const began = Date.now();
  assert.equal((await fetch('http://consultation-app:3004/consultation/health')).status,200,'FAQ source peer must finish schema/config startup');
  const sides = ['monolith', 'operations'].map((name) => ({
    name, base: `http://${name}-app:3005`, db: new Pool({ host: name+'-db' }), cookies: [],
  }));
  const consultation = new Pool({ host: 'consultation-db' });
  t.after(async () => { await Promise.all([...sides.map((s) => s.db.end()), consultation.end()]); });
  const hash = await hashPassword('faq-parity-password');
  for (const side of sides) {
    await side.db.query(`DELETE FROM faq_entries; DELETE FROM faq_change_notifications;
      DELETE FROM audit_logs WHERE action LIKE 'FAQ_%';
      ALTER TABLE faq_entries ALTER COLUMN faq_entry_seq RESTART WITH 10001;
      ALTER TABLE faq_change_notifications ALTER COLUMN faq_change_notification_seq RESTART WITH 10001;
      ALTER TABLE faq_question_examples ALTER COLUMN faq_question_example_seq RESTART WITH 10001;`);
    for (const [i, role] of ['OPERATOR','SUPERVISOR','SYSTEM_ADMIN'].entries()) {
      await side.db.query(`INSERT INTO admin_users(admin_user_seq,login_id,name,password_hash,role,status)
        OVERRIDING SYSTEM VALUE VALUES($1,$2,'FAQ 비교 관리자',$3,$4,'ACTIVE')`, [1000001+i,'faqparity'+i,hash,role]);
      const response = await fetch(side.base+'/api/auth/login', { method:'POST',
        headers:{ Origin:'http://localhost:5173','Content-Type':'application/json' },
        body:JSON.stringify({loginId:'faqparity'+i,password:'faq-parity-password'}) });
      assert.equal(response.status,200,await response.clone().text());
      side.cookies.push(response.headers.get('set-cookie').split(';')[0]);
    }
  }
  function normalized(value, key='') {
    if (value === null) return value;
    if (value instanceof Date || /(?:At|_at)$/.test(key)) {
      const date = new Date(value), n=date.getTime();
      assert.ok(Number.isFinite(n));
      if (n >= began-2000) { assert.ok(n<=Date.now()+300_000,key); return '<now>'; }
      return date.toISOString();
    }
    if (Array.isArray(value)) return value.map((v) => normalized(v));
    if (value && typeof value==='object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,normalized(v,k)]));
    return value;
  }
  async function state(side) {
    const faqs=(await side.db.query('SELECT * FROM faq_entries ORDER BY faq_entry_seq')).rows;
    const examples=(await side.db.query('SELECT * FROM faq_question_examples ORDER BY faq_question_example_seq')).rows;
    const queue=(await side.db.query('SELECT * FROM faq_change_notifications ORDER BY faq_change_notification_seq')).rows;
    for(const row of queue) { assert.match(row.event_id,/^[0-9a-f-]{36}$/); row.event_id='<notification:'+row.faq_change_notification_seq+'>'; }
    const audits=(await side.db.query(`SELECT actor_type,actor_seq,actor_name,action,target_type,target_seq,
      request_id,result,metadata,occurred_at FROM audit_logs WHERE action LIKE 'FAQ_%' ORDER BY audit_log_seq`)).rows;
    return normalized({faqs,examples,queue,audits});
  }
  let pairs=0;
  async function pair(method,path,body,status=200,actor=0,extra={}) {
    const id=randomUUID(), results=[];
    for (const side of sides) {
      const headers={Origin:'http://localhost:5173','X-Request-Id':id,
        ...(path.startsWith('/api/ai/faqs')?{Authorization:'Bearer '+process.env.PGPASSWORD}:{}),
        ...(actor===null?{}:{Cookie:side.cookies[actor]}),
        ...(body===undefined?{}:{'Content-Type':'application/json'}),...extra};
      for(const key of Object.keys(headers)) if(headers[key]===undefined) delete headers[key];
      const response=await fetch(side.base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
      const text=await response.text();
      assert.equal(response.status,status,side.name+' '+method+' '+path+' '+text);
      assert.equal(response.headers.get('x-request-id'),id);
      assert.equal(response.headers.get('cache-control'),'no-store');
      results.push({body:text?normalized(JSON.parse(text)):null,location:response.headers.get('location'),
        cors:response.headers.get('access-control-allow-origin'),credentials:response.headers.get('access-control-allow-credentials')});
    }
    assert.deepEqual(results[1],results[0],method+' '+path);
    assert.deepEqual(await state(sides[1]),await state(sides[0]),method+' '+path+' business rows');
    pairs++;
    return results[0];
  }
  const faq=(question,category='기타')=>({question,category,answer:'문단\n\n|표|값|\n|--|--|\n|A|B|'});
  await pair('GET','/api/faqs',undefined,401,null);
  await pair('POST','/api/faqs',{items:[faq('금지')]},401,null);
  for(let i=0;i<3;i++) {
    const result=await pair('POST','/api/faqs',{items:[faq('역할 FAQ '+i)]},204,i);
    assert.equal(result.location,'/api/faqs/'+(10001+i));
    await pair('GET','/api/faqs/'+(10001+i),undefined,200,i);
    await pair('PATCH','/api/faqs/'+(10001+i),faq('역할 수정 '+i,'접수'),204,i);
  }
  await pair('POST','/api/faqs',{items:[faq('Café 100%_'),faq('배송 질문','배송·운송장')]},204);
  for(const suffix of ['', '?limit=1&offset=0','?limit=1&offset=999','?q=Cafe%CC%81','?q=%25_','?category=접수','?q=없는검색'])
    await pair('GET','/api/faqs'+suffix);
  for(const suffix of ['', '?faqEntrySeqs=10001,10005,2147483647&limit=1','?q=Cafe%CC%81','?limit=1&offset=999']) {
    const result=await pair('GET','/api/ai/faqs'+suffix,undefined,200,null);
    for(const row of result.body.data) assert.deepEqual(Object.keys(row).sort(),['answer','faqEntrySeq','question','updatedAt']);
  }
  await pair('GET','/api/ai/faqs/10001',undefined,404,null);
  await pair('GET','/api/ai/faqs?category=기타',undefined,400,null);
  await pair('GET','/api/ai/faqs',undefined,401,null,{Cookie:'dva_session=invalid'});
  // Source AuthGuard requires Origin on writes; authenticated GET remains valid without it.
  await pair('GET','/api/ai/faqs',undefined,200,0,{Origin:undefined});
  await pair('PATCH','/api/faqs/10001',faq('Origin 거절'),403,0,{Origin:undefined});
  for(const body of [faq('배열 필요'),{items:[]},{items:[null]},{items:[{...faq('미분류'),category:'전체'}]},
    {items:[faq('  ')]},{items:[{...faq('NUL'),answer:'a\0b'}]},{items:[faq('x'.repeat(1001))]},
    {items:[faq('동일'),faq('동일')]}]) await pair('POST','/api/faqs',body,body.items?.length===2?409:400);
  await pair('POST','/api/faqs',{items:[faq('  역할   수정 0  ')]},409);
  await pair('PATCH','/api/faqs/10001',{answer:'부분 수정'},400);
  await pair('PATCH','/api/faqs/10001',faq('역할 수정 1'),409);
  await pair('PATCH','/api/faqs/2147483647',faq('없음'),404);
  await pair('DELETE','/api/faqs',{faqEntrySeqs:[10001,2147483647]},404);
  await pair('DELETE','/api/faqs',{faqEntrySeqs:[10001,10001]},400);
  for(const suffix of ['?limit=0','?q='+('x'.repeat(201)),'?category=unknown']) await pair('GET','/api/faqs'+suffix,undefined,400);
  await pair('GET','/api/ai/faqs?faqEntrySeqs=1,1',undefined,400,null);
  await pair('GET','/api/faqs/not-an-id',undefined,400);
  await pair('GET','/api/faqs/2147483647',undefined,404);
  // Pre-existing business rows test reads independently of the not-yet-ported event producer.
  const sourceIds=Array.from({length:13},()=>randomUUID());
  for(const db of [sides[0].db,consultation]) {
    await db.query(`INSERT INTO call_sessions(call_session_seq,provider_call_id,incoming_at)
      OVERRIDING SYSTEM VALUE VALUES(900001,'faq-source-call','2026-10-01Z')`);
    for(const [i,id] of sourceIds.entries()) await db.query(`INSERT INTO call_insight_events(event_id,
      call_session_seq,event_order,kind,occurred_at,payload,payload_hash)
      VALUES($1,900001,$2,'BUSINESS_RESULT','2026-10-01Z','{"action":"FAQ_ANSWERED"}',repeat('a',64))`,[id,i+1]);
  }
  for(const side of sides) for(const [i,id] of sourceIds.entries()) await side.db.query(`INSERT INTO faq_question_examples(
    faq_entry_seq,event_id,question_text,occurred_at) VALUES(10001,$1,$2,'2026-10-01Z'::timestamptz+make_interval(secs=>$3))`,[id,'고객 실제 질문 '+i,i]);
  let detail=await pair('GET','/api/faqs/10001');
  assert.equal(detail.body.data.recentQuestions.length,10);
  assert.equal(detail.body.data.recentQuestions[0].questionText,'고객 실제 질문 12');
  assert.ok(detail.body.data.recentQuestions.every((e)=>e.callSessionSeq===900001&&!('eventId' in e)));
  for(const [db,sql] of [[sides[0].db,"UPDATE call_sessions SET deleted_at=clock_timestamp() WHERE call_session_seq=900001"],
    [consultation,"UPDATE call_sessions SET deleted_at=clock_timestamp() WHERE call_session_seq=900001"]]) await db.query(sql);
  detail=await pair('GET','/api/faqs/10001');
  assert.ok(detail.body.data.recentQuestions.every((e)=>e.callSessionSeq===null));
  for(const db of [sides[0].db,consultation]) await db.query("UPDATE call_sessions SET deleted_at=NULL,incoming_at='2001-01-01Z' WHERE call_session_seq=900001");
  detail=await pair('GET','/api/faqs/10001');
  assert.ok(detail.body.data.recentQuestions.every((e)=>e.callSessionSeq===null));
  for(const db of [sides[0].db,consultation]) await db.query("UPDATE call_sessions SET incoming_at=NULL WHERE call_session_seq=900001; DELETE FROM call_insight_events WHERE call_session_seq=900001");
  detail=await pair('GET','/api/faqs/10001');
  assert.ok(detail.body.data.recentQuestions.every((e)=>e.callSessionSeq===null));
  for(const side of sides) await side.db.query("UPDATE faq_question_examples SET occurred_at='2001-01-01Z'");
  detail=await pair('GET','/api/faqs/10001');
  assert.deepEqual(detail.body.data.recentQuestions,[]);
  // Hold the real consultation read while a concurrent FAQ edit tries to reset its snapshot.
  const raceEvent=randomUUID(),raceAt=new Date().toISOString();
  for(const db of [sides[0].db,consultation]) {
    await db.query("INSERT INTO call_sessions(call_session_seq,provider_call_id) OVERRIDING SYSTEM VALUE VALUES(900003,'faq-race-source')");
    await db.query("INSERT INTO call_insight_events(event_id,call_session_seq,event_order,kind,occurred_at,payload,payload_hash) VALUES($1,900003,1,'BUSINESS_RESULT',$2,'{}',repeat('a',64))",[raceEvent,raceAt]);
  }
  for(const side of sides) await side.db.query("INSERT INTO faq_question_examples(faq_entry_seq,event_id,question_text,occurred_at) VALUES(10003,$1,'동시 고객 질문',$2)",[raceEvent,raceAt]);
  const blocker=await consultation.connect(),getId=randomUUID(),patchId=randomUUID();
  let read,edit,finished=false;
  try {
    await blocker.query('BEGIN');await blocker.query('LOCK TABLE call_insight_events IN ACCESS EXCLUSIVE MODE');
    read=fetch(sides[1].base+'/api/faqs/10003',{headers:{Cookie:sides[1].cookies[0],'X-Request-Id':getId}});
    const limit=Date.now()+2000;
    for(;;) {
      const active=(await consultation.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM call_insight_events%'")).rows[0].n;
      if(active) break;
      assert.ok(Date.now()<limit,'private call lookup did not reach the blocked table');
      await new Promise((resolve)=>setTimeout(resolve,20));
    }
    edit=fetch(sides[1].base+'/api/faqs/10003',{method:'PATCH',headers:{Origin:'http://localhost:5173',Cookie:sides[1].cookies[0],'X-Request-Id':patchId,'Content-Type':'application/json'},body:JSON.stringify(faq('동시 수정 완료'))}).then((response)=>{finished=true;return response;});
    await new Promise((resolve)=>setTimeout(resolve,100));
    assert.equal(finished,false,'FAQ must remain stable until its cross-service source read finishes');
    await blocker.query('ROLLBACK');
    const actual=await read,changed=await edit;
    assert.equal(actual.status,200);assert.equal(changed.status,204);
    const actualBody=await actual.json();assert.equal(actualBody.data.recentQuestions[0].callSessionSeq,900003);
    const source=await fetch(sides[0].base+'/api/faqs/10003',{headers:{Cookie:sides[0].cookies[0],'X-Request-Id':getId}});
    assert.equal(source.status,200);assert.deepEqual(normalized(actualBody),normalized(await source.json()));
    const sourceEdit=await fetch(sides[0].base+'/api/faqs/10003',{method:'PATCH',headers:{Origin:'http://localhost:5173',Cookie:sides[0].cookies[0],'X-Request-Id':patchId,'Content-Type':'application/json'},body:JSON.stringify(faq('동시 수정 완료'))});
    assert.equal(sourceEdit.status,204);assert.deepEqual(await state(sides[1]),await state(sides[0]));
    pairs+=2;
  } finally {
    await blocker.query('ROLLBACK');blocker.release();
    await Promise.allSettled([read,edit].filter(Boolean));
  }
  await pair('PATCH','/api/faqs/10001',faq('사례 초기화'),204);
  await pair('DELETE','/api/faqs',{faqEntrySeqs:[10001,10002]},204);
  await pair('GET','/api/faqs/10001',undefined,404);
  await pair('POST','/api/faqs',{items:[faq('사례 초기화')]},204);
  // Private lookup validates source/type/IDs and stays outside public Swagger/Ingress.
  const endpoint='http://consultation-app:3004/internal/faq-call-sources';
  const event={eventId:randomUUID(),source:'operations',eventType:'FaqCallSourcesRequested',payload:{eventIds:[sourceIds[0]]}};
  for(const [body,token,status] of [[event,'wrong',403],[{},process.env.CONSULTATION_AUTH_TOKEN,400],
    [{...event,source:'customer'},process.env.CONSULTATION_AUTH_TOKEN,422],
    [{...event,payload:{eventIds:[]}},process.env.CONSULTATION_AUTH_TOKEN,422],
    [{...event,payload:{eventIds:[sourceIds[0],sourceIds[0].toUpperCase()]}},process.env.CONSULTATION_AUTH_TOKEN,422],
    [event,process.env.CONSULTATION_AUTH_TOKEN,200]]) {
    const response=await fetch(endpoint,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});
    assert.equal(response.status,status,await response.clone().text());
  }
  const spec=await (await fetch('http://consultation-app:3004/consultation/docs-json')).json();
  assert.ok(!Object.keys(spec.paths).some((path)=>path.includes('faq-call-sources')));
  // Keep only a deterministic pair of pending business notifications for the real worker crash test.
  const first=randomUUID(),second=randomUUID(),requestId=randomUUID();
  for(const side of sides) {
    assert.ok((await side.db.query('SELECT * FROM faq_change_notifications')).rows.every((r)=>r.attempts===0&&r.sent_at===null));
    await side.db.query('DELETE FROM faq_change_notifications');
    await side.db.query(`INSERT INTO faq_change_notifications(event_id,operation,faq_entry_seqs,request_id)
      VALUES($1,'INSERT',ARRAY[10003],$3),($2,'DELETE',ARRAY[10001],$3)`,[first,second,requestId]);
  }
  console.log(JSON.stringify({httpPairs:pairs,recentQuestionReadOnlyFixture:true,notificationIds:[first,second]}));
});
