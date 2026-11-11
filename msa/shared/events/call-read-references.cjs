const {randomUUID}=require('node:crypto');
const {validateEvent}=require('./index.cjs');
const {requestPacket}=require('./call-event-reference.cjs');
const {ORDER_STATUSES}=require('./order-read.cjs');
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const keys=(value,expected)=>object(value)&&Object.keys(value).sort().join(',')===expected;
const id=value=>Number.isInteger(value)&&value>0&&value<=2147483647;
const nullable=(value,check)=>value===null||check(value);
const text=value=>typeof value==='string'&&!value.includes('\u0000');
function validateReferenceQuery(value,source='consultation') {
  validateEvent(value);
  const ids=value.payload.ids;
  if(!['consultation','order'].includes(source)||value.source!==source||value.eventType!=='CallReadReferencesRequested'||
     !keys(value.payload,'ids')||!Array.isArray(ids)||ids.length<1||ids.length>250||
     !ids.every(id)||new Set(ids).size!==ids.length)throw new Error('Invalid call reference query');
}
const shapes={
  order:row=>keys(row,'customer_seq,order_seq,status,total_amount')&&id(row.order_seq)&&nullable(row.customer_seq,id)&&
    ORDER_STATUSES.includes(row.status)&&nullable(row.total_amount,value=>Number.isInteger(value)&&value>=0&&value<=2147483647),
  customer:row=>keys(row,'customer_seq,name,organization_name,organization_seq')&&id(row.customer_seq)&&text(row.name)&&
    nullable(row.organization_seq,id)&&nullable(row.organization_name,text)&&
    (row.organization_seq===null)===(row.organization_name===null),
  persona:row=>keys(row,'ai_persona_version_seq,name,version')&&id(row.ai_persona_version_seq)&&text(row.name)&&id(row.version),
  faq:row=>keys(row,'faq_entry_seq')&&id(row.faq_entry_seq),
};
const primaryKey={order:'order_seq',customer:'customer_seq',persona:'ai_persona_version_seq',faq:'faq_entry_seq'};
function validateReferenceRows(kind,value,ids) {
  if(!Object.hasOwn(shapes,kind)||!Array.isArray(value)||value.length>ids.length||
     !value.every(row=>shapes[kind](row)&&ids.includes(row[primaryKey[kind]]))||
     new Set(value.map(row=>row[primaryKey[kind]])).size!==value.length)throw new Error('Invalid call reference rows');
}
async function requestReferences(kind,url,token,ids,source='consultation',readScopeId) {
  if(!Object.hasOwn(shapes,kind)||(source==='order'&&kind!=='customer'))throw new Error('Invalid call reference owner');
  if(readScopeId!==undefined&&source!=='order')throw new Error('Invalid reference read scope');
  const event={eventId:randomUUID(),source,eventType:'CallReadReferencesRequested',payload:{ids:[...new Set(ids)].sort((a,b)=>a-b)}};
  validateReferenceQuery(event,source);
  const endpoint=new URL(url);
  if(!['http:','https:'].includes(endpoint.protocol)||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||
     typeof token!=='string'||!/^[\x21-\x7e]{32,256}$/.test(token))throw new Error('Invalid call reference destination');
  // Source names are text without a DB length bound; preserve complete legacy lookup values.
  const rows=await requestPacket(endpoint.href,token,event,AbortSignal.timeout(5000),null,readScopeId);
  validateReferenceRows(kind,rows,event.payload.ids);
  return rows;
}
function validatePersonaComparisonQuery(value) {
  validateEvent(value);
  if(value.source!=='consultation'||value.eventType!=='DashboardPersonaComparisonRequested'||!keys(value.payload,''))throw new Error('Invalid persona comparison query');
}
function validatePersonaComparisonRows(value) {
  if(!Array.isArray(value)||value.length>2||!value.every(row=>
    keys(row,'ai_persona_seq,ai_persona_version_seq,name,previous_active_version_seq,status,version')&&
    id(row.ai_persona_seq)&&id(row.ai_persona_version_seq)&&text(row.name)&&id(row.version)&&
    nullable(row.previous_active_version_seq,id)&&row.previous_active_version_seq!==row.ai_persona_version_seq&&
    ['ACTIVE','PENDING','INACTIVE'].includes(row.status))||
    new Set(value.map(row=>row.ai_persona_version_seq)).size!==value.length)throw new Error('Invalid persona comparison rows');
  const active=value.filter(row=>row.status==='ACTIVE');
  if(value.length&&active.length!==1)throw new Error('Invalid active persona');
  if(value.some(row=>row.status!=='ACTIVE'&&row.ai_persona_version_seq!==active[0]?.previous_active_version_seq))throw new Error('Unexpected comparison persona');
  if(active[0]?.previous_active_version_seq!=null&&!value.some(row=>row.ai_persona_version_seq===active[0].previous_active_version_seq))throw new Error('Missing previous persona');
}
async function requestPersonaComparison(url,token) {
  return requestSnapshot(url,token,'DashboardPersonaComparisonRequested',validatePersonaComparisonRows);
}
function validateComplaintFaqQuery(value) {
  validateEvent(value);
  if(value.source!=='consultation'||value.eventType!=='ComplaintFaqSnapshotRequested'||!keys(value.payload,''))throw new Error('Invalid complaint FAQ query');
}
function validateComplaintFaqRows(rows) {
  if(!Array.isArray(rows)||!rows.every(row=>keys(row,'answer,question')&&text(row.question)&&text(row.answer)))throw new Error('Invalid complaint FAQ snapshot');
}
async function requestComplaintFaqs(url,token) {
  return requestSnapshot(url,token,'ComplaintFaqSnapshotRequested',validateComplaintFaqRows);
}
function validateOrderOrganizationQuery(value) {
  validateEvent(value);
  if(value.source!=='order'||value.eventType!=='OrderOrganizationReadRequested'||!keys(value.payload,'organizationSeq')||!id(value.payload.organizationSeq))throw new Error('Invalid order organization query');
}
function validateOrderOrganizationRows(value,organizationSeq) {
  if(!keys(value,'customer_seqs,organization_name,organization_seq')||value.organization_seq!==organizationSeq||!nullable(value.organization_name,text)||
     !Array.isArray(value.customer_seqs)||!value.customer_seqs.every(id)||new Set(value.customer_seqs).size!==value.customer_seqs.length||
     value.organization_name===null&&value.customer_seqs.length)throw new Error('Invalid order organization result');
}
async function requestOrderOrganization(url,token,organizationSeq,readScopeId) {
  const payload={organizationSeq};
  validateOrderOrganizationQuery({eventId:randomUUID(),source:'order',eventType:'OrderOrganizationReadRequested',payload});
  return requestSnapshot(url,token,'OrderOrganizationReadRequested',rows=>validateOrderOrganizationRows(rows,organizationSeq),'order',payload,readScopeId);
}
async function requestSnapshot(url,token,eventType,validate,source='consultation',payload={},readScopeId) {
  const endpoint=new URL(url);
  if(!['http:','https:'].includes(endpoint.protocol)||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||
     typeof token!=='string'||!/^[\x21-\x7e]{32,256}$/.test(token))throw new Error('Invalid persona comparison destination');
  const event={eventId:randomUUID(),source,eventType,payload};
  const rows=await requestPacket(endpoint.href,token,event,AbortSignal.timeout(5000),null,readScopeId);
  validate(rows);
  return rows;
}
function validateHomeOrdersQuery(event) {
  validateEvent(event);
  const p=event.payload;
  if(event.source!=='consultation'||event.eventType!=='HomeOrdersReadRequested'||
     !keys(p,'consultationAddress,observedAt')||typeof p.observedAt!=='string'||
     !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(p.observedAt)||!Number.isFinite(Date.parse(p.observedAt))||
     !(p.consultationAddress===null||require('./call-event-reference.cjs').privateAddress(p.consultationAddress)))
    throw new Error('Invalid home orders query');
}
function validateHomeOrdersResult(value) {
  if(!keys(value,'drafts,notPaid,submissionFailed,todayOrderCount')||
     !['notPaid','submissionFailed','todayOrderCount'].every(key=>Number.isSafeInteger(value[key])&&value[key]>=0))
    throw new Error('Invalid home orders counts');
  require('./parcel-drafts.cjs').validateDraftReadResult(value.drafts,{
    operation:'ParcelDraftsListed',id:null,callSessionSeq:null,query:{limit:11},
  });
}
function requestHomeOrders(url,token,observedAt,consultationAddress,readScopeId) {
  require('./read-scope.cjs').validateReadScope(readScopeId);
  return requestSnapshot(url,token,'HomeOrdersReadRequested',validateHomeOrdersResult,'consultation',
    {observedAt,consultationAddress},readScopeId);
}
module.exports={validateReferenceQuery,validateReferenceRows,requestReferences,validatePersonaComparisonQuery,validatePersonaComparisonRows,requestPersonaComparison,validateComplaintFaqQuery,validateComplaintFaqRows,requestComplaintFaqs,validateOrderOrganizationQuery,validateOrderOrganizationRows,requestOrderOrganization,validateHomeOrdersQuery,validateHomeOrdersResult,requestHomeOrders};
