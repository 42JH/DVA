require('reflect-metadata');
const {before,after,test}=require('node:test');
const assert=require('node:assert/strict');
const {createServer}=require('node:http');
const {AuditService}=require('../dist/audit/audit.service');
let server,audit,mode,received;
const token='analysis-private-consultation-token-'.padEnd(48,'s');
const event={actorId:null,actorType:'AI',action:'CALL_ANALYSIS_RECORDED',targetType:'CALL_SESSION',targetId:1,requestId:'audit-request'};
const client={query:async sql=>{
  if(sql.startsWith('SELECT pg_advisory_xact_lock'))return{rows:[]};
  if(sql.includes('transaction_timestamp'))return{rows:[{at:new Date('2026-11-01T00:00:00Z')}]};
  assert.ok(sql.includes('FROM call_analyses'));return{rows:[{ai_persona_version_seq:7}]};
}};
before(async()=>{
  server=createServer(async(req,res)=>{
    assert.equal(req.headers.authorization,'Bearer '+token);
    assert.equal(req.url,'/internal/events');
    const chunks=[];for await(const chunk of req)chunks.push(chunk);received=JSON.parse(Buffer.concat(chunks));
    if(typeof mode==='number'){res.writeHead(mode).end('{}');return;}
    res.setHeader('Content-Type','application/json');
    res.end(mode==='oversized'?'x'.repeat(4097):JSON.stringify({eventId:received.eventId,
      status:mode==='array'?['processed']:mode==='duplicate'?'duplicate':'processed'}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const config={OPERATIONS_URL:`http://127.0.0.1:${server.address().port}`,CONSULTATION_AUTH_TOKEN:token};
  audit=new AuditService({pool:{}},{get:key=>config[key]});
});
after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
test('analysis preparation privately protects the real version without changing the public audit',async()=>{
  for(mode of ['processed','duplicate']){
    audit.clear(client);await audit.recordSuccess(event,client);
    assert.equal(received.payload.personaVersionSeq,7);assert.deepEqual(received.payload.audit,event);
    assert.equal(received.payload.result,'SUCCESS');assert.equal(received.payload.occurredAt,'2026-11-01T00:00:00.000Z');
  }
});
test('deleted persona race retains its source 404 instead of committing an invalid analysis',async()=>{
  mode=404;audit.clear(client);await assert.rejects(audit.recordSuccess(event,client),{status:404});
});
test('analysis preparation rejects unconfirmed and oversized acknowledgements',async()=>{
  for(mode of [500,'array','oversized']){audit.clear(client);await assert.rejects(audit.recordSuccess(event,client));}
});
