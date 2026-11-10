const {validateEvent}=require('./index.cjs');
const {setTimeout:delay}=require('node:timers/promises');
const FAQ_CATEGORIES=['접수','수거 일정','물품·박스','포장·파손','배송·운송장','주소','변경·취소','요금·결제','이용 안내','기타'];
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const keys=(value,names)=>object(value)&&Object.keys(value).sort().join(',')===names;
const id=value=>Number.isInteger(value)&&value>0&&value<=2147483647;
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const text=(value,max)=>typeof value==='string'&&!value.includes('\u0000')&&/\S/u.test(value)&&[...value].length<=max;
function validateFaqConversionPayload(value) {
  if(!keys(value,'adminId,faq,requestId,transactionId')||!id(value.adminId)||!uuid(value.requestId)||!uuid(value.transactionId)||
    !keys(value.faq,'answer,category,question')||!FAQ_CATEGORIES.includes(value.faq.category)||!text(value.faq.question,1000)||!text(value.faq.answer,20000))throw new Error('Invalid FAQ conversion');
}
function validateFaqConversionEvent(value) {
  validateEvent(value);
  if(value.source!=='consultation'||value.eventType!=='FaqConversionPrepared')throw new Error('Invalid FAQ conversion event');
  validateFaqConversionPayload(value.payload);
}
class FaqWritePending extends Error { constructor(){super('FAQ conversion pending');} }
class FaqConversionConflict extends Error { constructor(){super('Duplicate FAQ question');this.code='23505';} }
async function requestFaqConversion(url,token,payload) {
  const event={eventId:payload.eventId,source:'consultation',eventType:'FaqConversionPrepared',payload:payload.input};
  validateFaqConversionEvent(event);
  // Match PostgreSQL text parameters before JSONB transport encounters lone UTF-16 surrogates.
  event.payload={...event.payload,faq:{...event.payload.faq,
    question:Buffer.from(event.payload.faq.question,'utf8').toString('utf8'),
    answer:Buffer.from(event.payload.faq.answer,'utf8').toString('utf8')}};
  const endpoint=new URL(url);
  if(!['http:','https:'].includes(endpoint.protocol)||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||
    typeof token!=='string'||!/^[\x21-\x7e]{32,256}$/.test(token))throw new Error('Invalid FAQ conversion destination');
  const response=await fetch(endpoint.href,{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),
    headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(event)});
  if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')||'')){await response.body?.cancel();throw new Error('FAQ preparation unavailable');}
  const chunks=[];let size=0;
  for await(const chunk of response.body||[]){size+=chunk.length;if(size>4096)throw new Error('Invalid FAQ preparation reply');chunks.push(chunk);}
  const reply=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(response.status===409&&keys(reply,'error')){
    if(reply.error==='FAQ_WRITE_PENDING')throw new FaqWritePending();
    if(keys(reply.error,'code,details,message')&&reply.error.code==='DUPLICATE_RESOURCE'&&
       typeof reply.error.message==='string'&&Array.isArray(reply.error.details)&&!reply.error.details.length)throw new FaqConversionConflict();
  }
  if(response.status!==200||!keys(reply,'eventId,payload,status')||reply.eventId!==event.eventId||reply.status!=='processed'||
    !keys(reply.payload,'faqEntrySeq')||!id(reply.payload.faqEntrySeq))throw new Error('Invalid FAQ preparation reply');
  return reply.payload.faqEntrySeq;
}
async function retryFaqWrite(work) {
  const deadline=Date.now()+5000;
  for(;;){
    try{return await work();}
    catch(error){if(!(error instanceof FaqWritePending)||Date.now()>=deadline)throw error;}
    // Retry after the caller has rolled back and returned its DB connection.
    await delay(20);
  }
}
module.exports={FAQ_CATEGORIES,validateFaqConversionPayload,validateFaqConversionEvent,FaqWritePending,FaqConversionConflict,retryFaqWrite,requestFaqConversion};
