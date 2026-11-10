const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { validateEvent, createReceiver, createRelay, sendEvent } = require('../index.cjs');

const token = 'test-only-event-key-'.padEnd(40, 'a');
const event = () => ({ eventId: randomUUID(), source: 'order', eventType: 'OrderAccepted', payload: { orderSeq: 1 } });

test('call read references validate owner rows, query bounds and authenticated replies',async()=>{
  const {validateReferenceQuery,validateReferenceRows,requestReferences}=require('../call-read-references.cjs');
  const input={eventId:randomUUID(),source:'consultation',eventType:'CallReadReferencesRequested',payload:{ids:[1,2]}};
  validateReferenceQuery(input);
  const orderInput={...input,source:'order'};
  assert.throws(()=>validateReferenceQuery(orderInput));
  validateReferenceQuery(orderInput,'order');
  assert.throws(()=>validateReferenceQuery({...input,source:'customer'},'customer'));
  for(const changed of [{...input,source:'customer'},{...input,payload:{ids:[]}},{...input,payload:{ids:[1,1]}},
    {...input,payload:{ids:['1']}},{...input,payload:{ids:[2147483648]}},{...input,payload:{ids:[1],extra:true}},
    {...input,payload:{ids:Array.from({length:251},(_,n)=>n+1)}}])assert.throws(()=>validateReferenceQuery(changed));
  const order={order_seq:1,customer_seq:null,status:'notPaid',total_amount:0};validateReferenceRows('order',[order],[1]);
  const customer={customer_seq:1,name:'현재 고객',organization_seq:null,organization_name:null};validateReferenceRows('customer',[customer],[1]);
  const persona={ai_persona_version_seq:1,name:'불변 버전',version:2};validateReferenceRows('persona',[persona],[1]);
  validateReferenceRows('faq',[{faq_entry_seq:1}],[1]);
  for(const rows of [[{faq_entry_seq:2}],[{faq_entry_seq:1,question:'비공개 원문'}],[{faq_entry_seq:1},{faq_entry_seq:1}]])assert.throws(()=>validateReferenceRows('faq',rows,[1]));
  for(const [kind,rows]of [['order',[{...order,status:'NOT_PAID'}]],['order',[{...order,total_amount:-1}]],
    ['order',[order,order]],['order',[{...order,order_seq:2}]],['customer',[{...customer,organization_seq:2}]],
    ['persona',[{...persona,version:0}]],['persona',[{...persona,extra:true}]]])assert.throws(()=>validateReferenceRows(kind,rows,[1]));
  const original=global.fetch;let calls=0,mode='valid',expectedSource='consultation';
  global.fetch=async(url,options)=>{
    calls++;assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer '+token);
    const event=JSON.parse(options.body);assert.deepEqual(event.payload.ids,[1,2]);assert.equal(event.source,expectedSource);
    return new Response(JSON.stringify({eventId:mode==='wrongId'?randomUUID():event.eventId,status:'processed',
      payload:mode==='wrongRow'?[{...customer,customer_seq:3}]:[{...customer,name:'고'.repeat(1024*1024)}]}),{headers:{'content-type':'application/json'}});
  };
  try{
    const result=await requestReferences('customer','http://customer/internal/call-read-references',token,[2,1,1]);assert.equal(result[0].name.length,1024*1024);
    for(const bad of ['https://user:secret@host/private','https://host/private?x=1','file:///private'])await assert.rejects(requestReferences('customer',bad,token,[1,2]));
    await assert.rejects(requestReferences('customer','http://customer/private','bad',[1,2]));assert.equal(calls,1);
    const {requestPacket}=require('../call-event-reference.cjs');
    await assert.rejects(requestPacket('http://customer/private',token,input,AbortSignal.timeout(1000)));
    await assert.rejects(requestPacket('http://customer/private',token,input,AbortSignal.timeout(1000),2*1024*1024));assert.equal(calls,2);
    for(mode of ['wrongId','wrongRow'])await assert.rejects(requestReferences('customer','http://customer/private',token,[1,2]));
    expectedSource='order';mode='valid';
    const orderReply=await requestReferences('customer','http://customer/internal/call-read-references/for-orders',token,[2,1,1],'order');
    assert.equal(orderReply[0].name.length,1024*1024);
    for(const kind of ['order','persona','faq'])await assert.rejects(requestReferences(kind,'http://customer/private',token,[1,2],'order'));
  }finally{global.fetch=original;}
});

test('dashboard comparison admits exactly the current and recorded previous persona',async()=>{
  const {validatePersonaComparisonQuery,validatePersonaComparisonRows,requestPersonaComparison}=require('../call-read-references.cjs');
  const query={eventId:randomUUID(),source:'consultation',eventType:'DashboardPersonaComparisonRequested',payload:{}};
  validatePersonaComparisonQuery(query);
  for(const changed of [{...query,source:'order'},{...query,eventType:'Other'},{...query,payload:{ids:[1]}}])assert.throws(()=>validatePersonaComparisonQuery(changed));
  const current={ai_persona_seq:1,ai_persona_version_seq:2,name:'현재',version:2,status:'ACTIVE',previous_active_version_seq:1},previous={...current,ai_persona_version_seq:1,name:'직전',version:1,status:'INACTIVE',previous_active_version_seq:null};
  validatePersonaComparisonRows([]);validatePersonaComparisonRows([current,previous]);validatePersonaComparisonRows([{...current,previous_active_version_seq:null}]);
  for(const rows of [[current],[previous],[current,current],[current,previous,{...previous,ai_persona_version_seq:3}],
    [{...current,extra:1},previous],[{...current,name:42},previous],[{...current,previous_active_version_seq:2}],
    [current,{...previous,ai_persona_version_seq:3}]])assert.throws(()=>validatePersonaComparisonRows(rows));
  const original=global.fetch;let requests=0;
  global.fetch=async(url,options)=>{requests++;const event=JSON.parse(options.body);validatePersonaComparisonQuery(event);assert.equal(options.redirect,'error');
    assert.equal(options.headers.Authorization,'Bearer '+token);return new Response(JSON.stringify({eventId:event.eventId,status:'processed',payload:[current,previous]}),{headers:{'content-type':'application/json'}});};
  try{assert.deepEqual(await requestPersonaComparison('http://operations/private',token),[current,previous]);
    for(const url of ['https://user:secret@host/private','https://host/private?x=1','file:///private'])await assert.rejects(requestPersonaComparison(url,token));
    await assert.rejects(requestPersonaComparison('http://operations/private','bad'));assert.equal(requests,1);
  }finally{global.fetch=original;}
});

test('complaint FAQ snapshot preserves all original text and accepts only a closed internal query',async()=>{
  const {validateComplaintFaqQuery,validateComplaintFaqRows,requestComplaintFaqs}=require('../call-read-references.cjs');
  const query={eventId:randomUUID(),source:'consultation',eventType:'ComplaintFaqSnapshotRequested',payload:{}};
  validateComplaintFaqQuery(query);validateComplaintFaqRows([]);
  const rows=[{question:'기존 원문',answer:'답'.repeat(1024*1024)}];validateComplaintFaqRows(rows);
  for(const value of [{...query,source:'customer'},{...query,payload:{limit:10}}])assert.throws(()=>validateComplaintFaqQuery(value));
  for(const value of [[{question:3,answer:'답'}],[{question:'질문',answer:'답',id:1}],[{question:'질문',answer:'x\u0000'}]])assert.throws(()=>validateComplaintFaqRows(value));
  const original=global.fetch;
  global.fetch=async(url,options)=>{const event=JSON.parse(options.body);validateComplaintFaqQuery(event);assert.equal(options.headers.Authorization,'Bearer '+token);
    return new Response(JSON.stringify({eventId:event.eventId,status:'processed',payload:rows}),{headers:{'content-type':'application/json'}});};
  try{assert.deepEqual(await requestComplaintFaqs('http://operations/private',token),rows);}finally{global.fetch=original;}
});

test('FAQ conversion validates the source fields and retries only a released pending write',async()=>{
  const {validateFaqConversionEvent,FaqWritePending,FaqConversionConflict,retryFaqWrite,requestFaqConversion,FAQ_CATEGORIES}=require('../faq-conversion.cjs');
  const event={eventId:randomUUID(),source:'consultation',eventType:'FaqConversionPrepared',payload:{transactionId:randomUUID(),requestId:randomUUID(),adminId:1,faq:{category:FAQ_CATEGORIES[0],question:'원문 질문',answer:' 답변\n '}}};
  validateFaqConversionEvent(event);
  validateFaqConversionEvent({...event,payload:{...event.payload,faq:{...event.payload.faq,question:'😀'.repeat(1000),answer:'😀'.repeat(20000)}}});
  for(const value of [{...event,source:'order'},{...event,payload:{...event.payload,extra:true}},
    {...event,payload:{...event.payload,adminId:'1'}},{...event,payload:{...event.payload,transactionId:'bad'}},
    ...[{question:' '},{question:'x\u0000'},{question:'😀'.repeat(1001)},{answer:'😀'.repeat(20001)},{category:'전체'},{extra:1}].map(faq=>({...event,payload:{...event.payload,faq:{...event.payload.faq,...faq}}}))])assert.throws(()=>validateFaqConversionEvent(value));
  let calls=0,leased=false;
  assert.equal(await retryFaqWrite(async()=>{assert.equal(leased,false);leased=true;calls++;try{if(calls===1)throw new FaqWritePending();return 7;}finally{leased=false;}}),7);
  assert.equal(calls,2);const failure=new Error('source write failed');await assert.rejects(retryFaqWrite(async()=>{throw failure;}),error=>error===failure);
  const original=global.fetch;let mode='valid',requests=0,transported;
  global.fetch=async(url,options)=>{requests++;assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer '+token);const sent=JSON.parse(options.body);validateFaqConversionEvent(sent);transported=sent.payload.faq;
    let body={eventId:event.eventId,status:'processed',payload:{faqEntrySeq:3}},status=200;
    if(mode==='busy'){status=409;body={error:'FAQ_WRITE_PENDING'};}else if(mode==='duplicate'){status=409;body={error:{code:'DUPLICATE_RESOURCE',message:'현재 상태에서는 처리할 수 없습니다.',details:[]}};}
    else if(mode==='wrongId')body.eventId=randomUUID();else if(mode==='wrongRow')body.payload.faqEntrySeq='3';else if(mode==='large')body.padding='x'.repeat(5000);
    return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
  };
  const send=(url='http://operations/internal/events/faq-conversion',secret=token)=>requestFaqConversion(url,secret,{eventId:event.eventId,input:event.payload});
  try{assert.equal(await send(),3);
    for(const url of ['http://user:secret@operations/private','file:///private','http://operations/private?x=1'])await assert.rejects(send(url));
    await assert.rejects(send(undefined,'bad'));assert.equal(requests,1);
    mode='busy';await assert.rejects(send(),FaqWritePending);mode='duplicate';await assert.rejects(send(),FaqConversionConflict);
    for(mode of ['wrongId','wrongRow','large'])await assert.rejects(send());
    mode='valid';const raw={...event.payload,faq:{...event.payload.faq,question:'원본 \ud800 질문',answer:'원본 \udc00 답변'}};
    await requestFaqConversion('http://operations/private',token,{eventId:event.eventId,input:raw});
    assert.equal(transported.question,'원본 \ufffd 질문');assert.equal(transported.answer,'원본 \ufffd 답변');assert.equal(raw.faq.question,'원본 \ud800 질문');
  }finally{global.fetch=original;}
});

test('FAQ examples preserve bounded original question text and closed references',()=>{
  const {validateFaqExamples,validateFaqChunks,splitFaqExamples,assembleFaqExamples}=require('../faq-question-examples.cjs');
  const input={transactionId:randomUUID(),questions:[{utteranceOrder:1,text:' 질문\n원문 '}],results:[{eventId:randomUUID(),occurredAt:'2026-11-01T01:00:00.000Z',questionUtteranceOrder:1,faqEntrySeqs:[1,2]}]};
  validateFaqExamples(input);validateFaqExamples({...input,questions:[{utteranceOrder:1,text:'😀'.repeat(20000)}]});
  validateFaqExamples({...input,questions:[{utteranceOrder:1,text:'\n'}]});
  for(const value of [{...input,extra:1},{...input,transactionId:'bad'},{...input,questions:[]},{...input,questions:[...input.questions,...input.questions]},
    {...input,questions:[{utteranceOrder:1,text:' '}]},{...input,questions:[{utteranceOrder:1,text:'x\u0000'}]},{...input,questions:[{utteranceOrder:1,text:'😀'.repeat(20001)}]},
    ...[{occurredAt:'bad'},{questionUtteranceOrder:2},{faqEntrySeqs:[]},{faqEntrySeqs:[1,1]},{faqEntrySeqs:['1']},{faqEntrySeqs:[2147483648]}].map(change=>({...input,results:[{...input.results[0],...change}]})),
    {...input,results:[input.results[0],{...input.results[0],eventId:input.results[0].eventId.toUpperCase()}]}])assert.throws(()=>validateFaqExamples(value));
  const large={transactionId:input.transactionId,questions:Array.from({length:50},(_,n)=>({utteranceOrder:n+1,text:'\u0001'.repeat(19999)+'끝'})),
    results:Array.from({length:50},(_,n)=>({...input.results[0],eventId:randomUUID(),questionUtteranceOrder:n+1}))};
  const chunks=splitFaqExamples(large);assert.ok(chunks.length>1);
  for(const chunk of chunks){validateFaqExamples(chunk);assert.ok(Buffer.byteLength(JSON.stringify(chunk))<=512*1024);}
  assert.deepEqual(assembleFaqExamples(chunks,input.transactionId),large);
  assert.deepEqual(splitFaqExamples(input),[input]);
  const request={transactionId:input.transactionId,chunkEventIds:chunks.map(()=>randomUUID())};validateFaqChunks(request);
  for(const bad of [{...request,extra:1},{...request,chunkEventIds:[]},{...request,chunkEventIds:['bad']},
    {...request,chunkEventIds:[request.chunkEventIds[0],request.chunkEventIds[0].toUpperCase()]}])assert.throws(()=>validateFaqChunks(bad));
  assert.throws(()=>assembleFaqExamples(chunks,randomUUID()));
  assert.throws(()=>assembleFaqExamples([input,{...input,results:[{...input.results[0],eventId:randomUUID()}],questions:[{utteranceOrder:1,text:'different'}]}],input.transactionId));
  assert.throws(()=>assembleFaqExamples([...chunks,...chunks],input.transactionId));
});

test('call event reference scope accepts only bounded lookups, private callbacks and matching results', () => {
  const {privateAddress,validateScopeRequest,validateScopeResult,validateDirective}=require('../call-event-reference.cjs');
  const lookup={orderSeq:1,callOrderSeq:null,customerSeq:2};
  const request={eventId:randomUUID(),source:'consultation',eventType:'CallEventOrderScopeRequested',payload:{lookup,callbackAddress:null}};
  validateScopeRequest(request);
  for(const address of ['10.0.0.2','172.16.0.1','172.31.255.1','192.168.1.2']){assert.equal(privateAddress(address),true);validateScopeRequest({...request,payload:{lookup,callbackAddress:address}});}
  for(const address of ['127.0.0.1','169.254.169.254','172.15.0.1','172.32.0.1','8.8.8.8','localhost','10.1.2.3:3004',7])assert.equal(privateAddress(address),false);
  for(const changed of [{...request,source:'customer'},{...request,payload:{lookup,callbackAddress:'127.0.0.1'}},{...request,payload:{lookup:{...lookup,orderSeq:0},callbackAddress:null}},{...request,payload:{lookup:{...lookup,extra:1},callbackAddress:null}}])assert.throws(()=>validateScopeRequest(changed));
  const result={eventId:randomUUID(),source:'order',eventType:'CallEventOrderChecked',payload:{scopeId:request.eventId,step:0,lookup,exists:true,allowed:null}};
  validateScopeResult(result);validateScopeResult({...result,payload:{...result.payload,exists:false}});
  for(const changes of [{step:-1},{step:50},{exists:false,allowed:true},{scopeId:'bad'},{allowed:'true'},{lookup:{...lookup,customerSeq:2147483648}}])assert.throws(()=>validateScopeResult({...result,payload:{...result.payload,...changes}}));
  validateDirective({next:null});validateDirective({next:lookup});
  for(const value of [{},{next:{...lookup,orderSeq:'1'}},{next:null,extra:true}])assert.throws(()=>validateDirective(value));
});

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
  let mode='ok',reference=false,redirects=0;
  const input=event();
  const server=createServer(async(request,response)=>{
    assert.equal(request.headers.authorization,'Bearer '+token);
    const chunks=[];for await(const chunk of request)chunks.push(chunk);
    assert.deepEqual(JSON.parse(Buffer.concat(chunks)),input);
    if(mode==='redirect'){redirects++;response.writeHead(307,{Location:'/other'}).end();return;}
    response.setHeader('Content-Type',mode==='html'?'text/html':'application/json');
    response.statusCode=mode==='error'?500:200;
    response.end(mode==='oversized'&&!reference?'x'.repeat(5000):JSON.stringify({eventId:mode==='wrong'?randomUUID():input.eventId,status:mode==='duplicate'?'duplicate':'processed',...(reference?{payload:mode==='oversized'?'x'.repeat(17000):null}:{})}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const url=`http://127.0.0.1:${server.address().port}/internal/events`;
  await sendEvent(url,token,input);mode='duplicate';await sendEvent(url,token,input);
  for(mode of ['wrong','html','oversized','error','redirect'])await assert.rejects(sendEvent(url,token,input));
  const {requestPacket}=require('../call-event-reference.cjs');
  reference=true;mode='ok';assert.equal(await requestPacket(url,token,input,AbortSignal.timeout(1000)),null);
  for(mode of ['wrong','html','oversized','error','duplicate','redirect']){const before=redirects;await assert.rejects(requestPacket(url,token,input,AbortSignal.timeout(1000)));if(mode==='redirect')assert.equal(redirects,before+1);}
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


test('read scopes reuse all held clients, drain callbacks and reject expired or duplicate roots',async()=>{
  const {ReadScopes,validateReadScope,readCallbackUrl}=require('../read-scope.cjs');
  const reads=new ReadScopes(()=>new Error('unavailable')),id=randomUUID(),client={held:true};
  assert.throws(()=>validateReadScope('invalid'));
  assert.equal(readCallbackUrl('http://customer:3001','/internal/query','10.2.3.4'),'http://10.2.3.4:3001/internal/query');
  for(const address of ['127.0.0.1','8.8.8.8','169.254.169.254','hostname'])assert.throws(()=>readCallbackUrl('http://customer:3001','/internal/query',address));
  await assert.rejects(reads.use(id,()=>assert.fail()),/unavailable/);
  let release,entered;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);let callback,completed=false;
  const root=reads.run(id,client,async()=>{callback=reads.use(id,async held=>{assert.equal(held,client);entered();await gate;return 7;});await started;return 3;}).then(value=>{completed=true;return value;});
  await started;await new Promise(r=>setImmediate(r));assert.equal(completed,false);
  await assert.rejects(reads.run(id,client,async()=>0),/unavailable/);
  await assert.rejects(reads.use(id,()=>assert.fail()),/unavailable/);
  release();assert.equal(await callback,7);assert.equal(await root,3);
  await assert.rejects(reads.use(id,()=>assert.fail()),/unavailable/);
  await assert.rejects(reads.run(id,client,async()=>{throw Error('root failed');}),/root failed/);
  assert.equal(await reads.run(id,client,async()=>reads.use(id,async held=>held)),client);
  await Promise.all(Array.from({length:5},(_,i)=>{const key=randomUUID(),connection={i};return reads.run(key,connection,()=>reads.use(key,async held=>assert.equal(held,connection)));}));
});

test('administrator order read protocol preserves owner addresses, scopes and complete metadata',async()=>{
  const {validateAdminOrderRead,requestAdminOrderRead,OrderReadError}=require('../order-read.cjs');
  const {requestReferences,requestOrderOrganization,validateOrderOrganizationRows}=require('../call-read-references.cjs');
  const {requestDraftCallReferences}=require('../parcel-drafts.cjs');
  const input={eventId:randomUUID(),source:'order',eventType:'AdminOrdersReadRequested',payload:{query:{limit:20,offset:0,q:'_%'},orderAddress:null}};
  validateAdminOrderRead(input,'order');
  for(const changed of [{...input,source:'customer'},{...input,payload:{...input.payload,orderAddress:'169.254.169.254'}},{...input,payload:{...input.payload,query:{limit:101,offset:0}}},{...input,payload:{...input.payload,query:{limit:20,offset:0,extra:true}}}])assert.throws(()=>validateAdminOrderRead(changed,'order'));
  const oldFetch=global.fetch;let mode='ok',seen=0;
  const counts={all:0,incomplete:0,notPaid:0,paid:0,submissionFailed:0,cancelled:0};
  global.fetch=async(url,options)=>{
    const packet=JSON.parse(options.body);seen++;
    if(packet.eventType==='AdminOrdersReadRequested'){
      if(mode==='error')return new Response(JSON.stringify({error:{code:'INVALID_REQUEST',message:'original',details:[]}}),{status:400,headers:{'content-type':'application/json'}});
      const page={data:[],hasNext:false,total_count:0,statusCounts:counts};
      if(mode==='bad')page.statusCounts={all:0};
      return Response.json({eventId:mode==='wrong'?randomUUID():packet.eventId,status:'processed',payload:page});
    }
    assert.equal(options.headers['X-Msa-Read-Scope'],input.eventId);
    const payload=packet.eventType==='CallReadReferencesRequested'?[{customer_seq:1,name:'이름'.repeat(10000),organization_seq:2,organization_name:'기업'}]:
      packet.eventType==='OrderOrganizationReadRequested'?{organization_seq:2,organization_name:'기업',customer_seqs:[1,2]}:{calls:[],customers:[],phones:[]};
    return Response.json({eventId:packet.eventId,status:'processed',payload});
  };
  try {
    assert.deepEqual((await requestAdminOrderRead('http://consultation/private',token,input)).statusCounts,counts);
    for(mode of ['bad','wrong'])await assert.rejects(requestAdminOrderRead('http://consultation/private',token,input));
    mode='error';await assert.rejects(requestAdminOrderRead('http://consultation/private',token,input),err=>err instanceof OrderReadError&&err.status===400&&err.error.message==='original');
    assert.equal((await requestReferences('customer','http://customer/private',token,[1],'order',input.eventId))[0].name.length,20000);
    assert.deepEqual((await requestOrderOrganization('http://customer/private',token,2,input.eventId)).customer_seqs,[1,2]);
    await requestDraftCallReferences('http://consultation/private',token,{callIds:[1],customerIds:[],phones:[]},input.eventId);
    const previous=seen;
    await assert.rejects(requestReferences('customer','http://customer/private',token,[1],'order','invalid'));
    await assert.rejects(requestReferences('customer','http://customer/private',token,[1],'consultation',input.eventId));
    await assert.rejects(requestAdminOrderRead('http://user:pass@consultation/private',token,input));assert.equal(seen,previous);
    assert.throws(()=>validateOrderOrganizationRows({organization_seq:2,organization_name:null,customer_seqs:[1]},2));
    assert.throws(()=>validateOrderOrganizationRows({organization_seq:2,organization_name:'기업',customer_seqs:[1,1]},2));
  } finally {global.fetch=oldFetch;}
});
