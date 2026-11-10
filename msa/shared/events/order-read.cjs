'use strict';
const { validateEvent } = require('./index.cjs');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => Number.isInteger(value) && value > 0 && value <= 2147483647;
const keys = (value, expected) => object(value) && Object.keys(value).sort().join(',') === expected;
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

function validateOrderRead(event, source) {
  validateEvent(event);
  const payload = event.payload, command = payload.command;
  if (event.source !== source || event.eventType !== 'OrderReadRequested' ||
      !keys(payload, source === 'order' ? 'command' : source === 'consultation' ? 'caller,command' : 'command,customerSeq') ||
      !keys(command, 'callSessionSeq,id,operation,query') || !object(command.query) ||
      !['OrdersListed', 'OrderDetailRead', 'OrderAddressesListed'].includes(command.operation) ||
      !(command.callSessionSeq === null || id(command.callSessionSeq)) ||
      (command.operation === 'OrdersListed' ? command.id !== null : !id(command.id)) ||
      (command.callSessionSeq === null && command.operation !== 'OrderAddressesListed'))
    throw new Error('Invalid order read command');
  if (source === 'consultation') {
    const caller = payload.caller;
    if (command.callSessionSeq === null || !keys(caller, 'endedAt,orderSeq,phone') ||
        !(caller.phone === null || typeof caller.phone === 'string' && /^[0-9]+$/.test(caller.phone)) ||
        !(caller.endedAt === null || date(caller.endedAt)) || !(caller.orderSeq === null || id(caller.orderSeq)))
      throw new Error('Invalid order call scope');
  }
  if (source === 'customer' && !id(payload.customerSeq)) throw new Error('Invalid order customer scope');
}

class OrderReadError extends Error {
  constructor(status, error) { super('Order read rejected'); this.status = status; this.error = error; }
}

const nullable = (value, check) => value === null || check(value);
const text = value => typeof value === 'string';
const instant = value => text(value) && Number.isFinite(Date.parse(value));
const ORDER_STATUSES = ['COLLECTING','notPaid','PAID','SUBMITTING','SUBMITTING_FAILED','ACCEPTED','SUBMISSION_FAILED','CANCELLED'];
const amount = value => Number.isSafeInteger(value) && value >= 0;
const addressKeys = 'detailAddress,dongName,jibunAddress,name,phoneNumber,postalCode,roadAddress';
const address = value => keys(value,addressKeys) && Object.values(value).every(field=>nullable(field,text));
const summaryKeys = 'createdAt,creationSource,customerSeq,orderSeq,paidAt,parcelCount,paymentDueAt,paymentMethodType,pickupRequestedAt,status,totalAmount';
const header = value => id(value.orderSeq) && nullable(value.customerSeq,id) &&
  ORDER_STATUSES.includes(value.status) &&
  ['AI','ADMIN','UNKNOWN'].includes(value.creationSource) && nullable(value.totalAmount,amount) &&
  nullable(value.paymentMethodType,method=>['cat','billing','credit','groupBilling'].includes(method)) &&
  ['createdAt','paidAt','paymentDueAt','pickupRequestedAt'].every(key=>key==='createdAt'?instant(value[key]):nullable(value[key],instant));
const parcel = (value, orderId) => keys(value,'bigBoxCount,clientComment,destination,documentCount,itemPrice,mediumBoxCount,notifiedPrice,orderParcelSeq,orderSeq,origin,originPin,otherItemDescription,parcelPosition,smallBoxCount,status') &&
  id(value.orderParcelSeq) && value.orderSeq===orderId && id(value.parcelPosition) && ['ACTIVE','CANCELLED'].includes(value.status) &&
  address(value.origin) && address(value.destination) && text(value.clientComment) && text(value.otherItemDescription) &&
  ['documentCount','smallBoxCount','mediumBoxCount','bigBoxCount'].every(key=>amount(value[key])) &&
  nullable(value.itemPrice,amount) && nullable(value.notifiedPrice,id) && nullable(value.originPin,pin=>
    keys(pin,'pinSeq,scope') && id(pin.pinSeq) && ['PERSONAL','COMPANY'].includes(pin.scope));
function detail(value, orderId) {
  return keys(value,'billingDepartmentName,billingDepartmentSeq,billingOrganizationName,billingOrganizationSeq,createdAt,creationSource,customerSeq,dverReceivedAt,orderSeq,paidAt,parcelNo,parcels,paymentDueAt,paymentMethodType,paymentRequest,pickupRequestedAt,status,totalAmount,updatedAt,version') &&
    value.orderSeq===orderId && header(value) && id(value.version) && instant(value.updatedAt) &&
    nullable(value.parcelNo,text) && nullable(value.dverReceivedAt,instant) &&
    ['billingOrganizationSeq','billingDepartmentSeq'].every(key=>nullable(value[key],id)) &&
    ['billingOrganizationName','billingDepartmentName'].every(key=>nullable(value[key],text)) &&
    Array.isArray(value.parcels) && value.parcels.every(row=>parcel(row,orderId)) &&
    nullable(value.paymentRequest,request=>keys(request,'amount,expiresAt,notificationStatus,paymentRequestId') && id(request.amount) &&
      instant(request.expiresAt) && text(request.paymentRequestId) && /^[0-9a-f-]{36}$/i.test(request.paymentRequestId) &&
      ['PENDING','SENDING','SENT','FAILED','UNKNOWN'].includes(request.notificationStatus));
}

function validateAdminOrderRead(event, source) {
  validateEvent(event);
  require('./read-scope.cjs').validateReadScope(event.eventId);
  const p=event.payload,q=p.query;
  const fields=source==='order'?'orderAddress,query':source==='consultation'?'consultationAddress,orderAddress,query':'consultationAddress,customerAddress,orderAddress,query';
  if(!['order','consultation','customer'].includes(source)||event.source!==source||event.eventType!=='AdminOrdersReadRequested'||!keys(p,fields)||
     !object(q)||!Object.keys(q).every(k=>['limit','offset','q','from','to','organizationSeq','statusGroup'].includes(k))||
     !Number.isInteger(q.limit)||q.limit<1||q.limit>100||!amount(q.offset)||
     q.organizationSeq!==undefined&&!id(q.organizationSeq)||
     q.statusGroup!==undefined&&!['COLLECTING','notPaid','PAID','SUBMISSION_FAILED','CANCELLED'].includes(q.statusGroup)||
     q.q!==undefined&&(!text(q.q)||q.q.includes('\0')||[...q.q].length>200)||
     ['from','to'].some(k=>q[k]!==undefined&&!text(q[k]))||
     ['orderAddress',...(source==='order'?[]:['consultationAddress']),...(source==='customer'?['customerAddress']:[])].some(k=>p[k]!==null&&!require('./call-event-reference.cjs').privateAddress(p[k])))
    throw new Error('Invalid administrator order read');
}
const adminParty=value=>keys(value,'detailAddress,jibunAddress,name,phoneNumber,roadAddress')&&Object.values(value).every(field=>nullable(field,text));
function adminPage(value,limit) {
  return keys(value,'data,hasNext,statusCounts,total_count')&&Array.isArray(value.data)&&value.data.length<=limit&&
    typeof value.hasNext==='boolean'&&amount(value.total_count)&&keys(value.statusCounts,'all,cancelled,incomplete,notPaid,paid,submissionFailed')&&Object.values(value.statusCounts).every(amount)&&
    value.data.every(row=>keys(row,'createdAt,customerSeq,draftSeq,orderSeq,organizationName,parcels,pickupRequestedAt,status')&&id(row.orderSeq)&&nullable(row.customerSeq,id)&&nullable(row.draftSeq,id)&&nullable(row.organizationName,text)&&instant(row.createdAt)&&nullable(row.pickupRequestedAt,instant)&&ORDER_STATUSES.includes(row.status)&&
      Array.isArray(row.parcels)&&row.parcels.every(p=>keys(p,'bigBoxCount,destination,documentCount,mediumBoxCount,orderParcelSeq,origin,otherItemDescription,smallBoxCount,status')&&nullable(p.orderParcelSeq,id)&&['ACTIVE','CANCELLED'].includes(p.status)&&adminParty(p.origin)&&adminParty(p.destination)&&text(p.otherItemDescription)&&['documentCount','smallBoxCount','mediumBoxCount','bigBoxCount'].every(k=>amount(p[k]))));
}
async function requestOrderRead(url,token,event){return requestRead(url,token,event,'order');}
async function requestAdminOrderRead(url,token,event){validateAdminOrderRead(event,event.source);return requestRead(url,token,event,'admin');}
async function requestDraftRead(url,token,event){require('./parcel-drafts.cjs').validateDraftRead(event,event.source);return requestRead(url,token,event,'draft');}
async function requestRead(url, token, event, mode) {
  const admin=mode==='admin';
  if (typeof token !== 'string' || !/^[\x21-\x7e]{32,256}$/.test(token)) throw new Error('Invalid read credentials');
  const endpoint = new URL(url);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    throw new Error('Invalid read endpoint');
  const response = await fetch(endpoint, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(mode!=='order' ? 30000 : event.source === 'order' ? 15000 : event.source === 'consultation' ? 10000 : 5000),
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(event),
  });
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel(); throw new Error('Invalid read response type');
  }
  const parts = [];
  try {
    for await (const part of response.body ?? []) {
      // The monolith returns every stored parcel; do not add a new response-size restriction.
      parts.push(part);
    }
  } finally { await response.body?.cancel(); }
  const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)));
  if (response.status !== 200) {
    const error = result?.error;
    if ([400, 403, 404, 409, 500, 503].includes(response.status) && keys(error, 'code,details,message') &&
        ['INVALID_REQUEST', 'FORBIDDEN', 'NOT_FOUND', 'INVALID_STATE', 'INTERNAL_ERROR', 'DEPENDENCY_UNAVAILABLE'].includes(error.code) &&
        typeof error.message === 'string' && Array.isArray(error.details) && error.details.every(detail =>
          keys(detail, 'field,reason') && typeof detail.field === 'string' && typeof detail.reason === 'string'))
      throw new OrderReadError(response.status, error);
    throw new Error('Invalid read failure');
  }
  if (!keys(result, 'eventId,payload,status') || result.eventId !== event.eventId || result.status !== 'processed')
    throw new Error('Invalid read acknowledgement');
  const value = result.payload;
  if(mode==='draft'){require('./parcel-drafts.cjs').validateDraftReadResult(value,event.payload.command);return value;}
  if (admin ? !adminPage(value,event.payload.query.limit) : event.payload.command.operation === 'OrderDetailRead'
    ? !detail(value,event.payload.command.id)
    : !keys(value, 'data,hasNext,total_count') || !Array.isArray(value.data) || value.data.length > 100 ||
      value.data.some(row => event.payload.command.operation === 'OrdersListed'
        ? !keys(row,summaryKeys) || !header(row) || !amount(row.parcelCount)
        : !keys(row,'address,createdAt,orderParcelSeq,orderSeq') || !id(row.orderSeq) || !id(row.orderParcelSeq) || !instant(row.createdAt) || !address(row.address)) ||
      typeof value.hasNext !== 'boolean' ||
      !Number.isSafeInteger(value.total_count) || value.total_count < 0)
    throw new Error('Invalid order read result');
  return value;
}
module.exports = { validateOrderRead, requestOrderRead, OrderReadError, ORDER_STATUSES, validateAdminOrderRead, requestAdminOrderRead, requestDraftRead };
