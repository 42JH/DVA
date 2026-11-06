require('reflect-metadata');
const {before,after,test}=require('node:test');
const assert=require('node:assert/strict');
const {createServer}=require('node:http');
const {randomUUID}=require('node:crypto');
const {CallInsightsRepository}=require('../dist/call-insights/call-insights.repository');
let server,repository,mode,requests=0;
const token='analysis-private-consultation-token-'.padEnd(48,'s');
before(async()=>{
  server=createServer(async(req,res)=>{
    requests++;
    assert.equal(req.headers.authorization,'Bearer '+token);
    assert.equal(req.headers.cookie,undefined);
    assert.equal(req.url,'/internal/persona-version');
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const event=JSON.parse(Buffer.concat(chunks));
    assert.equal(event.source,'consultation');assert.equal(event.eventType,'PersonaVersionRequested');
    assert.equal(event.payload.versionSeq,7);assert.equal(event.payload.callSessionSeq,12);
    assert.match(event.payload.transactionId,/^[0-9a-f-]{36}$/);
    if(mode==='timeout')return;
    if(mode==='redirect'){res.writeHead(307,{Location:'/leak'}).end();return;}
    if(typeof mode==='number'){res.writeHead(mode).end('{}');return;}
    res.setHeader('Content-Type',mode==='html'?'text/html':'application/json');
    res.end(mode==='oversized'?'x'.repeat(4097):mode==='json'?'{':JSON.stringify({
      eventId:mode==='wrong-id'?'00000000-0000-4000-8000-000000000001':event.eventId,
      status:mode==='duplicate'?'duplicate':'processed',payload:{exists:mode==='invalid'?'true':mode==='present'},
    }));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const config={OPERATIONS_URL:`http://127.0.0.1:${server.address().port}`,CONSULTATION_AUTH_TOKEN:token};
  repository=new CallInsightsRepository({get:key=>config[key]},{begin:async()=>randomUUID()});
});
after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
test('persona lookup reads current state each time without accessing a local version table',async()=>{
  const client={query:()=>assert.fail('operations owns persona versions')};
  mode='present';assert.equal(await repository.personaVersionExists(client,7,12),true);
  mode='absent';assert.equal(await repository.personaVersionExists(client,7,12),false);
  assert.equal(requests,2);
});
test('persona query fails closed on bad authentication, redirects and invalid acknowledgements',async()=>{
  for(mode of [401,403,404,500,'redirect','html','oversized','json','wrong-id','duplicate','invalid'])
    await assert.rejects(repository.personaVersionExists({},7,12));
});
test('persona query bounds stalled operations requests',async()=>{
  mode='timeout';await assert.rejects(repository.personaVersionExists({},7,12));
});
