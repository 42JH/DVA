require('reflect-metadata');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { randomUUID } = require('node:crypto');
const { validateOrderRead, requestOrderRead, OrderReadError } = require('@dva/events/order-read.cjs');
const { validateEnvironment } = require('../dist/config/environment');
const { OrdersService } = require('../dist/orders/orders.service');
const token = 'order-read-test-only-'.padEnd(48, 't');

test('home order snapshots validate the owner query, bounded previews and counters', () => {
  const {validateHomeOrdersQuery,validateHomeOrdersResult,requestHomeOrders}=require('@dva/events/call-read-references.cjs');
  const event={eventId:randomUUID(),source:'consultation',eventType:'HomeOrdersReadRequested',
    payload:{observedAt:new Date().toISOString(),consultationAddress:null}};
  validateHomeOrdersQuery(event);
  for(const changed of [{...event,source:'order'},{...event,payload:{...event.payload,observedAt:'invalid'}},
    {...event,payload:{...event.payload,consultationAddress:'169.254.169.254'}},
    {...event,payload:{...event.payload,customerSeq:1}}])
    assert.throws(()=>validateHomeOrdersQuery(changed));
  const value={todayOrderCount:0,notPaid:2,submissionFailed:1,drafts:{data:[],total_count:0,hasNext:false}};
  validateHomeOrdersResult(value);
  for(const changed of [{...value,todayOrderCount:-1},{...value,notPaid:0.5},
    {...value,drafts:{...value.drafts,data:Array(12).fill({})}}])
    assert.throws(()=>validateHomeOrdersResult(changed));
  assert.throws(()=>requestHomeOrders('http://owner/internal',token,event.payload.observedAt,null,'invalid'));
});

test('metrics coalesce scrapes, preserve attention gauges and report database failures', async () => {
  const {ObservabilityService}=require('../dist/observability/observability.service');
  const queries=[],statistics={count:3,failures:1,seconds:0.4,maxSeconds:0.2,connectionWaitSeconds:0.01};
  let probes=0,transactions=0,release;
  const gate=new Promise(resolve=>release=resolve);
  const client={query:async sql=>{
    queries.push(sql);
    return {rows:sql.startsWith('SELECT status')?[{status:'notPaid',count:'2'}]:
      sql.startsWith('SELECT count')?[{count:'1'}]:[]};
  }};
  const database={
    pool:{totalCount:2,idleCount:1,waitingCount:0,query:async()=>{probes++;await gate;}},
    transactionStatistics:statistics,
    transaction:async work=>{transactions++;return work(client);},
  };
  const service=new ObservabilityService(database);
  const pending=service.snapshot();
  assert.equal(service.snapshot(),pending);release();
  const text=await pending;
  assert.equal(probes,1);assert.equal(transactions,1);
  assert.deepEqual(queries.slice(0,2),[
    'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',"SET LOCAL statement_timeout = '2s'",
  ]);
  assert.match(text,/^dva_database_up 1$/m);
  assert.match(text,/^dva_order_metrics_success 1$/m);
  assert.match(text,/^dva_orders_attention\{status="notPaid"\} 2$/m);
  assert.match(text,/^dva_orders_attention\{status="PAID"\} 0$/m);
  assert.match(text,/^dva_orders_stale_submitting 1$/m);
  assert.match(text,/^dva_database_transactions_total 3$/m);
  database.pool.query=async()=>{throw new Error('private connection details');};
  const down=await service.snapshot();
  assert.match(down,/^dva_database_up 0$/m);
  assert.match(down,/^dva_order_metrics_success 0$/m);
  assert.doesNotMatch(down,/dva_orders_attention|dva_orders_stale_submitting|private connection/);
  database.pool.query=async()=>{};
  database.transaction=async()=>{throw new Error('private SQL');};
  const unavailable=await service.snapshot();
  assert.match(unavailable,/^dva_database_up 1$/m);
  assert.match(unavailable,/^dva_order_metrics_success 0$/m);
  assert.doesNotMatch(unavailable,/dva_orders_attention|dva_orders_stale_submitting|private SQL/);
});

test('draft write scopes bind owners, calls, reply versions and authenticated reference queries', async () => {
  const {validateDraftWrite,validateWriteReference,validateCallMutation,requestWriteReference}=require('@dva/events/parcel-draft-write.cjs');
  const input={eventId:randomUUID(),source:'order',eventType:'ParcelDraftWriteRequested',payload:{
    command:{operation:'ParcelDraftCreated',id:null,adminId:null,callSessionSeq:1,
      input:{clientParcelId:randomUUID(),status:'EDITING',parcel:{}},requestId:'draft-write-test'},
    orderAddress:null,
  }};
  validateDraftWrite(input,'order');
  for(const mutate of [
    e=>e.source='customer',e=>e.payload.actorId=1,e=>e.payload.orderAddress='169.254.169.254',
    e=>e.payload.command.adminId=1,e=>e.payload.command.callSessionSeq=null,
    e=>e.payload.command.input=[],e=>e.payload.command.requestId='',
  ]) {
    const changed=structuredClone(input);mutate(changed);
    assert.throws(()=>validateDraftWrite(changed,'order'));
  }
  const scoped={...input,source:'consultation',payload:{...input.payload,consultationAddress:null,
    call:{callSessionSeq:1,customerSeq:null,intakeVersion:1}}};
  validateDraftWrite(scoped,'consultation');
  for(const call of [null,{callSessionSeq:2,customerSeq:null,intakeVersion:1},{callSessionSeq:1,customerSeq:null,intakeVersion:0}])
    assert.throws(()=>validateDraftWrite({...scoped,payload:{...scoped.payload,call}},'consultation'));
  validateDraftWrite({...scoped,source:'customer',payload:{...scoped.payload,customerAddress:null}},'customer');
  const mutation={callSessionSeq:1,beforeVersion:1,afterVersion:2,customerSeq:2};
  validateCallMutation(mutation);
  for(const changed of [{...mutation,afterVersion:3},{...mutation,customerSeq:0},{...mutation,actorId:1}])
    assert.throws(()=>validateCallMutation(changed));
  const reference={eventId:randomUUID(),source:'order',eventType:'ParcelDraftWriteReferenceRequested',
    payload:{operation:'CustomerRead',input:{id:1}}};
  validateWriteReference(reference);
  assert.throws(()=>validateWriteReference({...reference,source:'customer'}));
  assert.throws(()=>requestWriteReference('http://owner/private',token,reference));
  await assert.rejects(requestWriteReference('http://user:secret@owner/private',token,reference,input.eventId));
});

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
    DELIVERY_URL:'http://delivery:3003',CUSTOMER_URL:'http://customer:3001',CONSULTATION_URL:'http://consultation:3004',CUSTOMER_AUTH_TOKEN:token};
  assert.equal(validateEnvironment(valid).PORT,3002);
  for (const field of ['OPERATIONS_URL','CUSTOMER_URL','CONSULTATION_URL','DELIVERY_URL']) for (const value of ['', 'http://user:password@service:3000','file:///private','http://service/path'])
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

test('payment settings retain the original enable flag, test keys, URL and Origin validation', () => {
  const {validateEnvironment}=require('../dist/config/environment');
  const valid={NODE_ENV:'test',DB_HOST:'db',DB_USER:'test',DB_PASSWORD:'test',DB_NAME:'test',
    OPERATIONS_URL:'http://operations:3005',CUSTOMER_AUTH_TOKEN:'a'.repeat(40),
    CUSTOMER_URL:'http://customer:3001',CONSULTATION_URL:'http://consultation:3004',DELIVERY_URL:'http://delivery:3003',
    CORS_ORIGINS:'http://localhost:5173',ORDER_PAYMENTS_ENABLED:'true',PAYMENT_PUBLIC_URL:'http://localhost:5173/api/payments',
    TOSS_TEST_CLIENT_KEY:'test_gck_fixture',TOSS_TEST_SECRET_KEY:'test_gsk_fixture',
    PAYMENT_MATTERMOST_WEBHOOK_URL:'https://mattermost.example.test/hooks/parity'};
  assert.equal(validateEnvironment(valid).ORDER_PAYMENTS_ENABLED,true);
  assert.equal(validateEnvironment({...valid,ORDER_PAYMENTS_ENABLED:'false'}).ORDER_PAYMENTS_ENABLED,false);
  for(const [field,value] of [['ORDER_PAYMENTS_ENABLED','1'],['PAYMENT_PUBLIC_URL','http://localhost:5173/other'],
    ['PAYMENT_PUBLIC_URL','http://other:5173/api/payments'],['PAYMENT_TOSS_BASE_URL','https://other.test'],
    ['TOSS_TEST_CLIENT_KEY','live_gck_fixture'],['TOSS_TEST_SECRET_KEY','live_gsk_fixture']])
    assert.throws(()=>validateEnvironment({...valid,[field]:value}),error=>error.fields.includes(field));
});
