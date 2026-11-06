require('reflect-metadata');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { randomUUID } = require('node:crypto');
const { validateOrderRead, requestOrderRead, OrderReadError } = require('@dva/events/order-read.cjs');
const { validateEnvironment } = require('../dist/config/environment');
const { OrdersService } = require('../dist/orders/orders.service');
const token = 'order-read-test-only-'.padEnd(48, 't');
const event = () => ({ eventId: randomUUID(), source: 'order', eventType: 'OrderReadRequested',
  payload: { command: { operation: 'OrdersListed', id: null, callSessionSeq: 1, query: {} } } });
let server, url, mode;
before(async () => {
  server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer ' + token);
    const parts=[]; for await (const part of request) parts.push(part);
    const input=JSON.parse(Buffer.concat(parts));
    if (mode==='lost') { request.socket.destroy(); return; }
    if (mode==='redirect') { response.writeHead(307, { Location:'/private' }).end(); return; }
    response.setHeader('Content-Type', mode==='html' ? 'text/html' : 'application/json');
    if (mode==='failure') { response.writeHead(403).end(JSON.stringify({ error: { code:'FORBIDDEN', message:'고객 범위 오류', details:[] } })); return; }
    if (mode==='malformed-failure') { response.writeHead(403).end('{}'); return; }
    response.end(mode==='invalid-json' ? '{' : mode==='large' ? ' '.repeat(16*1024*1024+1) : JSON.stringify({
      eventId:mode==='wrong-id' ? randomUUID() : input.eventId, status:mode==='wrong-status' ? 'received' : 'processed',
      payload:mode==='bad-result' ? { data:[], hasNext:'false', total_count:0 } : { data:[], hasNext:false, total_count:0 },
    }));
  });
  await new Promise(resolve=>server.listen(0, '127.0.0.1', resolve));
  url='http://127.0.0.1:'+server.address().port+'/internal/order-read';
});
after(async()=> { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); });

test('validates source, operation, scope and payload before executing a query', () => {
  const valid=event(); validateOrderRead(valid,'order');
  for (const mutate of [e=>e.source='customer',e=>e.eventType='OrderCreated',e=>e.payload.sql='SELECT secret',
    e=>e.payload.command.id=1,e=>e.payload.command.callSessionSeq=0,e=>e.payload.command.operation='OrderDeleted',
    e=>e.payload.command.callSessionSeq=null,e=>e.eventId='bad']) {
    const value=structuredClone(valid);mutate(value);assert.throws(()=>validateOrderRead(value,'order'));
  }
  const scoped={...valid,source:'consultation',payload:{...valid.payload,caller:{phone:'01012345678',endedAt:null,orderSeq:null}}};
  validateOrderRead(scoped,'consultation');
  for (const caller of [null, {}, {...scoped.payload.caller,phone:'010-1234'}, {...scoped.payload.caller,endedAt:'yesterday'}])
    assert.throws(()=>validateOrderRead({...scoped,payload:{...scoped.payload,caller}},'consultation'));
  validateOrderRead({...valid,source:'customer',payload:{...valid.payload,customerSeq:1}},'customer');
  assert.throws(()=>validateOrderRead({...valid,source:'customer',payload:{...valid.payload,customerSeq:null}},'customer'));
});

test('accepts only matching schema-validated acknowledgements and preserves structured domain errors', async () => {
  mode='valid'; assert.deepEqual(await requestOrderRead(url,token,event()),{data:[],hasNext:false,total_count:0});
  for (mode of ['wrong-id','wrong-status','bad-result','html','invalid-json','large','redirect','lost','malformed-failure'])
    await assert.rejects(requestOrderRead(url,token,event()));
  mode='failure';await assert.rejects(requestOrderRead(url,token,event()),error=>error instanceof OrderReadError&&error.status===403&&error.error.message==='고객 범위 오류');
});

test('rejects unexpected origins, credentials and absent production security keys', () => {
  const valid={DB_HOST:'db',DB_USER:'order_app',DB_PASSWORD:'secret',DB_NAME:'order',OPERATIONS_URL:'http://operations:3005',
    CUSTOMER_URL:'http://customer:3001',CONSULTATION_URL:'http://consultation:3004',CUSTOMER_AUTH_TOKEN:token};
  assert.equal(validateEnvironment(valid).PORT,3002);
  for (const field of ['OPERATIONS_URL','CUSTOMER_URL','CONSULTATION_URL']) for (const value of ['', 'http://user:password@service:3000','file:///private','http://service/path'])
    assert.throws(()=>validateEnvironment({...valid,[field]:value}),error=>error.fields.includes(field)&&!error.message.includes('secret'));
  assert.throws(()=>validateEnvironment({...valid,NODE_ENV:'production'}),error=>error.fields.includes('SECURITY_LOG_HMAC_KEY'));
});

test('AI domain errors are not rewritten and local detail establishes its snapshot before the repository', async () => {
  const sql=[];
  const client={query:async text=>{sql.push(text);return{rows:[]};}};
  const database={transaction:work=>work(client)};
  const detail={orderSeq:1,version:4,parcels:[]};
  const repository={detail:async()=>{ assert.deepEqual(sql,['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY','SELECT 1']);return detail;}};
  const orders=new OrdersService(database,repository,{get:()=>undefined});
  assert.equal(await orders.detail(1,1),detail);
  for (const callId of [undefined,'','0','-1','1,2','2147483648'])
    await assert.rejects(orders.detail(null,1,callId),error=>error.getStatus()===400);
});
