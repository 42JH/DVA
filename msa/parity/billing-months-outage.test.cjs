const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Pool}=require('pg');
test('order outage returns a redacted dependency error for billing and leaves local company reads available',async t=>{
  assert.equal(process.env.PGDATABASE,'dva_webhook_test');
  const order=new Pool({host:'order-db',user:'order_app'});
  t.after(()=>order.end());
  const snapshot=async()=>(await order.query('SELECT to_jsonb(b) AS row FROM organization_billing_months b ORDER BY organization_seq,billing_month')).rows;
  const before=await snapshot(),headers={Cookie:'dva_session='+'a'.repeat(64)};
  const response=await fetch('http://customer-app:3001/api/companies/70001/billing',{headers});
  assert.equal(response.status,503);assert.deepEqual((await response.json()).error,{code:'DEPENDENCY_UNAVAILABLE',message:'서비스를 일시적으로 사용할 수 없습니다.',details:[]});
  assert.equal((await fetch('http://customer-app:3001/api/companies/70001',{headers})).status,200);
  assert.deepEqual(await snapshot(),before);
});
