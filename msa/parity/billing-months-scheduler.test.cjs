const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Pool}=require('pg');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('real production app restart and ten-second timers initialize only current nondeleted companies',async t=>{
  assert.equal(process.env.PGDATABASE,'dva_webhook_test');
  const pools=Object.fromEntries(['monolith','customer','order','operations'].map(name=>[name,new Pool({host:name+'-db',user:name+'_app'})]));
  t.after(async()=>{await Promise.all(Object.values(pools).map(pool=>pool.end()));});
  const sides=[{org:pools.monolith,db:pools.monolith,audit:pools.monolith},{org:pools.customer,db:pools.order,audit:pools.operations}];
  const month=(await pools.order.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'Asia/Seoul','YYYY-MM') AS month")).rows[0].month;
  for(const side of sides)for(const [id,status,deleted] of [[70001,'ACTIVE',false],[70002,'INACTIVE',false],[70003,'ACTIVE',true]])
    await side.org.query(`INSERT INTO organizations(organization_seq,name,status,deleted_at) OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4)`,[id,'자동 청구 '+id,status,deleted?new Date():null]);
  for(let n=0;;n++){
    const counts=await Promise.all(sides.map(async side=>(await side.db.query("SELECT count(*)::integer AS n FROM organization_billing_months WHERE organization_seq IN (70001,70002) AND billing_month=to_date($1,'YYYY-MM')",[month])).rows[0].n));
    if(counts.every(n=>n===2))break;assert.ok(n<90,'production worker initialized '+JSON.stringify(counts));await pause(250);
  }
  const before=[];
  for(const side of sides){
    const rows=(await side.db.query("SELECT organization_seq,billing_month::text,organization_name,monthly_amount::text,group_billing_amount::text FROM organization_billing_months WHERE organization_seq BETWEEN 70001 AND 70003 ORDER BY organization_seq")).rows;
    assert.equal(rows.length,2);assert.ok(rows.every(row=>row.billing_month===month+'-01'&&row.monthly_amount==='0'&&row.group_billing_amount==='0'));
    const audit=(await side.audit.query("SELECT actor_type,actor_seq,actor_name,action,target_type,target_seq,result,metadata FROM audit_logs WHERE target_type='ORGANIZATION' AND target_seq BETWEEN 70001 AND 70003 ORDER BY audit_log_seq")).rows;
    assert.equal(audit.length,4);before.push({rows,audit});
  }
  assert.deepEqual(before[1],before[0]);
  await pause(10_500);
  for(const [i,side] of sides.entries())assert.deepEqual((await side.audit.query("SELECT actor_type,actor_seq,actor_name,action,target_type,target_seq,result,metadata FROM audit_logs WHERE target_type='ORGANIZATION' AND target_seq BETWEEN 70001 AND 70003 ORDER BY audit_log_seq")).rows,before[i].audit,'next timer does not duplicate audit');
});
