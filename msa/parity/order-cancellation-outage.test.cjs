const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Pool}=require('pg');
test('delivery outage fails both cancellation actors closed while local reads and repeated parcel no-op remain available',async t=>{
  const db=new Pool({host:'order-db',user:'order_app'});t.after(()=>db.end());
  const before=(await db.query('SELECT to_jsonb(o) AS row FROM orders o ORDER BY order_seq')).rows;
  for(const headers of [{Cookie:'dva_session='+'a'.repeat(64),Origin:'http://localhost:5173'},{call_session_seq:'1011'}]){
    const response=await fetch('http://order-app:3002/api/orders/1001/cancel',{method:'POST',headers,signal:AbortSignal.timeout(40000)});
    assert.equal(response.status,503,await response.clone().text());assert.equal((await response.json()).error.code,'DEPENDENCY_UNAVAILABLE');
  }
  assert.deepEqual((await db.query('SELECT to_jsonb(o) AS row FROM orders o ORDER BY order_seq')).rows,before);
  for(const headers of [{Cookie:'dva_session='+'a'.repeat(64)},{call_session_seq:'1011'}])assert.equal((await fetch('http://order-app:3002/api/orders/1001',{headers})).status,200);
  const cancelled=(await db.query("SELECT order_seq,order_parcel_seq FROM order_parcels WHERE status='CANCELLED' ORDER BY order_parcel_seq LIMIT 1")).rows[0];assert.ok(cancelled);
  const response=await fetch('http://order-app:3002/api/orders/'+cancelled.order_seq+'/parcels/cancel',{method:'POST',headers:{Cookie:'dva_session='+'a'.repeat(64),Origin:'http://localhost:5173','Content-Type':'application/json'},body:JSON.stringify({orderParcelSeqs:[cancelled.order_parcel_seq]})});assert.equal(response.status,204);
});
