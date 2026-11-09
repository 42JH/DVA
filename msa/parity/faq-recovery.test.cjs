const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { readFileSync, writeFileSync } = require('node:fs');
const delay=(n)=>new Promise((r)=>setTimeout(r,n));

test('real FAQ worker preserves order and UUID through failure, claim, SIGKILL and restart', async (t) => {
  assert.equal(process.env.NODE_ENV,'test');
  assert.equal(process.env.PGDATABASE,'dva_webhook_test');
  const sides=['monolith','operations'].map((name)=>({name,db:new Pool({host:name+'-db'})}));
  t.after(async()=>Promise.all(sides.map((s)=>s.db.end())));
  const headers={Authorization:'Bearer '+process.env.AI_FAQ_TOKEN,'Content-Type':'application/json'};
  async function control(side,body) { assert.equal((await fetch(`http://persona-fixture:8000/${side}/__control`,{method:'POST',headers,body:JSON.stringify(body)})).status,204); }
  const peer=async(side)=>(await (await fetch(`http://persona-fixture:8000/${side}/__state`,{headers})).json());
  const rows=async(side)=>(await side.db.query('SELECT * FROM faq_change_notifications ORDER BY faq_change_notification_seq')).rows;
  async function wait(work,description) { const limit=Date.now()+60_000; for(;;) { const result=await work(); if(result) return result; assert.ok(Date.now()<limit,description);await delay(50); } }
  if(process.env.FAQ_RECOVERY!=='after') {
    for(const side of sides) {
      await wait(async()=>{const r=await rows(side);return r[0].attempts>=1&&r[0].claim_id===null;},side.name+' first failed attempt');
      const records=(await peer(side.name)).faqNotifications, r=await rows(side);
      assert.ok(records.length>=1);
      assert.ok(records.every((event)=>event.eventId===r[0].event_id),'later event overtook failed first event');
      assert.equal(r[1].attempts,0);
      const audit=(await side.db.query("SELECT action,result,actor_type FROM audit_logs WHERE target_type='FAQ_CHANGE_NOTIFICATION' AND target_seq=$1 ORDER BY audit_log_seq",[r[0].faq_change_notification_seq])).rows;
      assert.deepEqual(audit.slice(0,2),[{action:'FAQ_NOTIFICATION_ATTEMPTED',result:'SUCCESS',actor_type:'SYSTEM'},{action:'FAQ_NOTIFICATION_FAILED',result:'FAILED',actor_type:'SYSTEM'}]);
      await control(side.name,{faqHold:true});
      await side.db.query("UPDATE faq_change_notifications SET next_attempt_at=clock_timestamp() WHERE sent_at IS NULL");
    }
    const before={};
    await wait(async()=>{
      for(const side of sides) { const r=await rows(side);if(!r[0].claim_id||r[0].sent_at) return false;before[side.name]={rows:r,peer:await peer(side.name)}; }
      return true;
    },'both workers own a live 30-second claim before process kill');
    writeFileSync('/app/service/test/faq-before-restart.json',JSON.stringify(before));
  } else {
    const before=JSON.parse(readFileSync('/app/service/test/faq-before-restart.json'));
    for(const side of sides) await control(side.name,{faqHold:false,faqStatus:202});
    await Promise.all(sides.map(async(side)=>{
      const r=await wait(async()=>{const current=await rows(side);return current.every((row)=>row.sent_at!==null)&&current;},side.name+' real worker recovery');
      assert.deepEqual(r.map((row)=>row.event_id),before[side.name].rows.map((row)=>row.event_id));
      assert.ok(r.every((row)=>row.claim_id===null&&row.claimed_until===null));
      const events=(await peer(side.name)).faqNotifications;
      const first=events.filter((e)=>e.eventId===r[0].event_id);
      assert.ok(first.length>before[side.name].peer.faqNotifications.length);
      for(const event of first) assert.deepEqual(event,{eventId:r[0].event_id,operation:'INSERT',faqEntrySeqs:[10003]});
      assert.equal(events.at(-1).eventId,r[1].event_id);
      assert.equal(events.filter((e)=>e.eventId===r[1].event_id).length,1);
      const audits=(await side.db.query("SELECT action,result,actor_type FROM audit_logs WHERE target_type='FAQ_CHANGE_NOTIFICATION' AND target_seq=ANY($1::int[]) ORDER BY audit_log_seq",[r.map((row)=>row.faq_change_notification_seq)])).rows;
      assert.equal(audits.filter((a)=>a.action==='FAQ_NOTIFICATION_SENT').length,2);
      assert.ok(audits.every((a)=>a.actor_type==='SYSTEM'));
      const response=await fetch(`http://${side.name}-faq-app:3005/api/ai/faqs`);
      assert.equal(response.status,200);
      assert.ok((await response.json()).data.length>0);
    }));
  }
});
