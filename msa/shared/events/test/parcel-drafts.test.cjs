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
