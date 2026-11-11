const { truncateFixture } = require('./fixture-reset.cjs');
require('reflect-metadata');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID,createHash}=require('node:crypto');
const {Pool}=require('pg');
const {DatabaseService}=require('../dist/database/database.service');
const {AuditService}=require('../dist/audit/audit.service');
const {BillingService}=require('../dist/billing/billing.service');
const {OrganizationBillingService:SourceBilling}=require('./monolith-runtime/organizations/organization-billing.service');
const {OrganizationBillingRepository:SourceRepository}=require('./monolith-runtime/organizations/organization-billing.repository');
const {AuditService:SourceAudit}=require('./monolith-runtime/audit/audit.service');
const {AuditRepository:SourceAuditRepository}=require('./monolith-runtime/audit/audit.repository');
const {DatabaseService:SourceDatabase}=require('./monolith-runtime/database/database.service');
const {requestBilling}=require('@dva/events/billing.cjs');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(work,label){for(let n=0;n<100;n++){if(await work())return;await pause(30);}assert.fail(label);}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test('billing HTTP, snapshots, monthly initialization and audit groups match the source on separated owner DBs',async t=>{
  assert.equal(process.env.PGDATABASE,'dva_webhook_test');
  const pools=Object.fromEntries(['monolith','order','customer','operations'].map(name=>[name,new Pool({host:name+'-db',user:name+'_app'})]));
  const values={DB_HOST:'order-db',DB_PORT:5432,DB_USER:'order_app',DB_PASSWORD:process.env.PGPASSWORD,DB_NAME:'dva_webhook_test',
    CUSTOMER_URL:'http://customer-app:3001',OPERATIONS_URL:'http://operations-app:3005',CUSTOMER_AUTH_TOKEN:process.env.CUSTOMER_AUTH_TOKEN};
  const config={get:key=>values[key]},db=new DatabaseService(config),audit=new AuditService(db,config),billing=new BillingService(db,audit,config);
  const sourceDb=new SourceDatabase({get:key=>({...values,DB_HOST:'monolith-db',DB_USER:'monolith_app'})[key]});
  const source=new SourceBilling(sourceDb,new SourceRepository(sourceDb),new SourceAudit(new SourceAuditRepository(sourceDb)));
  t.after(async()=>{await Promise.all([db.onModuleDestroy(),sourceDb.onModuleDestroy(),...Object.values(pools).map(pool=>pool.end())]);});
  const sides=[{url:'http://monolith-app:3000',org:pools.monolith,ledger:pools.monolith,audit:pools.monolith},
    {url:'http://customer-app:3001',org:pools.customer,ledger:pools.order,audit:pools.operations}];
  for(const [name,port] of [['monolith',3000],['customer',3001],['order',3002]])await until(async()=>{
    try{return(await fetch(`http://${name}-app:${port}/${name==='monolith'?'api':name}/docs-json`)).ok;}catch{return false;}
  },name+' billing app start');
  for(const side of sides){
    await truncateFixture(side.org, 'TRUNCATE organizations RESTART IDENTITY CASCADE');
    await truncateFixture(side.ledger, 'TRUNCATE organization_billing_months,order_billing_charges');
    await truncateFixture(side.audit, 'TRUNCATE audit_logs');
  }
  for(const side of sides){
    const adminDb=side.audit;
    for(const [n,role] of ['OPERATOR','SUPERVISOR','SYSTEM_ADMIN'].entries()){
      await adminDb.query("INSERT INTO admin_users(admin_user_seq,login_id,name,password_hash,role,status) OVERRIDING SYSTEM VALUE VALUES($1,$2,'청구 검증 관리자','fixture-not-for-login',$3,'ACTIVE') ON CONFLICT(admin_user_seq) DO UPDATE SET status='ACTIVE',deleted_at=NULL,role=EXCLUDED.role",[n+1,'billingvalidation'+n,role]);
      await adminDb.query("INSERT INTO admin_sessions(session_token_hash,admin_user_seq,expires_at) VALUES($1,$2,'2094-01-01Z') ON CONFLICT(session_token_hash) DO UPDATE SET expires_at=EXCLUDED.expires_at",[createHash('sha256').update(['a','b','c'][n].repeat(64)).digest('hex'),n+1]);
    }
  }
  // The billing tests run with NODE_ENV=test on both order producers; production timers are exercised separately.
  const rows=async side=>(await side.ledger.query('SELECT organization_seq,billing_month::text,monthly_amount::text,group_billing_amount::text,organization_name FROM organization_billing_months ORDER BY organization_seq,billing_month')).rows;
  const auditRows=async side=>(await side.audit.query("SELECT * FROM audit_logs WHERE action='BILLING_MONTH_INITIALIZED' ORDER BY audit_log_seq")).rows;
  const organizationRows=async side=>(await side.org.query('SELECT to_jsonb(o) AS row FROM organizations o ORDER BY organization_seq')).rows;
  const orderBusiness=['orders','order_parcels','order_payment_requests','order_billing_charges','empty_ai_order_results'];
  const stable=async()=>Promise.all(sides.map(async side=>{const result={};for(const table of orderBusiness)result[table]=(await side.ledger.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;return result;}));
  const originalBusiness=await stable();
  let id=40000,compared=0;
  async function company({status='ACTIVE',deleted=false,name='청구 회사',monthly=false}={}){
    id++;
    for(const side of sides)await side.org.query(`INSERT INTO organizations(organization_seq,name,status,deleted_at,monthly_billing_enabled,created_at)
      OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4,$5,'2025-01-01Z')`,[id,name,status,deleted?'2026-01-01Z':null,monthly]);
    return id;
  }
  async function ledger(id,month,{name='보존 이름',monthly=12345,group=67890}={}){
    for(const side of sides)await side.ledger.query(`INSERT INTO organization_billing_months(organization_seq,billing_month,organization_name,monthly_amount,group_billing_amount)
      VALUES($1,$2::date,$3,$4,$5)`,[id,month,name,monthly,group]);
  }
  async function compare(id,query='',status=200,headers={Cookie:'dva_session='+'a'.repeat(64)}){
    const requestId=randomUUID(),before=await Promise.all(sides.map(rows)),orgs=await Promise.all(sides.map(organizationRows));
    const responses=[];
    for(const side of sides){const r=await fetch(side.url+'/api/companies/'+id+'/billing'+query,{headers:{...headers,'X-Request-Id':requestId}});
      const body=await r.json();assert.equal(r.headers.get('x-request-id'),requestId);responses.push({status:r.status,body,cache:r.headers.get('cache-control')});}
    assert.equal(responses[0].status,status,JSON.stringify(responses));assert.deepEqual(responses[1],responses[0]);
    assert.deepEqual(await Promise.all(sides.map(rows)),before,'GET must not initialize or change amounts');
    assert.deepEqual(await Promise.all(sides.map(organizationRows)),orgs,'GET must not change customer owner data');
    compared++;return responses[0].body.data;
  }
  async function equalState(start,end){
    assert.deepEqual(await rows(sides[1]),await rows(sides[0]),'all ledger fields');
    const logs=await Promise.all(sides.map(auditRows));
    for(const log of logs){
      const seen=new Map();
      for(const row of log){assert.match(row.request_id,uuid);const at=Date.parse(row.occurred_at);assert.ok(at>=start-1000&&at<=end+1000);
        const key=row.target_seq+':'+row.metadata.billingMonth;
        if(seen.has(key))assert.equal(row.request_id,seen.get(key));else seen.set(key,row.request_id);
      }
      assert.equal(seen.size*2,log.length,'one UUID for each credit/group pair');
      assert.equal(new Set(log.filter(row=>row.metadata.paymentMethodType==='credit').map(row=>row.request_id)).size,seen.size);
    }
    const normalize=log=>log.map(({audit_log_seq,request_id,occurred_at,...row})=>row);
    assert.deepEqual(normalize(logs[1]),normalize(logs[0]),'audit order, actor/name/target/result and complete metadata');
  }
  const start=Date.now();
  await t.test('public route and every referenced OpenAPI schema equal the source',async()=>{
    const docs=[];for(const [name,port] of [['monolith',3000],['customer',3001]])docs.push(await(await fetch(`http://${name}-app:${port}/${name==='monolith'?'api':name}/docs-json`)).json());
    const path='/api/companies/{id}/billing';assert.deepEqual(docs[1].paths[path],docs[0].paths[path]);
    const visit=(value,seen=new Set())=>{for(const match of JSON.stringify(value).matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g)){
      if(seen.has(match[1]))continue;seen.add(match[1]);assert.deepEqual(docs[1].components.schemas[match[1]],docs[0].components.schemas[match[1]]);visit(docs[0].components.schemas[match[1]],seen);
    }};visit(docs[0].paths[path]);assert.ok(!Object.keys(docs[1].paths).some(path=>path.startsWith('/internal/')));
  });
  await t.test('existing and deleted companies, historical names, nullable snapshots and full safe-integer balances',async()=>{
    const active=await company({name:'현재 이름'}),inactive=await company({status:'INACTIVE'}),deleted=await company({deleted:true});
    assert.equal((await compare(active)).monthlyAmount,0);await compare(inactive,'?month=2035-03');
    await compare(active,'?month=1000-01');await compare(active,'?month=9999-12');await compare(active,'/?month=2035-03');
    await ledger(active,'2035-01-01',{name:'이전 기업명',monthly:Number.MAX_SAFE_INTEGER,group:2147483648});
    await ledger(deleted,'2035-01-01',{name:'삭제 전 회사'});
    await ledger(active,'2035-02-01',{name:null,monthly:0,group:0});
    assert.equal((await compare(active,'?month=2035-01')).organizationName,'이전 기업명');
    assert.equal((await compare(active,'?month=2035-02')).organizationName,'현재 이름');
    await compare(deleted,'?month=2035-01');await compare(deleted,'?month=2035-02',404);await compare(2147483647,'',404);
    // The source retains an orphaned historical month even after physical company removal.
    for(const side of sides)await side.org.query('DELETE FROM organizations WHERE organization_seq=$1',[deleted]);
    await compare(deleted,'?month=2035-01');
    const deletedNull=await company({deleted:true});await ledger(deletedNull,'2035-01-01',{name:null});assert.equal((await compare(deletedNull,'?month=2035-01')).organizationName,null);
    for(const query of ['?month=','?month=%202026-01','?month=2026-00','?month=2026-13','?month=0000-01','?month=0999-01','?month=2026-1','?month=2026-01-01','?month=2026-01&month=2026-02','?unexpected=1'])await compare(active,query,400);
    for(const bad of ['0','-1','1.5','2147483648','no'])await compare(bad,'',400);
    for(const headers of [{},{Authorization:'Bearer '+process.env.CUSTOMER_AUTH_TOKEN},{Cookie:'dva_session=wrong'},{Cookie:'dva_session='+'a'.repeat(64)+'; dva_session='+'a'.repeat(64)}])await compare(active,'',401,headers);
    for(const roleToken of ['b','c'])await compare(active,'',200,{Cookie:'dva_session='+roleToken.repeat(64)});
    assert.deepEqual(await Promise.all(sides.map(auditRows)),[[],[]],'reads have no success or failure billing audit');
  });
  await t.test('Seoul month and year boundaries, missing months, future max-month and deleted/INACTIVE rules',async()=>{
    const a=await company({name:'월 경계',status:'INACTIVE'}),b=await company({deleted:true}),c=await company();
    await ledger(a,'2034-12-01',{monthly:Number.MAX_SAFE_INTEGER,group:777});await ledger(b,'2034-12-01');await ledger(c,'2035-05-01');
    const orgs=await Promise.all(sides.map(organizationRows));
    for(const now of ['2034-12-31T14:59:59.999Z','2034-12-31T15:00:00.000Z','2035-03-31T15:00:00.000Z']){
      await source.rollover(new Date(now));await billing.rollover(new Date(now));await equalState(start,Date.now());
    }
    const records=(await rows(sides[0])).filter(row=>row.organization_seq===a);assert.deepEqual(records.map(row=>row.billing_month),['2034-12-01','2035-01-01','2035-02-01','2035-03-01','2035-04-01']);
    assert.equal(records[1].monthly_amount,'0');assert.equal(records[0].monthly_amount,String(Number.MAX_SAFE_INTEGER));
    assert.deepEqual(await Promise.all(sides.map(organizationRows)),orgs);
    const before=await Promise.all(sides.map(auditRows));await source.rollover(new Date('2035-03-31T15:00Z'));await billing.rollover(new Date('2035-03-31T15:00Z'));assert.deepEqual(await Promise.all(sides.map(auditRows)),before);
  });
  await t.test('ten-row transaction batches, same producer duplicate and multiple simultaneous producers',async()=>{
    for(let n=0;n<25;n++)await company({name:'월 배치 '+n});
    await Promise.all([source.rollover(new Date('2035-04-01Z')),source.rollover(new Date('2035-04-01Z'))]);
    await Promise.all([billing.rollover(new Date('2035-04-01Z')),billing.rollover(new Date('2035-04-01Z'))]);
    await equalState(start,Date.now());
    const transactions=(await pools.order.query("SELECT jsonb_array_length(payload->'preparedEventIds') AS n FROM outbox_events WHERE event_type='AuditCommitted' AND payload->'preparedEventIds' IS NOT NULL AND occurred_at >= $1",[new Date(start)])).rows;
    assert.ok(transactions.some(row=>row.n===20),'ten created months per business commit');assert.ok(transactions.every(row=>row.n<=20),'at most ten audit pairs');
  });
  await t.test('late batch audit SQL failure rolls back every month and both audit pairs',async()=>{
    const a=await company(),b=await company();
    for(const side of sides)await side.audit.query(`CREATE FUNCTION billing_failure_probe() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='BILLING_MONTH_INITIALIZED' AND NEW.target_seq=${b} AND NEW.metadata->>'paymentMethodType'='groupBilling' THEN RAISE EXCEPTION 'test-only billing rollback'; END IF;RETURN NEW;END $$;CREATE TRIGGER billing_failure_probe BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION billing_failure_probe()`);
    const before=await Promise.all(sides.map(rows)),logs=await Promise.all(sides.map(auditRows));
    try{await assert.rejects(source.rollover(new Date('2035-04-01Z')));await assert.rejects(billing.rollover(new Date('2035-04-01Z')));
      assert.deepEqual(await Promise.all(sides.map(rows)),before);assert.deepEqual(await Promise.all(sides.map(auditRows)),logs);
    }finally{for(const side of sides)await side.audit.query('DROP TRIGGER billing_failure_probe ON audit_logs;DROP FUNCTION billing_failure_probe()');}
    await source.rollover(new Date('2035-04-01Z'));await billing.rollover(new Date('2035-04-01Z'));await equalState(start,Date.now());
    assert.equal((await rows(sides[1])).filter(row=>[a,b].includes(row.organization_seq)).length,2);
  });
  await t.test('customer update and deletion wait while the real order callback commits its month',async()=>{
    const a=await company({name:'잠금 전'}),gate=await pools.order.connect();let pending,updated;
    try{
      await gate.query('BEGIN');await gate.query('LOCK TABLE organization_billing_months IN ACCESS EXCLUSIVE MODE');
      const event={eventId:randomUUID(),source:'order',eventType:'BillingRolloverRequested',payload:{months:[{organizationSeq:a,billingMonth:'2035-04-01'}]}};
      pending=requestBilling('http://customer-app:3001/internal/billing/rollover',values.CUSTOMER_AUTH_TOKEN,event);
      await until(async()=> (await pools.order.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'INSERT INTO organization_billing_months%'")).rowCount>0,'order initializer waits');
      updated=pools.customer.query("UPDATE organizations SET name='잠금 후',deleted_at=now() WHERE organization_seq=$1",[a]);
      await until(async()=> (await pools.customer.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'UPDATE organizations SET name=%'")).rowCount>0,'company writer waits');
      await gate.query('COMMIT');assert.equal(await pending,true);await updated;
      const row=(await pools.order.query('SELECT organization_name FROM organization_billing_months WHERE organization_seq=$1',[a])).rows[0];assert.equal(row.organization_name,'잠금 전');
      const response=await fetch('http://customer-app:3001/api/companies/'+a+'/billing?month=2035-04',{headers:{Cookie:'dva_session='+'a'.repeat(64)}});assert.equal(response.status,200);assert.equal((await response.json()).data.organizationName,'잠금 전');
      assert.equal(await requestBilling('http://customer-app:3001/internal/billing/rollover',values.CUSTOMER_AUTH_TOKEN,{...event,eventId:randomUUID()}),true);
      assert.equal((await pools.order.query('SELECT 1 FROM organization_billing_months WHERE organization_seq=$1',[a])).rowCount,1);
    }finally{await gate.query('ROLLBACK');gate.release();await Promise.allSettled([pending,updated]);}
  });
  await t.test('private billing commands require service credentials and reject forged payloads on both owners',async()=>{
    for(const [url,path,type,source,payload] of [
      ['http://customer-app:3001','companies','BillingOrganizationsReadRequested','order',{}],
      ['http://customer-app:3001','rollover','BillingRolloverRequested','order',{months:[{organizationSeq:id,billingMonth:'2035-04-01'}]}],
      ['http://order-app:3002','read','BillingReadRequested','customer',{id,month:'2035-04',organizationName:null}],
      ['http://order-app:3002','initialize','BillingRolloverRequested','customer',{months:[{organizationSeq:id,billingMonth:'2035-04-01'}],organizations:[]}],
    ]){
      const event={eventId:randomUUID(),source,eventType:type,payload};
      for(const token of ['',process.env.CONSULTATION_AUTH_TOKEN]){const response=await fetch(url+'/internal/billing/'+path,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(event)});assert.equal(response.status,403);}
      for(const bad of [{...event,source:'delivery'},{...event,payload:{...payload,actorId:1}}]){const response=await fetch(url+'/internal/billing/'+path,{method:'POST',headers:{Authorization:'Bearer '+values.CUSTOMER_AUTH_TOKEN,'Content-Type':'application/json'},body:JSON.stringify(bad)});assert.equal(response.status,422);}
    }
  });
  assert.deepEqual(await stable(),originalBusiness,'billing reads/rollover do not change orders, parcels, payment requests, charges or empty AI results');
  await t.test('personal billing reads preserve principal, Korean month boundaries, customer visibility and administrator access',async()=>{
    for(const side of sides) {
      for(const [id,status,deleted] of [[92001,'ACTIVE',false],[92002,'WITHDRAWN',false],[92003,'ACTIVE',true]])
        await side.org.query("INSERT INTO customers(customer_seq,name,phone_number,status,monthly_billing_enabled,deleted_at)"+
          " OVERRIDING SYSTEM VALUE VALUES($1,'개인 청구 검증 고객',$2,$3,false,$4)",
          [id,'010'+String(id).padStart(8,'0'),status,deleted?'2026-01-01T00:00:00Z':null]);
      const client=await side.ledger.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL session_replication_role='replica'");
        let n=0;
        for(const [customer,organization,amount,at] of [
          [92001,null,100,'2035-03-31T14:59:59Z'],[92001,null,200,'2035-03-31T15:00:00Z'],
          [92001,null,300,'2035-04-30T14:59:59Z'],[92001,null,400,'2035-04-30T15:00:00Z'],
          [92001,998877,1000,'2035-04-01T00:00:00Z'],[92002,null,50,'2035-04-01T00:00:00Z'],
          [92003,null,60,'2035-04-01T00:00:00Z'],
        ]) {
          const order=93000+(++n);
          await client.query("INSERT INTO orders(order_seq,customer_seq,payment_method_type,status,paid_at,total_amount,creation_source)"+
            " OVERRIDING SYSTEM VALUE VALUES($1,$2,'credit','PAID',$3,$4,'ADMIN')",[order,customer,at,amount]);
          await client.query("INSERT INTO order_billing_charges(order_seq,organization_seq,customer_seq,billing_month,payment_method_type,amount,occurred_at)"+
            " VALUES($1,$2,$3,date_trunc('month',$4::timestamptz AT TIME ZONE 'Asia/Seoul')::date,'credit',$5,$4)",
            [order,organization,organization===null?customer:null,at,amount]);
        }
        await client.query('COMMIT');
      } catch(error) {await client.query('ROLLBACK');throw error;}
      finally{client.release();}
    }
    const before=await stable(),ownerRows=async()=>Promise.all(sides.map(async side=>(await side.org.query(
      'SELECT to_jsonb(c) AS row FROM customers c WHERE customer_seq BETWEEN 92001 AND 92003 ORDER BY customer_seq',
    )).rows));
    const customersBefore=await ownerRows();
    let reads=0;
    async function read(id,query='',status=200,headers={Cookie:'dva_session='+'a'.repeat(64)}) {
      const requestId=randomUUID(),results=[];
      for(const side of sides) {
        const response=await fetch(side.url+'/api/customers/'+id+'/billing'+query,{headers:{...headers,'X-Request-Id':requestId}});
        const body=await response.json();
        assert.equal(response.status,status,JSON.stringify(body));
        assert.equal(response.headers.get('cache-control'),'no-store');
        assert.equal(response.headers.get('x-request-id'),requestId);
        results.push(body);
      }
      assert.deepEqual(results[1],results[0]);
      reads++;
      return results[0].data;
    }
    for(const [month,amount] of [['2035-03',100],['2035-04',500],['2035-05',400],['1000-01',0],['9999-12',0]]) {
      const value=await read(92001,'?month='+month);
      assert.deepEqual(value,{customerSeq:92001,month,monthlyAmount:amount});
    }
    for(const token of ['a','b','c'])
      assert.equal((await read(92002,'?month=2035-04',200,{Cookie:'dva_session='+token.repeat(64)})).monthlyAmount,50);
    await read(92001);
    await read(92003,'?month=2035-04',404);
    await read(2147483647,'?month=2035-04',404);
    await read(0,'?month=2035-04',400);
    for(const query of ['?month=2035-13','?month=0000-01','?month=0999-01','?month=2035-04&month=2035-05','?unknown=1'])
      await read(92001,query,400);
    await read(92001,'',401,{Authorization:'Bearer '+values.CUSTOMER_AUTH_TOKEN});
    await read(92001,'',401,{Cookie:'dva_session=invalid'});
    const docs=await Promise.all(sides.map(async side=>(await fetch(side.url+'/api/docs-json')).json()));
    const path='/api/customers/{id}/billing';
    assert.deepEqual(docs[1].paths[path],docs[0].paths[path]);
    for(const name of ['CustomerBillingMonthEnvelopeDto','CustomerBillingMonthDto','BillingMonthQueryDto'])
      assert.deepEqual(docs[1].components.schemas[name],docs[0].components.schemas[name],name);
    const packet={eventId:randomUUID(),source:'customer',eventType:'CustomerBillingReadRequested',payload:{id:92001,month:'2035-04'}};
    for(const token of ['',process.env.CONSULTATION_AUTH_TOKEN]) {
      const response=await fetch('http://order-app:3002/internal/billing/customer',{method:'POST',
        headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(packet)});
      assert.equal(response.status,403);
    }
    for(const wrong of [{...packet,source:'order'},{...packet,payload:{...packet.payload,actorId:1}}]) {
      const response=await fetch('http://order-app:3002/internal/billing/customer',{method:'POST',
        headers:{Authorization:'Bearer '+values.CUSTOMER_AUTH_TOKEN,'Content-Type':'application/json'},body:JSON.stringify(wrong)});
      assert.equal(response.status,422);
    }
    assert.deepEqual(await stable(),before);
    assert.deepEqual(await ownerRows(),customersBefore);
    t.diagnostic('personal billing HTTP pairs: '+reads+'; source principal and customer visibility retained');
  });
  console.log('Compared billing HTTP requests: '+compared);
});
