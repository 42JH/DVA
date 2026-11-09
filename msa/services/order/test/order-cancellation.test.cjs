const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {createServer}=require('node:http');
const {validateOrderCancellation,requestOrderCancellation,OrderCancellationError}=require('@dva/events/order-cancellation.cjs');
const event=()=>({eventId:randomUUID(),source:'order',eventType:'OrderCancellationRequested',payload:{command:{id:1,callSessionSeq:2,requestId:'test',orderParcelSeqs:[3]}}});
let server,url,mode;
const token='cancellation-test-only-'.padEnd(40,'x');
before(async()=> {
  server=createServer(async(req,res)=>{
    const parts=[];for await(const part of req)parts.push(part);const input=JSON.parse(Buffer.concat(parts));
    assert.equal(req.headers.authorization,'Bearer '+token);
    if(mode==='lost'){req.socket.destroy();return;}
    if(mode==='redirect'){res.writeHead(307,{Location:'/wrong'}).end();return;}
    res.setHeader('Content-Type',mode==='html'?'text/html':'application/json');
    if(mode==='domain'){res.writeHead(409).end(JSON.stringify({error:{code:'INVALID_STATE',message:'이미 취소된 주문입니다.',details:[]}}));return;}
    if(mode==='oversized'){res.end(' '.repeat(4097));return;}
    res.end(mode==='json'?'{' : mode==='utf8'?Buffer.from([255]) : JSON.stringify({eventId:mode==='id'?randomUUID():input.eventId,status:mode==='status'?'received':'processed',payload:mode==='payload'?{}:null}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));url='http://127.0.0.1:'+server.address().port+'/internal/order-cancellation';
});
after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
test('only the fixed cancellation command and owner scope are accepted',()=>{
  const valid=event();validateOrderCancellation(valid,'order');
  assert.throws(()=>validateOrderCancellation({...valid,source:'delivery',payload:{...valid.payload,customerSeq:1}},'delivery'));
  for(const mutate of [e=>e.source='customer',e=>e.eventType='OrderReadRequested',e=>e.payload.adminId=1,
    e=>e.payload.command.id=0,e=>e.payload.command.callSessionSeq=null,e=>e.payload.command.orderParcelSeqs=[],
    e=>e.payload.command.orderParcelSeqs=[1,1],e=>e.payload.command.orderParcelSeqs=['1'],e=>e.payload.command.requestId='',
    e=>e.payload.command.actorId=1]){const bad=structuredClone(valid);mutate(bad);assert.throws(()=>validateOrderCancellation(bad,'order'));}
  const next={...valid,source:'consultation',payload:{...valid.payload,caller:{phone:'01012345678',endedAt:null,orderSeq:null}}};
  validateOrderCancellation(next,'consultation');
  assert.throws(()=>validateOrderCancellation({...next,payload:{...next.payload,caller:{...next.payload.caller,phone:'010-1234'}}},'consultation'));
  validateOrderCancellation({...valid,source:'customer',payload:{...valid.payload,customerSeq:7}},'customer');
  assert.throws(()=>validateOrderCancellation({...valid,source:'customer',payload:{...valid.payload,customerSeq:null}},'customer'));
});
test('only matching null ACKs succeed and structured source errors are preserved',async()=>{
  mode='valid';assert.equal(await requestOrderCancellation(url,token,event()),null);
  for(mode of ['lost','redirect','html','json','utf8','id','status','payload','oversized'])await assert.rejects(requestOrderCancellation(url,token,event()));
  mode='domain';await assert.rejects(requestOrderCancellation(url,token,event()),e=>e instanceof OrderCancellationError&&e.status===409&&e.error.message==='이미 취소된 주문입니다.');
});
