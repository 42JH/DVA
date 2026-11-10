const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const keys=(value,expected)=>object(value)&&Object.keys(value).sort().join(',')===expected;
const id=value=>Number.isInteger(value)&&value>0&&value<=2147483647;
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const text=value=>typeof value==='string'&&!value.includes('\u0000')&&value.replace(/^ +| +$/g,'').length>0&&Array.from(value).length<=20000;
function validateFaqExamples(value) {
  if(!keys(value,'questions,results,transactionId')||!uuid(value.transactionId)||
     !Array.isArray(value.questions)||value.questions.length<1||value.questions.length>50||
     !value.questions.every(q=>keys(q,'text,utteranceOrder')&&id(q.utteranceOrder)&&text(q.text))||
     new Set(value.questions.map(q=>q.utteranceOrder)).size!==value.questions.length||
     !Array.isArray(value.results)||value.results.length<1||value.results.length>50||
     !value.results.every(r=>keys(r,'eventId,faqEntrySeqs,occurredAt,questionUtteranceOrder')&&uuid(r.eventId)&&
       typeof r.occurredAt==='string'&&Number.isFinite(Date.parse(r.occurredAt))&&id(r.questionUtteranceOrder)&&
       value.questions.some(q=>q.utteranceOrder===r.questionUtteranceOrder)&&
       Array.isArray(r.faqEntrySeqs)&&r.faqEntrySeqs.length>0&&r.faqEntrySeqs.length<=100&&
       r.faqEntrySeqs.every(id)&&new Set(r.faqEntrySeqs).size===r.faqEntrySeqs.length)||
     new Set(value.results.map(r=>r.eventId.toLowerCase())).size!==value.results.length)
    throw new Error('Invalid FAQ question examples');
}
function validateFaqChunks(value) {
  if(!keys(value,'chunkEventIds,transactionId')||!uuid(value.transactionId)||
     !Array.isArray(value.chunkEventIds)||value.chunkEventIds.length<1||value.chunkEventIds.length>50||
     !value.chunkEventIds.every(uuid)||new Set(value.chunkEventIds.map(id=>id.toLowerCase())).size!==value.chunkEventIds.length)
    throw new Error('Invalid FAQ question example chunks');
}
function splitFaqExamples(value) {
  validateFaqExamples(value);
  const questions=new Map(value.questions.map(q=>[q.utteranceOrder,q])),chunks=[];
  const empty=()=>({transactionId:value.transactionId,questions:[],results:[]});
  let current=empty();
  for(const result of value.results) {
    const append=()=>({transactionId:value.transactionId,
      questions:current.questions.some(q=>q.utteranceOrder===result.questionUtteranceOrder)?current.questions:[...current.questions,questions.get(result.questionUtteranceOrder)],
      results:[...current.results,result]});
    let next=append();
    if(Buffer.byteLength(JSON.stringify(next))>512*1024&&current.results.length) {
      chunks.push(current);current=empty();next=append();
    }
    if(Buffer.byteLength(JSON.stringify(next))>512*1024)throw new Error('FAQ question example exceeds transport bound');
    current=next;
  }
  chunks.push(current);
  return chunks;
}
function assembleFaqExamples(chunks,transactionId) {
  if(!Array.isArray(chunks)||chunks.length<1||chunks.length>50)throw new Error('Invalid FAQ example chunks');
  const questions=new Map(),results=[];
  for(const chunk of chunks) {
    validateFaqExamples(chunk);
    if(chunk.transactionId!==transactionId||results.length+chunk.results.length>50)throw new Error('Invalid FAQ example transaction');
    for(const question of chunk.questions) {
      if(questions.has(question.utteranceOrder)&&questions.get(question.utteranceOrder).text!==question.text)throw new Error('Conflicting FAQ question snapshot');
      questions.set(question.utteranceOrder,question);
    }
    results.push(...chunk.results);
  }
  const value={transactionId,questions:[...questions.values()],results};
  validateFaqExamples(value);
  return value;
}
module.exports={validateFaqExamples,validateFaqChunks,splitFaqExamples,assembleFaqExamples};
