require('reflect-metadata');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {ServiceAuditReceiver}=require('../dist/audit/service-audit.receiver');

test('a consultation recovery outage does not prevent order recovery and shutdown waits for both',async t=> {
  let tick,release,finished=false;
  t.mock.method(global,'setInterval',work=>{tick=work;return{unref(){}};});
  t.mock.method(global,'clearInterval',()=>{});
  const receiver=new ServiceAuditReceiver({pool:{}},{get:()=>undefined},{}),seen=[];
  receiver.flushPending=async services=> {
    seen.push(...services);
    if(services[0]==='consultation')throw Error('unavailable');
    await new Promise(resolve=>{release=resolve;});finished=true;
  };
  receiver.onModuleInit();tick();
  assert.deepEqual(seen,['consultation','order']);
  const stopping=receiver.onModuleDestroy();await Promise.resolve();assert.equal(finished,false);
  release();await stopping;assert.equal(finished,true);
});
