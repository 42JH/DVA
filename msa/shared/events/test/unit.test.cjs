const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { validateEvent, createReceiver, createRelay, sendEvent } = require('../index.cjs');

const token = 'test-only-event-key-'.padEnd(40, 'a');
const event = () => ({ eventId: randomUUID(), source: 'order', eventType: 'OrderAccepted', payload: { orderSeq: 1 } });

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
