require('reflect-metadata');
const { before,after,test }=require('node:test');
const assert=require('node:assert/strict');
const {createServer}=require('node:http');
const {CustomerContextClient,contextResponse}=require('../dist/customers/customer-context.client');
const {validateEnvironment}=require('../dist/config/environment');
const token='context-test-only-token-'.padEnd(48,'a');
const empty={lookupStatus:'UNREGISTERED',customer:null,membership:null,organization:null,department:null,availableUsageTypes:[],availablePaymentMethods:[],personalPins:[],companyPins:[]};
let mode='context',server,client,requests=0;
before(async()=>{
 server=createServer(async(req,res)=>{
  requests++; assert.equal(req.headers.authorization,'Bearer '+token);assert.equal(req.headers.cookie,undefined);
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const event=JSON.parse(Buffer.concat(chunks));assert.equal(event.source,'consultation');assert.equal(req.url,'/internal/caller-context');
  if(mode==='timeout')return;
  if(mode==='redirect'){res.writeHead(307,{Location:'/exfiltrate'}).end();return;}
  res.setHeader('Content-Type',mode==='html'?'text/html':'application/json');
  if(mode===503){res.writeHead(503).end('{}');return;}
  const payload=event.eventType==='CallCustomerRequested'?{customerSeq:mode==='reference'?12:null}:structuredClone(empty);
  if(mode==='pins')payload.personalPins=Array.from({length:1500},(_,i)=>({personalPinSeq:i+1,label:'현재 주소록',addressData:{roadAddress:'배송지',detailAddress:'주소 본문 보존'},version:1}));
  if(mode==='invalid')payload.lookupStatus='UNKNOWN';
  if(mode==='extra')payload.secret='must-not-leak';
  res.end(mode==='json'?'{':JSON.stringify({eventId:mode==='wrong-id'?'bad':event.eventId,status:'processed',payload}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const config={CUSTOMER_URL:`http://127.0.0.1:${server.address().port}`,CONSULTATION_AUTH_TOKEN:token};
 client=new CustomerContextClient({get:key=>config[key]});
});
after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
test('reads a fresh complete context on every event without forwarding administrator credentials',async()=>{
 mode='context';const before=requests;assert.deepEqual(await client.context('000'),empty);assert.deepEqual(await client.context('000'),empty);assert.equal(requests,before+2);
});
test('preserves the unpaginated personal PIN contract instead of truncating the response',async()=>{
 mode='pins';const value=await client.context('01012345678');assert.equal(value.personalPins.length,1500);assert.equal(value.personalPins[1499].addressData.detailAddress,'주소 본문 보존');
});
test('validates nullable logical customer references separately from hidden public context',async()=>{
 mode='reference';assert.equal(await client.callCustomer('01012345678'),12);mode='context';assert.equal(await client.callCustomer('01012345678'),null);
});
test('rejects dependency errors, redirects and malformed response envelopes or context shapes',async()=>{
 for(mode of [503,'redirect','html','json','wrong-id','invalid','extra'])await assert.rejects(client.context('01012345678'));
 for(const value of [null,{},[],{...empty,lookupStatus:'REGISTERED'},{...empty,companyPins:[{}]},{...empty,personalPins:[{personalPinSeq:1}]}])assert.throws(()=>contextResponse(value));
});
test('bounds a stalled read and retains the dependency failure',async()=>{mode='timeout';await assert.rejects(client.context('01012345678'));});
test('requires an exact trusted customer origin without exposing invalid values',()=>{
 const base={NODE_ENV:'test',DB_HOST:'unused',DB_USER:'test',DB_PASSWORD:'test',DB_NAME:'test',OPERATIONS_URL:'http://operations:3005',CONSULTATION_AUTH_TOKEN:token,CUSTOMER_AUTH_TOKEN:'customer-test-service-token-'.padEnd(48,'c'),CUSTOMER_URL:'http://customer:3001'};
 assert.equal(validateEnvironment(base).CUSTOMER_URL,base.CUSTOMER_URL);
 for(const value of [undefined,{},'http://user:secret@customer:3001','http://customer:3001/path','file:///secret','http://customer:3001?token=secret','http://customer:3001/'])
  assert.throws(()=>validateEnvironment({...base,CUSTOMER_URL:value}),error=>error.fields.includes('CUSTOMER_URL')&&!error.message.includes('secret'));
});
