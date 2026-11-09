require('reflect-metadata');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {OrderShipmentCheckController}=require('../dist/order-shipment-check.controller');
const {validateEnvironment}=require('../dist/environment');
const token='shipment-owner-test-only-'.padEnd(40,'x');
const event=()=>({eventId:randomUUID(),source:'order',eventType:'OrderShipmentCheckRequested',payload:{orderParcelSeqs:[1,2]}});
test('rejects credentials and command forgery before local DB access, then rereads without response persistence',async()=>{
  let calls=0,present=false;
  const controller=new OrderShipmentCheckController({transaction:work=>work({query:async(sql,params)=>{calls++;assert.match(sql,/ORDER BY shipment_seq FOR UPDATE/);assert.deepEqual(params,[[1,2]]);return{rowCount:present?1:0};}})},{get:()=>token});
  await assert.rejects(controller.query(event(),'Bearer wrong'),e=>e.getStatus()===403);
  for(const mutate of [e=>e.source='customer',e=>e.eventType='OrderCreated',e=>e.payload.adminId=1,e=>e.payload.orderParcelSeqs=[1,1],e=>e.payload.orderParcelSeqs=['1'],e=>e.payload.orderParcelSeqs=[0]]){
    const bad=event();mutate(bad);await assert.rejects(controller.query(bad,'Bearer '+token),e=>e.getStatus()===422);
  }
  assert.equal(calls,0);const value=event();
  assert.deepEqual(await controller.query(value,'Bearer '+token),{eventId:value.eventId,status:'processed',payload:{blocked:false}});
  present=true;assert.equal((await controller.query(value,'Bearer '+token)).payload.blocked,true);assert.equal(calls,2);
});
test('validates DB/token config without exposing invalid values',()=>{
  const raw={DB_HOST:'db',DB_USER:'delivery_app',DB_PASSWORD:'private',DB_NAME:'delivery',CUSTOMER_AUTH_TOKEN:token};
  assert.equal(validateEnvironment(raw).PORT,3003);
  for(const patch of [{DB_HOST:''},{CUSTOMER_AUTH_TOKEN:'private'},{DB_PORT:'0'},{PORT:'99999'}])assert.throws(()=>validateEnvironment({...raw,...patch}),e=>!e.message.includes('private'));
});
