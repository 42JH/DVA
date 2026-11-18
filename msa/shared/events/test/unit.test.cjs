const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { validateEvent, createReceiver, createRelay, sendEvent } = require('../index.cjs');

const token = 'test-only-event-key-'.padEnd(40, 'a');
const event = () => ({ eventId: randomUUID(), source: 'order', eventType: 'OrderAccepted', payload: { orderSeq: 1 } });

test('call scope accepts only the bounded AI operations and hashes semantic command content', () => {
  const {validateScopeEvent,commandHash}=require('../call-scope.cjs');
  const command={operation:'PersonalPinCreated',id:1,callSessionSeq:2,input:{label:'private',addressData:{name:'recipient'}},requestId:randomUUID()};
  const input={eventId:randomUUID(),source:'customer',eventType:'CallScopedCustomerRequested',payload:{command}};
  validateScopeEvent(input,'customer');
  const callback={...input,source:'consultation',payload:{command,caller:{phone:'01000000001',customerSeq:1,endedAt:null}}};
  validateScopeEvent(callback,'consultation');
  validateScopeEvent({...callback,payload:{command,caller:null}},'consultation');
  for(const changed of [
    {...input,source:'operations'}, {...input,payload:{command,actorId:1}},
    {...input,payload:{command:{...command,operation:'CustomerDeleted'}}},
    {...input,payload:{command:{...command,callSessionSeq:2147483648}}},
    {...input,payload:{command:{...command,requestId:'not-uuid'}}},
  ])assert.throws(()=>validateScopeEvent(changed,'customer'));
  assert.throws(()=>validateScopeEvent({...callback,payload:{command,caller:{phone:'0',customerSeq:1,endedAt:'invalid'}}},'consultation'));
  assert.match(commandHash(command),/^[a-f0-9]{64}$/);
  assert.equal(commandHash(command),commandHash({...command,input:{addressData:{name:'recipient'},label:'private'}}));
  assert.notEqual(commandHash(command),commandHash({...command,input:{...command.input,label:'changed'}}));
});

test('call scope transport checks correlation, result, error and credentials without following redirects',async()=>{
  const {requestScope,ScopeResponseError}=require('../call-scope.cjs');
  const original=global.fetch;
  const input={eventId:randomUUID(),source:'customer',eventType:'CallScopedCustomerRequested',payload:{command:{operation:'PersonalPinUpdated',id:1,callSessionSeq:2,input:{label:'x'},requestId:randomUUID()}}};
  const result={eventId:input.eventId,status:'processed',payload:{version:3}};
  let body=result,status=200,type='application/json',calls=0;
  global.fetch=async(url,options)=>{calls++;assert.equal(options.redirect,'error');assert.ok(options.signal instanceof AbortSignal);assert.equal(options.headers['X-Request-Id'],input.payload.command.requestId);return new Response(JSON.stringify(body),{status,headers:{'content-type':type}});};
  try{
    assert.deepEqual(await requestScope('http://consultation/internal/call-scope',token,input),{version:3});
    for(const changed of [{...result,eventId:randomUUID()},{...result,status:'accepted'},{...result,payload:{version:0}},{...result,payload:{version:1,private:'leak'}}]){
      body=changed;await assert.rejects(requestScope('http://consultation/internal/call-scope',token,input));
    }
    body={error:{code:'NOT_FOUND',message:'통화를 찾을 수 없습니다.',details:[]}};status=404;
    await assert.rejects(requestScope('http://consultation/internal/call-scope',token,input),error=>error instanceof ScopeResponseError&&error.status===404&&error.error.code==='NOT_FOUND');
    body={error:{code:'UNRECOGNIZED',message:'raw error',details:[]}};
    await assert.rejects(requestScope('http://consultation/internal/call-scope',token,input));
    status=200;body=result;type='text/html';await assert.rejects(requestScope('http://consultation/internal/call-scope',token,input));
    const before=calls;
    for(const url of ['file:///private','http://user:password@consultation/internal/call-scope','http://consultation/internal/call-scope?token=x'])
      await assert.rejects(requestScope(url,token,input));
    await assert.rejects(requestScope('http://consultation/internal/call-scope','short',input));assert.equal(calls,before);
    type='application/json';body={...result,payload:{data:[{personalPinSeq:1,customerSeq:2,label:null,addressData:{},version:1}],hasNext:false,total_count:1}};
    await assert.rejects(requestScope('http://consultation/internal/call-scope',token,{...input,payload:{command:{...input.payload.command,operation:'PersonalPinsListed'}}}));
    body={...result,payload:{data:[{personalPinSeq:1,customerSeq:1,label:null,addressData:{name:'legacy',phoneNumber:'123',roadAddress:'r',jibunAddress:'j',dongName:'d',postalCode:'01234'},version:1}],hasNext:false,total_count:1}};
    assert.deepEqual(await requestScope('http://consultation/internal/call-scope',token,{...input,payload:{command:{...input.payload.command,operation:'PersonalPinsListed'}}}),body.payload);
    global.fetch=async()=>new Response(new Uint8Array(16*1024*1024+1),{headers:{'content-type':'application/json'}});
    await assert.rejects(requestScope('http://consultation/internal/call-scope',token,input),/too large/);
  }finally{global.fetch=original;}
});

test('direct requests validate destinations before sending service credentials', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('{}'); });
  for (const url of ['file:///tmp/events', 'http://user:pass@delivery/events',
    'http://delivery/events?token=secret', 'http://delivery/events#x'])
    await assert.rejects(sendEvent(url, token, event()), /Invalid event endpoint/);
  assert.equal(calls, 0);
});

test('direct event requests require the exact bounded JSON ACK and reject redirects', async t => {
  const {createServer}=require('node:http');
  let mode='ok';
  const input=event();
  const server=createServer(async(request,response)=>{
    assert.equal(request.headers.authorization,'Bearer '+token);
    const chunks=[];for await(const chunk of request)chunks.push(chunk);
    assert.deepEqual(JSON.parse(Buffer.concat(chunks)),input);
    if(mode==='redirect'){response.writeHead(307,{Location:'/other'}).end();return;}
    response.setHeader('Content-Type',mode==='html'?'text/html':'application/json');
    response.statusCode=mode==='error'?500:200;
    response.end(mode==='oversized'?'x'.repeat(5000):JSON.stringify({eventId:mode==='wrong'?randomUUID():input.eventId,status:mode==='duplicate'?'duplicate':'processed'}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const url=`http://127.0.0.1:${server.address().port}/internal/events`;
  await sendEvent(url,token,input);mode='duplicate';await sendEvent(url,token,input);
  for(mode of ['wrong','html','oversized','error','redirect'])await assert.rejects(sendEvent(url,token,input));
});

test('event envelopes accept only bounded identifiers and a JSON object payload', () => {
  assert.doesNotThrow(() => validateEvent(event()));
  for (const change of [{ eventId: 'no-uuid' }, { source: 'unknown' }, { eventType: '' },
    { payload: null }, { payload: [] }, { extra: true }])
    assert.throws(() => validateEvent({ ...event(), ...change }), { status: 400 });
});

test('receiver and relay reject empty or malformed authentication configuration', () => {
  const pool = { connect() { throw new Error('must not reach DB'); } };
  for (const value of ['', 'short', 'a'.repeat(32) + '\n']) {
    assert.throws(() => createReceiver({ pool, sources: { order: value }, handlers: {} }));
    assert.throws(() => createRelay({ pool, source: 'order', destinations: { delivery: { url: 'http://delivery:3003/internal/events', token: value } } }));
  }
  for (const url of ['file:///tmp/events', 'http://user:pass@delivery/events', 'http://delivery/events?token=secret', 'http://delivery/events#x'])
    assert.throws(() => createRelay({ pool, source: 'order', destinations: { delivery: { url, token } } }));
});

test('authentication and unsupported events fail before any DB access', async () => {
  const receiver = createReceiver({ pool: { connect() { throw new Error('must not reach DB'); } },
    sources: { order: token }, handlers: { 'order:OrderAccepted': async () => {} } });
  await assert.rejects(receiver(event(), 'Bearer wrong'), { status: 401 });
  await assert.rejects(receiver({ ...event(), source: 'customer' }, `Bearer ${token}`), { status: 401 });
  await assert.rejects(receiver({ ...event(), eventType: 'OtherEvent' }, `Bearer ${token}`), { status: 422 });
});
