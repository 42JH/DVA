require('reflect-metadata');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {CallContextClient}=require('../dist/customers/call-context.client');
const {ApiException}=require('../dist/common/errors/api.exception');
const {validateEnvironment}=require('../dist/config/environment');
const token='private-test-customer-token-'.padEnd(48,'a');
const config={OPERATIONS_URL:'http://operations:3005',CUSTOMER_AUTH_TOKEN:token,CONSULTATION_URL:'http://consultation:3004'};
const client=new CallContextClient({get:key=>config[key]});
const input={phoneNumber:'01012345678',call:{providerCallId:'fixed',incomingAt:'2026-10-27T00:00:00Z'}};
const context={callSessionSeq:1,lookupStatus:'UNREGISTERED',customer:null,membership:null,organization:null,department:null,availablePaymentMethods:[],availableUsageTypes:[],personalPins:[],companyPins:[]};
test('sends the original input and verified actor in a correlated event without cookies',async t=>{
 const requestId=randomUUID();
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  assert.equal(url,config.CONSULTATION_URL+'/internal/caller-context');assert.equal(options.redirect,'error');assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.headers.Authorization,'Bearer '+token);assert.equal(options.headers.Cookie,undefined);
  const event=JSON.parse(options.body);assert.equal(event.source,'customer');assert.equal(event.eventType,'CallerContextRequested');assert.deepEqual(event.payload,{input,actorId:null,requestId});
  return new Response(JSON.stringify({eventId:event.eventId,status:'processed',payload:context}),{headers:{'Content-Type':'application/json'}});
 });
 assert.deepEqual(await client.context(input,null,requestId),context);
});
test('rejects malformed command replies instead of accepting a partial or unrelated success',async t=>{
 for(const change of ['event-id','extra','call-id','missing','json','html']){
  t.mock.method(globalThis,'fetch',async(_url,options)=>{
   const event=JSON.parse(options.body),payload={...context};if(change==='extra')payload.secret='must-not-leak';if(change==='call-id')payload.callSessionSeq=0;if(change==='missing')delete payload.personalPins;
   return new Response(change==='json'?'{':JSON.stringify({eventId:change==='event-id'?randomUUID():event.eventId,status:'processed',payload}),{headers:{'Content-Type':change==='html'?'text/html':'application/json'}});
  });
  await assert.rejects(client.context(input,null,randomUUID()));
 }
});
test('preserves known business conflicts while failing closed on authentication or transport errors',async t=>{
 t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({code:'INVALID_STATE',message:'원본 통화 충돌',details:[]}),{status:409,headers:{'Content-Type':'application/json'}}));
 await assert.rejects(client.context(input,null,randomUUID()),e=>e instanceof ApiException&&e.getStatus()===409&&e.getResponse().message==='원본 통화 충돌');
 t.mock.method(globalThis,'fetch',async()=>new Response('{}',{status:401,headers:{'Content-Type':'application/json'}}));await assert.rejects(client.context(input,null,randomUUID()),e=>!(e instanceof ApiException));
 t.mock.method(globalThis,'fetch',async()=>{throw new Error('network unavailable');});await assert.rejects(client.context(input,null,randomUUID()));
});
test('validates consultation configuration and keeps ordinary customer APIs usable without it',()=>{
 const base={DB_HOST:'db',DB_USER:'test',DB_PASSWORD:'test',DB_NAME:'test',OPERATIONS_URL:config.OPERATIONS_URL,CUSTOMER_AUTH_TOKEN:token};
 assert.equal(validateEnvironment(base).CONSULTATION_URL,undefined);
 assert.equal(validateEnvironment({...base,CONSULTATION_URL:config.CONSULTATION_URL}).CONSULTATION_URL,config.CONSULTATION_URL);
 for(const value of [{},'http://user:private@consultation:3004','http://consultation:3004/path','file:///private'])assert.throws(()=>validateEnvironment({...base,CONSULTATION_URL:value}),e=>e.fields.includes('CONSULTATION_URL')&&!e.message.includes('private'));
 for(const value of ['short','x'.repeat(257),'x'.repeat(32)+'\n',{}])assert.throws(()=>validateEnvironment({...base,CONSULTATION_AUTH_TOKEN:value}));
});
