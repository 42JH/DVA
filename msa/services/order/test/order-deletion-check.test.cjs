require('reflect-metadata');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { randomUUID } = require('node:crypto');
const { OrderDeletionCheckClient } = require('../dist/orders/order-deletion-check.client');
let server, mode, client;
const token = 'deletion-check-test-only-'.padEnd(40, 'x');
before(async()=> {
  server = createServer(async(request,response)=> {
    assert.equal(request.url,'/internal/order-deletion-check');
    assert.equal(request.headers.authorization,'Bearer '+token);
    const parts=[];for await(const part of request)parts.push(part);
    const event=JSON.parse(Buffer.concat(parts));
    assert.equal(event.source,'order');assert.equal(event.eventType,'OrderDeletionCheckRequested');
    assert.deepEqual(event.payload,{orderSeq:17});
    if(mode==='lost') {request.socket.destroy();return;}
    if(mode==='redirect') {response.writeHead(307,{Location:'/unexpected'}).end();return;}
    response.setHeader('Content-Type',mode==='html'?'text/html':'application/json');
    if(mode==='failure') {response.writeHead(500).end('{}');return;}
    const result={eventId:event.eventId,status:'processed',payload:{blocked:mode==='blocked'}};
    if(mode==='wrong-id')result.eventId=randomUUID();
    if(mode==='wrong-status')result.status='received';
    if(mode==='bad-boolean')result.payload.blocked='false';
    if(mode==='extra-payload')result.payload.callSessionSeq=22;
    if(mode==='extra-envelope')result.debug='private';
    response.end(mode==='invalid-json'?'{' : mode==='oversized'?' '.repeat(4097):mode==='bad-utf8'?Buffer.from([0xff]):JSON.stringify(result));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const config={CONSULTATION_URL:'http://127.0.0.1:'+server.address().port,CUSTOMER_AUTH_TOKEN:token};
  client=new OrderDeletionCheckClient({get:key=>config[key]});
});
after(async()=> {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});

test('uses the existing service token and accepts only a matching boolean acknowledgement',async()=> {
  mode='valid';assert.equal(await client.blocked(17),false);
  mode='blocked';assert.equal(await client.blocked(17),true);
  for(mode of ['lost','redirect','html','failure','wrong-id','wrong-status','bad-boolean','extra-payload','extra-envelope','invalid-json','oversized','bad-utf8'])
    await assert.rejects(client.blocked(17),error=>error.getStatus()===503&&!JSON.stringify(error.getResponse()).includes('private'));
});
