const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createServer } = require('node:http');
const { validateParcelDraftCommand, requestParcelDraftCommand } = require('../parcel-drafts.cjs');
const token = 'parcel-draft-test-only-'.padEnd(40, 'x');
const read = () => ({ eventId: randomUUID(), source: 'order', eventType: 'LegacyDraftCallBindingsReadRequested', payload: { orderSeqs: [1, 2] } });
const check = () => ({ eventId: randomUUID(), source: 'consultation', eventType: 'CallDraftDeletionCheckRequested', payload: { callSessionSeq: 3 } });
let server, url, mode;
before(async () => {
  server = createServer(async (req, res) => {
    const parts = []; for await (const part of req) parts.push(part);
    const input = JSON.parse(Buffer.concat(parts));
    assert.equal(req.headers.authorization, 'Bearer ' + token);
    if (mode === 'lost') { req.socket.destroy(); return; }
    if (mode === 'redirect') { res.writeHead(307, { Location: '/wrong' }).end(); return; }
    res.setHeader('Content-Type', mode === 'html' ? 'text/html' : 'application/json');
    if (mode === 'status') res.statusCode = 503;
    const rows = [{ orderSeq: 1, callSessionSeq: 10, callerPhoneNumber: null }, { orderSeq: 2, callSessionSeq: null, callerPhoneNumber: null }];
    let payload = input.eventType === 'LegacyDraftCallBindingsReadRequested' ? rows : false;
    if(input.eventType==='DraftCallReferencesRequested') {
      assert.ok(Buffer.byteLength(JSON.stringify(input))<100*1024);
      payload={calls:[{call_session_seq:1,started_at:'2030-01-01T00:00:00.123456+00:00'}],
        customers:[{customer_seq:2,call_session_seq:9,started_at:'2030-01-01T00:00:00.123457+00:00'}],
        phones:[{caller_phone_number:'장'.repeat(400000),call_session_seq:10,started_at:'infinity'}]};
      if(mode==='draft-foreign')payload.customers[0].customer_seq=99;
      if(mode==='draft-duplicate')payload.calls.push(payload.calls[0]);
      if(mode==='draft-time')payload.calls[0].started_at='invalid';
      if(mode==='draft-phone')payload.phones[0].caller_phone_number='unrequested';
    }
    if (mode === 'duplicate') payload[1] = payload[0];
    if (mode === 'missing') payload.pop();
    if (mode === 'foreign') payload[0].orderSeq = 99;
    if (mode === 'forged') payload[0].customerSeq = 99;
    if (mode === 'orphan-phone') payload[1].callerPhoneNumber = 'must-not-be-selected';
    if (mode === 'long-phone') payload[0].callerPhoneNumber = 'x'.repeat(20000);
    if (mode === 'boolean') payload = 'false';
    res.end(mode === 'json' ? '{' : mode === 'utf8' ? Buffer.from([255]) : mode === 'oversized' ? ' '.repeat(4097) :
      JSON.stringify({ eventId: mode === 'id' ? randomUUID() : input.eventId, status: mode === 'ack' ? 'received' : 'processed', payload }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); url = 'http://127.0.0.1:' + server.address().port;
});
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });

test('parcel draft commands accept only their exact owner, fields, positive IDs and unique bounded batches', () => {
  validateParcelDraftCommand(read(), 'LegacyDraftCallBindingsReadRequested', 'order');
  validateParcelDraftCommand(check(), 'CallDraftDeletionCheckRequested', 'consultation');
  for (const mutate of [e => e.source = 'customer', e => e.payload.orderSeqs = [], e => e.payload.orderSeqs = [1, 1],
    e => e.payload.orderSeqs = [0], e => e.payload.orderSeqs = ['1'], e => e.payload.orderSeqs = Array.from({ length: 101 }, (_, i) => i + 1),
    e => e.payload.actorId = 1, e => e.eventType = 'OrderAccepted']) {
    const bad = read(); mutate(bad); assert.throws(() => validateParcelDraftCommand(bad, 'LegacyDraftCallBindingsReadRequested', 'order'));
  }
  assert.throws(() => validateParcelDraftCommand({ ...check(), payload: { callSessionSeq: 2147483648 } }, 'CallDraftDeletionCheckRequested', 'consultation'));
  assert.throws(() => validateParcelDraftCommand({ ...read(), payload: {} }, 'CallDraftDeletionCheckRequested', 'order'));
});
test('binding ACKs preserve null and historical text, and reject mismatched, incomplete or forged snapshots', async () => {
  mode = 'valid'; assert.deepEqual(await requestParcelDraftCommand(url, token, read()),
    [{ orderSeq: 1, callSessionSeq: 10, callerPhoneNumber: null }, { orderSeq: 2, callSessionSeq: null, callerPhoneNumber: null }]);
  mode = 'long-phone'; assert.equal((await requestParcelDraftCommand(url, token, read()))[0].callerPhoneNumber.length, 20000);
  for (mode of ['lost', 'redirect', 'html', 'status', 'json', 'utf8', 'id', 'ack', 'duplicate', 'missing', 'foreign', 'forged', 'orphan-phone'])
    await assert.rejects(requestParcelDraftCommand(url, token, read()), undefined, mode);
});
test('deletion accepts only a matching boolean ACK and cleanup must explicitly succeed', async () => {
  mode = 'valid'; assert.equal(await requestParcelDraftCommand(url, token, check()), false);
  for (mode of ['boolean', 'id', 'ack', 'oversized']) await assert.rejects(requestParcelDraftCommand(url, token, check()));
  mode = 'valid'; await assert.rejects(requestParcelDraftCommand(url, token,
    { eventId: randomUUID(), source: 'order', eventType: 'LegacyDraftCallBindingsPruneRequested', payload: {} }));
  await assert.rejects(requestParcelDraftCommand(url, 'short', check()));
  await assert.rejects(requestParcelDraftCommand(url + '?redirect=1', token, check()));
});


test('draft visibility references preserve microseconds, bound scope inputs and return complete large phone candidates',async()=>{
  const {createHash}=require('node:crypto');
  const {requestDraftCallReferences,validateDraftCallReferences}=require('../parcel-drafts.cjs');
  const bigPhone='장'.repeat(400000);
  const query={callIds:[1],customerIds:[2],phones:['01012345678'],phoneHashes:[createHash('sha256').update(bigPhone).digest('hex')]};
  const event={eventId:randomUUID(),source:'order',eventType:'DraftCallReferencesRequested',payload:query};
  validateParcelDraftCommand(event,event.eventType,'order');
  for(const bad of [{...event,source:'consultation'},{...event,payload:{...query,sql:'SELECT private'}},
    {...event,payload:{...query,callIds:[1,1]}},{...event,payload:{...query,callIds:['1']}},
    {...event,payload:{...query,customerIds:Array.from({length:251},(_,n)=>n+1)}},
    {...event,payload:{...query,phones:[bigPhone]}},{...event,payload:{...query,phoneHashes:['bad']}}])
    assert.throws(()=>validateParcelDraftCommand(bad,'DraftCallReferencesRequested','order'));
  mode='valid';
  const value=await requestDraftCallReferences(url,token,{callIds:[1,1],customerIds:[2],phones:['01012345678',bigPhone]});
  assert.equal(value.calls[0].started_at,'2030-01-01T00:00:00.123456+00:00');
  assert.equal(value.phones[0].caller_phone_number,bigPhone);validateDraftCallReferences(value,query);
  assert.deepEqual(await requestDraftCallReferences(url,token,{callIds:[],customerIds:[],phones:[]}),{calls:[],customers:[],phones:[]});
  for(mode of ['draft-foreign','draft-duplicate','draft-time','draft-phone','id','ack','html','status','redirect'])
    await assert.rejects(requestDraftCallReferences(url,token,{callIds:[1],customerIds:[2],phones:[bigPhone]}));
  await assert.rejects(requestDraftCallReferences(url+'?private=1',token,{callIds:[1],customerIds:[2],phones:[]}));
  await assert.rejects(requestDraftCallReferences(url,'short',{callIds:[1],customerIds:[2],phones:[]}));
});


test('draft read scopes preserve anonymous and stored-customer context without large request bodies',async()=>{
  const {validateDraftRead,requestDraftReadCall}=require('../parcel-drafts.cjs');
  const {requestDraftRead,OrderReadError}=require('../order-read.cjs');
  const scopeId=randomUUID(),input={eventId:scopeId,source:'order',eventType:'ParcelDraftReadRequested',payload:{command:{operation:'ParcelDraftsListed',id:null,callSessionSeq:1,query:{limit:20,offset:0,status:'ALL'}},orderAddress:null}};
  validateDraftRead(input,'order');
  const {validateDraftReadResult}=require('../parcel-drafts.cjs');
  const row={draftSeq:3,reservedOrderSeq:7,callSessionSeq:1,customerSeq:null,callerPhoneNumber:null,createdByAdminUserSeq:null,clientParcelId:randomUUID(),parcel:{legacy:{keep:'unchanged'}},status:'EDITING',version:1,sourceDraftSeq:null,orderSeq:null,orderParcelSeq:null,legacyOrderSeq:null,legacyOrderParcelSeq:null,createdAt:'2030-01-01T00:00:00.000Z',updatedAt:'2030-01-01T00:00:00.000Z',retentionStartedAt:'2030-01-01T00:00:00.000Z'};
  validateDraftReadResult({data:[row],hasNext:false,total_count:1},input.payload.command);
  const detail={...input.payload.command,operation:'ParcelDraftDetailRead',id:3,query:{}};
  validateDraftReadResult({...row,intakeVersion:null},detail);
  assert.throws(()=>validateDraftReadResult({...row,intakeVersion:null,creationPayload:{}},detail));
  assert.throws(()=>validateDraftReadResult({...row,draftSeq:4,intakeVersion:1},detail));

  for(const changed of [{...input,source:'customer'},{...input,payload:{...input.payload,orderAddress:'127.0.0.1'}},{...input,payload:{...input.payload,command:{...input.payload.command,query:{limit:20,offset:0,status:'notPaid'}}}}])assert.throws(()=>validateDraftRead(changed,'order'));
  const oldFetch=global.fetch;let mode='call',seen=0;const rawPhone='긴'.repeat(400000);
  global.fetch=async(url,options)=>{
    seen++;const request=JSON.parse(options.body);assert.ok(Buffer.byteLength(options.body)<4096);
    if(mode==='error')return Response.json({error:{code:'FORBIDDEN',message:'source scope',details:[]}},{status:403});
    const call={callSessionSeq:1,callerPhoneNumber:rawPhone,customerSeq:null,enabled:true,endedAt:'2030-01-01T00:00:00.123456+00:00',intakeVersion:1};
    if(request.eventType==='ParcelDraftReadCallRequested'){
      assert.equal(options.headers['X-Msa-Read-Scope'],scopeId);
      if(mode==='wrongCall')call.callSessionSeq=2;
      return Response.json({eventId:request.eventId,status:'processed',payload:call});
    }
    const payload={data:[],hasNext:false,total_count:0};if(mode==='extra')payload.secret=true;
    return Response.json({eventId:mode==='wrong'?randomUUID():request.eventId,status:'processed',payload});
  };
  try {
    assert.equal((await requestDraftReadCall('http://consultation/private',token,1,scopeId,'customer')).callerPhoneNumber,rawPhone);
    mode='wrongCall';await assert.rejects(requestDraftReadCall('http://consultation/private',token,1,scopeId));
    mode='ok';assert.deepEqual(await requestDraftRead('http://consultation/private',token,input),{data:[],hasNext:false,total_count:0});
    for(mode of ['extra','wrong'])await assert.rejects(requestDraftRead('http://consultation/private',token,input));
    mode='error';await assert.rejects(requestDraftRead('http://consultation/private',token,input),error=>error instanceof OrderReadError&&error.status===403&&error.error.message==='source scope');
    const before=seen;await assert.rejects(requestDraftReadCall('http://consultation/private',token,1,'invalid'));await assert.rejects(requestDraftRead('http://user:pass@consultation/private',token,input));assert.equal(seen,before);
  } finally {global.fetch=oldFetch;}
});


test('draft deletion binds owner, actor, scope and phase and preserves source lock errors',async()=>{
  const {validateDraftDeletion,validateDraftDeletionResult}=require('../parcel-drafts.cjs');
  const {requestDraftDeletion,OrderReadError}=require('../order-read.cjs');
  const root={eventId:randomUUID(),source:'order',eventType:'ParcelDraftDeletionRequested',payload:{command:{id:1,adminId:2,requestId:randomUUID()},orderAddress:null}};
  const hint={...root,source:'consultation',payload:{command:root.payload.command,phase:'hint',callFinalized:null,consultationAddress:'10.1.2.3'}};
  const deletion={...hint,payload:{...hint.payload,phase:'delete',callFinalized:false}};
  for(const event of [root,hint,deletion])validateDraftDeletion(event,event.source);
  for(const bad of [{...root,source:'customer'},{...root,eventId:'invalid'},
    {...root,payload:{...root.payload,orderAddress:'127.0.0.1'}},
    {...root,payload:{...root.payload,command:{...root.payload.command,adminId:null}}},
    {...root,payload:{...root.payload,command:{...root.payload.command,id:'1'}}},
    {...root,payload:{...root.payload,command:{...root.payload.command,sql:'DELETE'}}},
    {...hint,payload:{...hint.payload,callFinalized:true}},
    {...deletion,payload:{...deletion.payload,phase:'commit'}},
    {...deletion,payload:{...deletion.payload,callFinalized:'false'}}])assert.throws(()=>validateDraftDeletion(bad,bad.source));
  validateDraftDeletionResult(null,hint);validateDraftDeletionResult({callSessionSeq:null},hint);
  validateDraftDeletionResult({callSessionSeq:1},hint);validateDraftDeletionResult(true,deletion);validateDraftDeletionResult(true,root);
  for(const value of [true,{callSessionSeq:0},{callSessionSeq:1,finalized:true}])assert.throws(()=>validateDraftDeletionResult(value,hint));
  for(const value of [null,false,{},'true'])assert.throws(()=>validateDraftDeletionResult(value,deletion));
  const oldFetch=global.fetch;let mode='hint',calls=0;
  global.fetch=async(url,options)=>{
    calls++;const request=JSON.parse(options.body);
    assert.equal(options.headers.Authorization,'Bearer '+token);
    if(mode==='lock')return Response.json({error:{code:'REQUEST_IN_PROGRESS',message:'source lock timeout',details:[]}},{status:409});
    return Response.json({eventId:mode==='wrong'?randomUUID():request.eventId,status:'processed',payload:mode==='hint'?{callSessionSeq:3}:mode==='invalid'?false:true});
  };
  try {
    assert.deepEqual(await requestDraftDeletion('http://order/private',token,hint),{callSessionSeq:3});
    mode='delete';assert.equal(await requestDraftDeletion('http://consultation/private',token,root),true);
    for(mode of ['wrong','invalid'])await assert.rejects(requestDraftDeletion('http://order/private',token,deletion));
    mode='lock';await assert.rejects(requestDraftDeletion('http://order/private',token,deletion),error=>error instanceof OrderReadError&&error.status===409&&error.error.code==='REQUEST_IN_PROGRESS');
    const before=calls;await assert.rejects(requestDraftDeletion('http://user:pass@order/private',token,deletion));assert.equal(calls,before);
  } finally {global.fetch=oldFetch;}
});

test('intake writes bind call, completion policy and durable finalization mappings', () => {
  const {
    validateDraftWrite,
    validateWriteReference,
  } = require('../parcel-draft-write.cjs');
  const {
    validateFinalization,
    validatePolicy,
    finalizationId,
  } = require('../order-intake-write.cjs');
  const event = {
    eventId: randomUUID(),
    source: 'order',
    eventType: 'ParcelDraftWriteRequested',
    payload: {
      orderAddress: null,
      command: {
        operation: 'OrderIntakeSealed',
        id: 1,
        adminId: null,
        callSessionSeq: 1,
        input: { expectedIntakeVersion: 1 },
        requestId: randomUUID(),
      },
    },
  };
  validateDraftWrite(event, 'order');
  for (const change of [
    (e) => (e.payload.command.adminId = 1),
    (e) => (e.payload.command.id = 2),
    (e) => (e.payload.command.input.expectedIntakeVersion = 0),
    (e) => (e.payload.command.input.paymentMethodType = null),
    (e) => (e.payload.command.input.actorId = 1),
  ]) {
    const bad = structuredClone(event);
    change(bad);
    assert.throws(() => validateDraftWrite(bad, 'order'));
  }
  event.payload.command.operation = 'OrderIntakeFinalized';
  event.payload.command.input = {};
  validateDraftWrite(event, 'order');
  assert.equal(finalizationId(1), finalizationId(1));
  assert.notEqual(finalizationId(1), finalizationId(2));
  const result = {
    eventId: randomUUID(),
    callSessionSeq: 1,
    expectedIntakeVersion: 1,
    finalizedAt: new Date().toISOString(),
    orderSeq: 2,
    parcelMappings: [{ draftSeq: 3, orderParcelSeq: 4 }],
    requestId: randomUUID(),
  };
  validateFinalization(result);
  for (const change of [
    (e) => e.parcelMappings.push(e.parcelMappings[0]),
    (e) => (e.orderSeq = null),
    (e) => (e.expectedIntakeVersion = 0),
    (e) => (e.parcelMappings[0].orderParcelSeq = 0),
    (e) => (e.finalizedAt = 'invalid'),
    (e) => (e.actorId = 1),
  ]) {
    const bad = structuredClone(result);
    change(bad);
    assert.throws(() => validateFinalization(bad));
  }
  validateFinalization({ ...result, orderSeq: null, parcelMappings: [] });
  const policy = {
    monthly: true,
    group: false,
    organizationSeq: null,
    departmentSeq: null,
    organizationName: null,
    departmentName: null,
  };
  validatePolicy(policy);
  assert.throws(() => validatePolicy({ ...policy, group: true }));
  assert.throws(() => validatePolicy({ ...policy, actorId: 1 }));
  const reference = {
    eventId: randomUUID(),
    source: 'consultation',
    eventType: 'ParcelDraftWriteReferenceRequested',
    payload: { operation: 'IntakeFinalizationRead', input: { id: 1 } },
  };
  validateWriteReference(reference);
  assert.throws(() =>
    validateWriteReference({ ...reference, source: 'order' }),
  );
});

test('durable intake receipts are read without a live write scope while mutation references require one', async () => {
  const { requestWriteReference } = require('../parcel-draft-write.cjs');
  const saved = global.fetch;
  let seen = 0,
    payload = null;
  global.fetch = async (url, options) => {
    seen++;
    const event = JSON.parse(options.body);
    return Response.json({
      eventId: event.eventId,
      status: 'processed',
      payload,
    });
  };
  const event = {
    eventId: randomUUID(),
    source: 'consultation',
    eventType: 'ParcelDraftWriteReferenceRequested',
    payload: { operation: 'IntakeFinalizationRead', input: { id: 1 } },
  };
  try {
    assert.equal(
      await requestWriteReference('http://order/private', token, event),
      null,
    );
    assert.equal(seen, 1);
    payload = {
      eventId: randomUUID(),
      callSessionSeq: 1,
      expectedIntakeVersion: 1,
      finalizedAt: new Date().toISOString(),
      orderSeq: 2,
      requestId: randomUUID(),
      parcelMappings: Array.from({ length: 20000 }, (_, i) => ({
        draftSeq: i + 1,
        orderParcelSeq: i + 1,
      })),
    };
    assert.ok(Buffer.byteLength(JSON.stringify(payload)) > 256 * 1024);
    assert.equal(
      (await requestWriteReference('http://order/private', token, event))
        .parcelMappings.length,
      20000,
    );
    const mutation = {
      ...event,
      source: 'order',
      payload: { operation: 'IntakeCallRead', input: { id: 1 } },
    };
    assert.throws(() =>
      requestWriteReference('http://consultation/private', token, mutation),
    );
    assert.equal(seen, 2);
  } finally {
    global.fetch = saved;
  }
});

test('write hops await source transactions while individual reference requests keep a deadline',async()=>{
  const {requestDraftWrite,requestWriteReference}=require('../parcel-draft-write.cjs');
  const signals=[],saved=global.fetch;
  global.fetch=async(url,options)=>{signals.push(options.signal);const input=JSON.parse(options.body);
    return Response.json({eventId:input.eventId,status:'processed',payload:input.eventType==='ParcelDraftWriteRequested'?{data:{sealed:true},receipt:null}:null});};
  try {
    const input={eventId:randomUUID(),source:'order',eventType:'ParcelDraftWriteRequested',payload:{orderAddress:null,
      command:{operation:'OrderIntakeSealed',id:1,adminId:null,callSessionSeq:1,input:{expectedIntakeVersion:1},requestId:randomUUID()}}};
    assert.deepEqual(await requestDraftWrite('http://consultation/private',token,input),{data:{sealed:true},receipt:null});
    assert.equal(signals[0],null);
    await requestWriteReference('http://order/private',token,{eventId:randomUUID(),source:'consultation',eventType:'ParcelDraftWriteReferenceRequested',payload:{operation:'IntakeFinalizationRead',input:{id:1}}});
    assert.ok(signals[1] instanceof AbortSignal);
  } finally {global.fetch=saved;}
});

test('order updates bind durable call links and preserve the original customer association',async()=>{
  const {validateDraftWrite,validateReceipt,validateOrderCallLink,requestDraftWrite,requestWriteReference}=require('../parcel-draft-write.cjs');
  const mutation={callSessionSeq:1,beforeOrderSeq:null,beforeCustomerSeq:null,orderSeq:42,customerSeq:3};
  const receipt={eventId:randomUUID(),payload:mutation};validateReceipt(receipt);
  for(const changed of [{...mutation,beforeOrderSeq:2},{...mutation,beforeCustomerSeq:2},{...mutation,orderSeq:0},{...mutation,afterVersion:1}])assert.throws(()=>validateOrderCallLink(changed));
  validateOrderCallLink({...mutation,beforeCustomerSeq:3});
  const input={eventId:randomUUID(),source:'order',eventType:'ParcelDraftWriteRequested',payload:{orderAddress:null,
    command:{operation:'OrderUpdated',id:42,adminId:null,callSessionSeq:1,input:{expectedVersion:1,pickupRequestedAt:null},requestId:randomUUID()}}};
  validateDraftWrite(input,'order');
  const adminCommand={...input,payload:{...input.payload,command:{...input.payload.command,adminId:1}}};
  validateDraftWrite(adminCommand,'order');
  validateDraftWrite({...adminCommand,payload:{...adminCommand.payload,command:{...adminCommand.payload.command,callSessionSeq:null}}},'order');
  assert.throws(()=>validateDraftWrite({...adminCommand,payload:{...adminCommand.payload,command:{...adminCommand.payload.command,operation:'ParcelDraftUpdated'}}},'order'));
  const saved=global.fetch;let mode='update';
  global.fetch=async(url,options)=>{const event=JSON.parse(options.body);return Response.json({eventId:event.eventId,status:'processed',
    payload:mode==='update'?{data:{version:4},receipt}:mode==='customer'?{customerSeq:3,phone:'01011112222',active:false}:
    {callSessionSeq:1,customerSeq:3,orderSeq:mode==='wrong-order'?43:42,callerPhoneNumber:'01011112222',enabled:false,endedAt:null,intakeVersion:1,completionReceivedAt:null}});};
  try {
    assert.deepEqual(await requestDraftWrite('http://consultation/private',token,input),{data:{version:4},receipt});
    const reference={eventId:randomUUID(),source:'order',eventType:'ParcelDraftWriteReferenceRequested',payload:{operation:'CallOrderLinked',input:{id:1,orderSeq:42,customerSeq:3}}};
    mode='call';assert.equal((await requestWriteReference('http://consultation/private',token,reference,randomUUID())).orderSeq,42);
    mode='wrong-order';await assert.rejects(requestWriteReference('http://consultation/private',token,reference,randomUUID()));
    mode='customer';assert.equal((await requestWriteReference('http://customer/private',token,{...reference,payload:{operation:'OrderCustomerRead',input:{id:3}}},randomUUID())).active,false);
  } finally {global.fetch=saved;}
});

test('order submission receipts bind recipients to the command and preserve unbounded stored address reads', async () => {
  const {
    validateRecipientAddresses,
    validateRecipientPins,
    validateRecipientReceipt,
  } = require('../order-recipient-pins.cjs');
  const {
    validateDraftWrite,
    requestDraftWrite,
    requestWriteReference,
  } = require('../parcel-draft-write.cjs');
  const address = {
    name: '수령인',
    phoneNumber: '01012345678',
    roadAddress: '도로',
    jibunAddress: '지번',
    detailAddress: '',
    dongName: '동',
    postalCode: '12345',
  };
  const pin = {
    personalPinSeq: 4,
    label: address.name,
    address,
  };
  validateRecipientAddresses([address]);
  validateRecipientPins([pin]);
  for (const value of [
    [{ ...address, name: null }],
    [{ ...address, detailAddress: '\u0000' }],
    [{ ...address, extra: true }],
  ])
    assert.throws(() => validateRecipientAddresses(value));
  assert.throws(() => validateRecipientPins([pin, pin]));
  assert.throws(() => validateRecipientPins([{ ...pin, label: 'changed' }]));
  const requestId = randomUUID(),
    writeEventId = randomUUID(),
    receipt = {
      eventId: randomUUID(),
      payload: {
        orderSeq: 42,
        customerSeq: 3,
        adminId: 1,
        requestId,
        pins: [pin],
        writeEventId,
      },
    };
  validateRecipientReceipt(receipt);
  assert.throws(() =>
    validateRecipientReceipt({
      ...receipt,
      payload: { ...receipt.payload, adminId: 0 },
    }),
  );
  const input = {
    eventId: writeEventId,
    source: 'order',
    eventType: 'ParcelDraftWriteRequested',
    payload: {
      orderAddress: null,
      command: {
        operation: 'OrderSubmitted',
        id: 42,
        adminId: 1,
        callSessionSeq: 5,
        input: { expectedVersion: 1 },
        requestId,
      },
    },
  };
  validateDraftWrite(
    {
      ...input,
      source: 'consultation',
      payload: { ...input.payload, consultationAddress: null, call: null },
    },
    'consultation',
  );
  assert.throws(() =>
    validateDraftWrite(
      {
        ...input,
        source: 'consultation',
        payload: {
          ...input.payload,
          command: { ...input.payload.command, adminId: null },
          consultationAddress: null,
          call: null,
        },
      },
      'consultation',
    ),
  );
  const addresses = Array.from({ length: 20000 }, () => address),
    saved = global.fetch;
  let mode = 'submission';
  assert.ok(Buffer.byteLength(JSON.stringify(addresses)) > 256 * 1024);
  global.fetch = async (url, options) => {
    const event = JSON.parse(options.body);
    return Response.json({
      eventId: event.eventId,
      status: 'processed',
      payload:
        mode === 'addresses'
          ? addresses
          : mode === 'receipt'
            ? receipt
            : {
                data: { status: 'notPaid' },
                receipt: null,
                customerReceipt:
                  mode === 'forged'
                    ? {
                        ...receipt,
                        payload: { ...receipt.payload, orderSeq: 43 },
                      }
                    : mode === 'forgedScope'
                      ? {
                          ...receipt,
                          payload: {
                            ...receipt.payload,
                            writeEventId: randomUUID(),
                          },
                        }
                      : receipt,
              },
    });
  };
  try {
    assert.equal(
      (await requestDraftWrite('http://consultation/private', token, input))
        .customerReceipt.eventId,
      receipt.eventId,
    );
    mode = 'forged';
    await assert.rejects(
      requestDraftWrite('http://consultation/private', token, input),
    );
    mode = 'forgedScope';
    await assert.rejects(
      requestDraftWrite('http://consultation/private', token, input),
    );
    const event = {
      eventId: randomUUID(),
      source: 'customer',
      eventType: 'ParcelDraftWriteReferenceRequested',
      payload: { operation: 'OrderRecipientsRead', input: { id: 42 } },
    };
    mode = 'addresses';
    assert.equal(
      (
        await requestWriteReference(
          'http://order/private',
          token,
          event,
          randomUUID(),
        )
      ).length,
      20000,
    );
    mode = 'receipt';
    assert.deepEqual(
      await requestWriteReference('http://order/private', token, {
        ...event,
        payload: {
          operation: 'RecipientReceiptRead',
          input: { eventId: receipt.eventId },
        },
      }),
      receipt,
    );
  } finally {
    global.fetch = saved;
  }
});


test('administrator draft submissions bind the draft and separately reserved order to their receipt', async () => {
  const {
    validateDraftWrite,
    requestDraftWrite,
  } = require('../parcel-draft-write.cjs');
  const event = {
    eventId: randomUUID(),
    source: 'order',
    eventType: 'ParcelDraftWriteRequested',
    payload: {
      orderAddress: null,
      command: {
        operation: 'AdminParcelDraftSubmitted',
        id: 5,
        adminId: 1,
        callSessionSeq: null,
        input: { expectedVersion: 1, paymentMethodType: 'billing' },
        requestId: randomUUID(),
      },
    },
  };
  validateDraftWrite(event, 'order');
  for (const change of [{ adminId: null }, { callSessionSeq: 1 }])
    assert.throws(() =>
      validateDraftWrite(
        {
          ...event,
          payload: {
            ...event.payload,
            command: { ...event.payload.command, ...change },
          },
        },
        'order',
      ),
    );
  const receipt = {
    eventId: randomUUID(),
    payload: {
      writeEventId: event.eventId,
      orderSeq: 42,
      customerSeq: 3,
      adminId: 1,
      requestId: event.payload.command.requestId,
      pins: [],
    },
  };
  const result = {
    data: {
      orderSeq: 42,
      callSessionSeq: null,
      version: 2,
      status: 'notPaid',
      totalAmount: 5000,
      parcelNo: null,
      paymentDueAt: null,
      paymentRequest: null,
      draftSeq: 5,
      orderParcelSeq: 9,
    },
    receipt: null,
    customerReceipt: receipt,
  };
  const saved = global.fetch;
  let response = result;
  global.fetch = async (_url, options) =>
    Response.json({
      eventId: JSON.parse(options.body).eventId,
      status: 'processed',
      payload: response,
    });
  try {
    assert.deepEqual(
      await requestDraftWrite('http://consultation/private', token, event),
      result,
    );
    for (const data of [
      { draftSeq: 6 },
      { callSessionSeq: 1 },
      { orderParcelSeq: 0 },
      { status: 'other' },
    ]) {
      response = { ...result, data: { ...result.data, ...data } };
      await assert.rejects(
        requestDraftWrite('http://consultation/private', token, event),
      );
    }
    response = {
      ...result,
      customerReceipt: {
        ...receipt,
        payload: { ...receipt.payload, orderSeq: 5 },
      },
    };
    await assert.rejects(
      requestDraftWrite('http://consultation/private', token, event),
    );
  } finally {
    global.fetch = saved;
  }
});
