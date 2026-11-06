const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
test('a missing consultation service fails AI reads closed while local admin reads stay available',async t=> {
  const db=new Pool({host:'order-db',user:'order_app'});t.after(()=>db.end());
  const before=(await db.query('SELECT jsonb_agg(to_jsonb(o) ORDER BY order_seq) AS rows FROM orders o')).rows;
  const base='http://order-app:3002';
  const response=await fetch(base+'/api/orders/1001',{headers:{call_session_seq:'1011'},signal:AbortSignal.timeout(20000)});
  assert.equal(response.status,503);assert.equal((await response.json()).error.code,'DEPENDENCY_UNAVAILABLE');
  for(const path of ['/api/orders','/api/orders/1001','/api/admin/orders']) {
    const read=await fetch(base+path,{headers:{Cookie:'dva_session='+'a'.repeat(64)}});assert.equal(read.status,200,path);
  }
  const failedDelete=await fetch(base+'/api/orders/1001',{method:'DELETE',headers:{Cookie:'dva_session='+'a'.repeat(64),Origin:'http://localhost:5173'},signal:AbortSignal.timeout(20000)});
  assert.equal(failedDelete.status,503);assert.equal((await failedDelete.json()).error.code,'DEPENDENCY_UNAVAILABLE');
  assert.deepEqual((await db.query('SELECT jsonb_agg(to_jsonb(o) ORDER BY order_seq) AS rows FROM orders o')).rows,before);
});
