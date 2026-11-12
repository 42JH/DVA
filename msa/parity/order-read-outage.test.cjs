const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
test('a missing consultation service fails scoped reads closed while local admin order reads stay available',async t=> {
  const db=new Pool({host:'order-db',user:'order_app'});t.after(()=>db.end());
  const before=(await db.query('SELECT jsonb_agg(to_jsonb(o) ORDER BY order_seq) AS rows FROM orders o')).rows;
  const base='http://order-app:3002';
  const response=await fetch(base+'/api/orders/1001',{headers:{Authorization:'Bearer '+process.env.PGPASSWORD,call_session_seq:'1011'},signal:AbortSignal.timeout(20000)});
  assert.equal(response.status,503);assert.equal((await response.json()).error.code,'DEPENDENCY_UNAVAILABLE');
  for(const path of ['/api/orders','/api/orders/1001']) {
    const read=await fetch(base+path,{headers:{Cookie:'dva_session='+'a'.repeat(64)}});assert.equal(read.status,200,path);
  }
  const screen=await fetch(base+'/api/admin/orders',{headers:{Cookie:'dva_session='+'a'.repeat(64)},signal:AbortSignal.timeout(40000)});
  assert.equal(screen.status,503);assert.equal((await screen.json()).error.code,'DEPENDENCY_UNAVAILABLE');
  const failedDelete=await fetch(base+'/api/orders',{method:'DELETE',headers:{Cookie:'dva_session='+'a'.repeat(64),Origin:'http://localhost:5173','Content-Type':'application/json'},body:JSON.stringify({orderSeqs:[1001]}),signal:AbortSignal.timeout(20000)});
  assert.equal(failedDelete.status,503);assert.equal((await failedDelete.json()).error.code,'DEPENDENCY_UNAVAILABLE');
  const failedCancel=await fetch(base+'/api/orders/1001/cancel',{method:'POST',headers:{Authorization:'Bearer '+process.env.PGPASSWORD,call_session_seq:'1011'},signal:AbortSignal.timeout(40000)});
  assert.equal(failedCancel.status,503);assert.equal((await failedCancel.json()).error.code,'DEPENDENCY_UNAVAILABLE');
  assert.deepEqual((await db.query('SELECT jsonb_agg(to_jsonb(o) ORDER BY order_seq) AS rows FROM orders o')).rows,before);
});
