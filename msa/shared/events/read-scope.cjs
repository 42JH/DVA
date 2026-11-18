'use strict';
function validateReadScope(id) {
  if(typeof id!=='string'||!(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)))throw new Error('Invalid read scope');
}
function readCallbackUrl(origin,path,address) {
  const url=new URL(origin);
  if(!['http:','https:'].includes(url.protocol)||url.origin!==origin||url.username||url.password)throw new Error('Invalid read origin');
  if(address!==null){if(!require('./call-event-reference.cjs').privateAddress(address))throw new Error('Invalid read address');url.hostname=address;}
  url.pathname=path;return url.href;
}
class ReadScopes {
  constructor(unavailable){this.active=new Map();this.unavailable=unavailable;}
  async run(id,client,work) {
    validateReadScope(id);
    if(this.active.has(id))throw this.unavailable();
    const scope={client,closing:false,pending:0,drain:()=>{}};
    this.active.set(id,scope);
    try{return await work();}
    finally {
      scope.closing=true;
      if(scope.pending)await new Promise(resolve=>{scope.drain=resolve;});
      this.active.delete(id);
    }
  }
  async use(id,work) {
    validateReadScope(id);
    const scope=this.active.get(id);
    if(!scope||scope.closing)throw this.unavailable();
    scope.pending++;
    try{return await work(scope.client);}
    finally {if(!--scope.pending&&scope.closing)scope.drain();}
  }
}
module.exports={ReadScopes,validateReadScope,readCallbackUrl};

// Permission locks can meet a preceding writer; retry only PostgreSQL snapshot conflicts after rollback.
async function retryReadSnapshot(work) {
  const deadline=performance.now()+5000;
  for(;;){try{return await work();}catch(error){if(error?.code!=='40001'||performance.now()>=deadline)throw error;}}
}
module.exports.retryReadSnapshot=retryReadSnapshot;
