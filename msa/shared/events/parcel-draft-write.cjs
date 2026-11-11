'use strict';
const {validateCustomerPreparationOutcome,validateCreatedCustomer,validateCustomerCreationReceipt}=require('./order-customer-write.cjs');
const { validateCompletion,validateFinalization,validatePolicy } = require('./order-intake-write.cjs');
const { validateEvent } = require('./index.cjs');
const { privateAddress } = require('./call-event-reference.cjs');
const { validateReadScope } = require('./read-scope.cjs');
const {validateRecipientAddresses,validateRecipientPins,validateRecipientReceipt}=require('./order-recipient-pins.cjs');
const { validateDraftReadResult } = require('./parcel-drafts.cjs');
const { OrderReadError,orderIntakeResult } = require('./order-read.cjs');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => object(value) && Object.keys(value).sort().join(',') === expected;
const id = value => Number.isInteger(value) && value > 0 && value <= 2147483647;
const nullableId = value => value === null || id(value);
const address = value => value === null || privateAddress(value);
const instant = value => value === null || typeof value === 'string' && Number.isFinite(Date.parse(value));
const creationKey = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
function validateCallIdentity(value) {
  if(!keys(value,'callerPhoneNumber,incomingAt,providerCallId') || typeof value.providerCallId!=='string' || value.providerCallId.length>200 || !/^[^\s\u0000]+$/.test(value.providerCallId) || typeof value.callerPhoneNumber!=='string' || !/^\+?[0-9]{3,20}$/.test(value.callerPhoneNumber) || typeof value.incomingAt!=='string' || !Number.isFinite(Date.parse(value.incomingAt)))throw new Error('Invalid order call identity');
}

function validateWriteCall(value) {
  if (value !== null && (
    !keys(value,'callSessionSeq,callerPhoneNumber,completionReceivedAt,customerSeq,enabled,endedAt,intakeVersion,orderSeq') ||
    !id(value.callSessionSeq) || !nullableId(value.customerSeq) || !nullableId(value.orderSeq) ||
    !(value.callerPhoneNumber === null || typeof value.callerPhoneNumber === 'string') ||
    !id(value.intakeVersion) || typeof value.enabled !== 'boolean' ||
    !instant(value.endedAt) || !instant(value.completionReceivedAt)
  )) throw new Error('Invalid draft call');
}

function validateDraftWrite(event, source) {
  validateEvent(event);
  validateReadScope(event.eventId);
  const p = event.payload, c = p.command;
  const fields = ['command','orderAddress', ...(source === 'order' ? [] : ['call','consultationAddress']),
    ...(source === 'customer' ? ['customerAddress'] : [])].sort().join(',');
  if (!['order','consultation','customer'].includes(source) || event.source !== source ||
      event.eventType !== 'ParcelDraftWriteRequested' || !keys(p, fields) ||
      !keys(c,c.operation==='OrderCreated'?'adminId,callSessionSeq,id,input,key,operation,requestId':'adminId,callSessionSeq,id,input,operation,requestId') ||
      !['OrderCreated','ParcelDraftCreated','ParcelDraftUpdated','OrderIntakeSealed','OrderIntakeFinalized','OrderUpdated','OrderSubmitted','AdminParcelDraftSubmitted'].includes(c.operation) ||
      !(['OrderCreated','ParcelDraftCreated'].includes(c.operation) ? c.id === null : id(c.id)) ||
      !nullableId(c.adminId) || !(c.operation==='OrderCreated' ? nullableId(c.callSessionSeq) && (c.adminId!==null || c.input?.call!==undefined || c.callSessionSeq!==null) : c.adminId === null ? id(c.callSessionSeq) : ['OrderUpdated','OrderSubmitted'].includes(c.operation) ? nullableId(c.callSessionSeq) : c.callSessionSeq === null) ||
      !object(c.input) || typeof c.requestId !== 'string' || c.requestId.length < 1 || c.requestId.length > 128 ||
      !address(p.orderAddress) || source !== 'order' && !address(p.consultationAddress) ||
      source === 'customer' && !address(p.customerAddress))
    throw new Error('Invalid draft write');
  if(c.operation==='OrderCreated' && !creationKey(c.key))throw new Error('Invalid creation request key');
  if(c.operation==='AdminParcelDraftSubmitted' && (c.adminId===null || c.callSessionSeq!==null))throw new Error('Invalid administrator draft submission');
  if (c.operation.startsWith('OrderIntake')) {
    if (c.adminId!==null || c.id!==c.callSessionSeq) throw new Error('Invalid intake scope');
    if(c.operation==='OrderIntakeSealed') validateCompletion(c.input);
    else if(!keys(c.input,'')) throw new Error('Invalid finalization input');
  }
  if (source !== 'order') {
    if (p.call !== null && (!keys(p.call,'callSessionSeq,customerSeq,intakeVersion') ||
        !id(p.call.callSessionSeq) || !nullableId(p.call.customerSeq) || !id(p.call.intakeVersion)))
      throw new Error('Invalid draft call snapshot');
    if ((p.call === null) !== (c.callSessionSeq === null) && !(p.call === null && (c.operation==='OrderCreated' || c.operation==='OrderSubmitted' && c.adminId!==null)) ||
        p.call !== null && p.call.callSessionSeq !== c.callSessionSeq) throw new Error('Draft call mismatch');
  }
}

function validateCallMutation(value) {
  if (!keys(value,'afterVersion,beforeVersion,callSessionSeq,customerSeq') ||
      !id(value.callSessionSeq) || !id(value.beforeVersion) || !id(value.afterVersion) ||
      ![value.beforeVersion, value.beforeVersion + 1].includes(value.afterVersion) ||
      !nullableId(value.customerSeq)) throw new Error('Invalid draft call mutation');
}

function validateOrderCallLink(value) {
  if(!keys(value,'beforeCustomerSeq,beforeOrderSeq,callSessionSeq,customerSeq,orderSeq') ||
    !id(value.callSessionSeq)||value.beforeOrderSeq!==null||!nullableId(value.beforeCustomerSeq)||!id(value.orderSeq)||!id(value.customerSeq)||value.beforeCustomerSeq!==null&&value.beforeCustomerSeq!==value.customerSeq)
    throw new Error('Invalid order call link');
}

function validateReceipt(value) {
  if (!keys(value,'eventId,payload')) throw new Error('Invalid draft call receipt');
  validateReadScope(value.eventId);
  if(object(value.payload)&&Object.hasOwn(value.payload,'creationKey')) validateLegacyCallWrite(value.payload);
  else if(object(value.payload)&&Object.hasOwn(value.payload,'beforeOrderSeq')) validateOrderCallLink(value.payload);
  else validateCallMutation(value.payload);
}

function validateLegacyCallWrite(value) {
  if(!keys(value,'adminId,beforeCustomerSeq,call,callSessionSeq,creationKey,customerSeq,orderSeq,requestId') || !id(value.callSessionSeq) || !nullableId(value.beforeCustomerSeq) || !nullableId(value.customerSeq) || !nullableId(value.orderSeq) || !nullableId(value.adminId) || !creationKey(value.creationKey) || typeof value.requestId!=='string' || value.requestId.length<1 || value.requestId.length>128 || value.beforeCustomerSeq!==null && value.customerSeq!==value.beforeCustomerSeq)throw new Error('Invalid legacy order call write');
  if(value.call!==null)validateCallIdentity(value.call);
}

function validateWriteResult(value, command, eventId) {
  if (!keys(value,command.operation==='OrderCreated'?'customerCreationReceipt,customerReceipt,data,receipt':['OrderSubmitted','AdminParcelDraftSubmitted'].includes(command.operation)?'customerReceipt,data,receipt':'data,receipt')) throw new Error('Invalid draft write result');
  if(command.operation==='OrderCreated') {
    if(!keys(value.data,'result,submit') || typeof value.data.submit!=='boolean')throw new Error('Invalid creation preparation');
    const result=value.data.result;
    if(keys(result,'orderSeq,version')) {
      if(!id(result.orderSeq)||!id(result.version)||value.data.submit||command.input.call!==undefined)throw new Error('Invalid created order');
    } else if(result?.status==='NO_ORDER') {
      if(!keys(result,'callSessionSeq,orderSeq,parcelNo,paymentDueAt,paymentRequest,status,totalAmount,version') || !id(result.callSessionSeq) || !['orderSeq','parcelNo','paymentDueAt','paymentRequest','totalAmount','version'].every(key=>result[key]===null)||value.data.submit)throw new Error('Invalid empty order result');
    } else if(!id(result?.orderSeq) || !nullableId(result.callSessionSeq) || !orderIntakeResult(result,{orderSeq:result.orderSeq,callSessionSeq:result.callSessionSeq}) || value.data.submit&&result.status!=='PAID')throw new Error('Invalid created order result');
    if(value.receipt!==null) {
      validateReceipt(value.receipt);validateLegacyCallWrite(value.receipt.payload);
      const p=value.receipt.payload;
      if(p.creationKey!==command.key || p.adminId!==command.adminId || p.requestId!==command.requestId || command.callSessionSeq!==null&&p.callSessionSeq!==command.callSessionSeq || p.orderSeq!==result.orderSeq)throw new Error('Creation call scope mismatch');
      if((p.call===null)!==(command.input.call===undefined) || p.call!==null && ['providerCallId','callerPhoneNumber','incomingAt'].some(key=>p.call[key]!==command.input.call[key]) || command.input.call===undefined && p.callSessionSeq!==command.callSessionSeq || Object.hasOwn(result,'callSessionSeq') && result.callSessionSeq!==p.callSessionSeq)throw new Error('Creation call identity mismatch');
    }
    if(value.customerCreationReceipt!==null) {
      validateCustomerCreationReceipt(value.customerCreationReceipt);
      const p=value.customerCreationReceipt.payload;
      if(p.writeEventId!==eventId || p.adminId!==command.adminId || p.requestId!==command.requestId || !command.input.customer || p.customer.phoneNumber!==command.input.customer.phoneNumber || p.customer.name!==command.input.customer.name)throw new Error('Created customer scope mismatch');
    }
    if(value.customerReceipt!==null) {
      validateRecipientReceipt(value.customerReceipt);
      const p=value.customerReceipt.payload;
      if(p.writeEventId!==eventId || p.orderSeq!==result.orderSeq || p.adminId!==command.adminId || p.requestId!==command.requestId)throw new Error('Creation recipient scope mismatch');
      if(value.customerCreationReceipt!==null && p.customerSeq!==value.customerCreationReceipt.payload.customer.customerSeq)throw new Error('Created customer recipient mismatch');
    }
    return;
  }
  if (command.operation.startsWith('OrderIntake')) {
    if(value.receipt!==null) throw new Error('Invalid intake receipt');
    if(command.operation==='OrderIntakeSealed') {
      if(!keys(value.data,'sealed') || value.data.sealed!==true) throw new Error('Invalid intake seal');
    } else {
      if(!keys(value.data,'finalization')) throw new Error('Invalid intake result');
      if(value.data.finalization!==null) {
        validateFinalization(value.data.finalization);
        if(value.data.finalization.callSessionSeq!==command.id) throw new Error('Intake result mismatch');
      }
    }
    return;
  }
  if(command.operation==='AdminParcelDraftSubmitted') {
    if(!keys(value.data,'callSessionSeq,draftSeq,orderParcelSeq,orderSeq,parcelNo,paymentDueAt,paymentRequest,status,totalAmount,version') || value.data.draftSeq!==command.id || !id(value.data.orderParcelSeq) || !id(value.data.orderSeq))throw new Error('Invalid administrator draft result');
    const {draftSeq,orderParcelSeq,...order}=value.data;
    if(!orderIntakeResult(order,{orderSeq:order.orderSeq,callSessionSeq:null}) || value.receipt!==null)throw new Error('Invalid administrator order result');
    if(value.customerReceipt!==null) {
      validateRecipientReceipt(value.customerReceipt);
      if(value.customerReceipt.payload.orderSeq!==order.orderSeq || value.customerReceipt.payload.writeEventId!==eventId || value.customerReceipt.payload.adminId!==command.adminId || value.customerReceipt.payload.requestId!==command.requestId)throw new Error('Administrator recipient mismatch');
    }
    return;
  }
  if(command.operation==='OrderSubmitted') {
    if(!keys(value.data,'status') || !['COLLECTING','notPaid','PAID','SUBMITTING','SUBMITTING_FAILED','ACCEPTED','SUBMISSION_FAILED','CANCELLED'].includes(value.data.status)) throw new Error('Invalid order submission result');
    if(value.receipt!==null) {validateReceipt(value.receipt);validateOrderCallLink(value.receipt.payload);
      if(value.receipt.payload.callSessionSeq!==command.callSessionSeq || value.receipt.payload.orderSeq!==command.id)throw new Error('Submission call mismatch');}
    if(value.customerReceipt!==null) {validateRecipientReceipt(value.customerReceipt);
      if(value.customerReceipt.payload.writeEventId!==eventId || value.customerReceipt.payload.orderSeq!==command.id || value.customerReceipt.payload.adminId!==command.adminId || value.customerReceipt.payload.requestId!==command.requestId)throw new Error('Submission recipient mismatch');}
    return;
  }
  if(command.operation==='OrderUpdated') {
    if(!keys(value.data,'version')||!id(value.data.version))throw new Error('Invalid order update result');
    if(value.receipt!==null) {
      validateReceipt(value.receipt);validateOrderCallLink(value.receipt.payload);
      if(value.receipt.payload.callSessionSeq!==command.callSessionSeq)throw new Error('Order call scope mismatch');
    }
    return;
  }
  validateDraftReadResult(value.data, { operation: 'ParcelDraftDetailRead', id: value.data?.draftSeq, query: {} });
  if (value.data.callSessionSeq !== command.callSessionSeq ||
      (command.callSessionSeq === null ? value.data.intakeVersion !== null : !id(value.data.intakeVersion)))
    throw new Error('Draft write scope mismatch');
  if (command.operation === 'ParcelDraftUpdated' && value.data.draftSeq !== command.id)
    throw new Error('Draft write result mismatch');
  if (value.receipt !== null) {
    validateReceipt(value.receipt);
    validateCallMutation(value.receipt.payload);
    if (value.receipt.payload.callSessionSeq !== command.callSessionSeq ||
        value.receipt.payload.afterVersion !== value.data.intakeVersion)
      throw new Error('Draft receipt mismatch');
  }
}

function validateWriteReference(event) {
  validateEvent(event);
  const p = event.payload;
  if (event.eventType !== 'ParcelDraftWriteReferenceRequested' ||
      !keys(p,'input,operation') || !object(p.input)) throw new Error('Invalid draft write reference');
  const v = p.input;
  let valid = false;
  switch (p.operation) {
    case 'CustomerOrderResolved':
      valid=event.source==='order' && (keys(v,'customerSeq')&&id(v.customerSeq) || keys(v,'customer')&&keys(v.customer,'name,phoneNumber')&&typeof v.customer.name==='string'&&v.customer.name.trim().length>0&&typeof v.customer.phoneNumber==='string'&&/^[0-9]{11}$/.test(v.customer.phoneNumber));
      break;
    case 'CustomerCreationApplied':
      valid=event.source==='order'&&keys(v,'writeEventId');
      if(valid)validateReadScope(v.writeEventId);
      break;
    case 'CallEnsured':
      valid=event.source==='order'&&keys(v,'call,customerSeq')&&nullableId(v.customerSeq);
      if(valid)validateCallIdentity(v.call);
      break;
    case 'LegacyCallApplied':
      valid=event.source==='order'&&keys(v,'receipt');
      if(valid){validateReceipt(v.receipt);validateLegacyCallWrite(v.receipt.payload);}
      break;
    case 'CallCreationChecked':
      valid=event.source==='order'&&keys(v,'id,orderSeq')&&id(v.id)&&id(v.orderSeq);
      break;
    case 'CustomerPreparationOutcomeRead':
      valid=event.source==='customer' && keys(v,'writeEventId');
      if(valid)validateReadScope(v.writeEventId);
      break;
    case 'RecipientPinsPrepared':
      valid=event.source==='order'&&keys(v,'customerSeq,id')&&id(v.id)&&id(v.customerSeq);
      break;
    case 'OrderRecipientsRead':
      valid=event.source==='customer'&&keys(v,'id')&&id(v.id);
      break;
    case 'RecipientReceiptRead':
      valid=event.source==='customer'&&keys(v,'eventId');
      if(valid) validateReadScope(v.eventId);
      break;
    case 'CustomerPaymentPolicyRead':
    case 'OrderCustomerRead':
    case 'CustomerRead':
      valid = event.source === 'order' && keys(v,'id') && id(v.id);
      break;
    case 'CallCustomerRead':
    case 'CustomerPhoneRead':
      valid = event.source === 'order' && keys(v,'phone') && typeof v.phone === 'string';
      break;
    case 'PinChecked':
      valid = event.source === 'order' && keys(v,'customerSeq,pinSeq') && id(v.customerSeq) && id(v.pinSeq);
      break;
    case 'IntakeCallRead':
    case 'CallRead':
    case 'CallBumped':
      valid = event.source === 'order' && keys(v,'id') && id(v.id);
      break;
    case 'CallOrderLinked':
      valid=event.source==='order'&&keys(v,'customerSeq,id,orderSeq')&&id(v.id)&&id(v.orderSeq)&&nullableId(v.customerSeq);
      break;
    case 'CallCustomerResolved':
      valid = event.source === 'order' && keys(v,'customerSeq,id') && id(v.id) && id(v.customerSeq);
      break;
    case 'IntakeCallSealed':
      valid=event.source==='order' && keys(v,'id,payload') && id(v.id);
      if(valid) validateCompletion(v.payload);
      break;
    case 'IntakeFinalizationRead':
    case 'PendingCallWritesRead':
      valid = event.source === 'consultation' && keys(v,'id') && id(v.id);
      break;
  }
  if (!valid) throw new Error('Invalid draft reference operation');
}

function validateReferenceResult(value, event) {
  const op = event.payload.operation, input = event.payload.input;
  if(op==='CustomerOrderResolved') {
    if(!keys(value,'created,customer') || !keys(value.customer,'active,customerSeq,phone') || !id(value.customer.customerSeq)||value.customer.active!==true||typeof value.customer.phone!=='string' || input.customerSeq!==undefined&&input.customerSeq!==value.customer.customerSeq || input.customer!==undefined&&input.customer.phoneNumber!==value.customer.phone)throw new Error('Invalid resolved order customer');
    if(value.created!==null){validateCreatedCustomer(value.created);if(value.created.customerSeq!==value.customer.customerSeq || value.created.phoneNumber!==value.customer.phone)throw new Error('Created customer mismatch');}
    return;
  }
  if(op==='CustomerCreationApplied'){if(value!==true)throw new Error('Customer creation recovery failed');return;}
  if(op==='CallEnsured'){if(!id(value))throw new Error('Invalid ensured call');return;}
  if(op==='LegacyCallApplied'||op==='CallCreationChecked'){if(typeof value!=='boolean')throw new Error('Invalid creation call check');return;}
  if(op==='CustomerPreparationOutcomeRead'){validateCustomerPreparationOutcome(value);if(value.status==='COMMITTED'&&value.customerCreationReceipt.payload.writeEventId!==input.writeEventId)throw new Error('Customer outcome scope mismatch');return;}
  if(op==='RecipientPinsPrepared'){validateRecipientPins(value);return;}
  if(op==='OrderRecipientsRead'){validateRecipientAddresses(value);return;}
  if(op==='RecipientReceiptRead'){validateRecipientReceipt(value);if(value.eventId!==input.eventId)throw new Error('Recipient receipt mismatch');return;}
  if (op==='CustomerPaymentPolicyRead') { validatePolicy(value); return; }
  if (op==='IntakeFinalizationRead') {
    if(value!==null) {validateFinalization(value); if(value.callSessionSeq!==input.id) throw new Error('Intake receipt mismatch');}
    return;
  }
  if (op==='IntakeCallRead' || op==='IntakeCallSealed') {
    if(value===null) return;
    if(!keys(value,'callSessionSeq,callerPhoneNumber,completionPayload,completionReceivedAt,customerSeq,enabled,endedAt,finalizedAt,intakeVersion,orderSeq') ||
      !(value.finalizedAt===null || instant(value.finalizedAt))) throw new Error('Invalid intake call');
    if(value.completionPayload!==null) validateCompletion(value.completionPayload);
    const {completionPayload,finalizedAt,...call}=value; validateWriteCall(call);
    if(call.callSessionSeq!==input.id) throw new Error('Intake call mismatch');
    return;
  }
  if (op === 'CallRead' || op === 'CallCustomerResolved' || op==='CallOrderLinked') {
    validateWriteCall(value);
    if (value !== null && value.callSessionSeq !== input.id) throw new Error('Draft call reference mismatch');
    if(op==='CallOrderLinked' && value!==null && value.orderSeq!==input.orderSeq) throw new Error('Order call link mismatch');
    if (op === 'CallCustomerResolved' && value !== null && value.customerSeq !== input.customerSeq)
      throw new Error('Draft call customer mismatch');
    return;
  }
  if (op === 'PendingCallWritesRead') {
    if (!Array.isArray(value)) throw new Error('Invalid pending draft receipts');
    for (const receipt of value) {
      validateReceipt(receipt);
      if (receipt.payload.callSessionSeq !== input.id) throw new Error('Pending draft receipt mismatch');
    }
    return;
  }
  if (op === 'CallBumped' ? !id(value) : op === 'PinChecked' ? typeof value !== 'boolean' :
      value !== null && (!keys(value,'active,customerSeq,phone') || !id(value.customerSeq) ||
        typeof value.active !== 'boolean' || typeof value.phone !== 'string' ||
        ['CustomerRead','OrderCustomerRead'].includes(op) && value.customerSeq !== input.id ||
        ['CustomerPhoneRead','CallCustomerRead'].includes(op) && value.phone !== input.phone || op === 'CustomerPhoneRead' && !value.active))
    throw new Error('Invalid draft reference result');
}

async function exchange(url, token, event, scopeId, validate) {
  if (typeof token !== 'string' || !/^[\x21-\x7e]{32,256}$/.test(token)) throw new Error('Invalid draft write credentials');
  const endpoint = new URL(url);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    throw new Error('Invalid draft write endpoint');
  if (scopeId !== undefined) validateReadScope(scopeId);
  const response = await fetch(endpoint, {
    // A write can process an unbounded set of persisted drafts; each owner query keeps its own timeout.
    method: 'POST', redirect: 'error', signal: event.eventType === 'ParcelDraftWriteRequested' ? null : AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token,
      ...(scopeId === undefined ? {} : { 'X-Msa-Read-Scope': scopeId }) },
    body: JSON.stringify(event),
  });
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel();
    throw new Error('Invalid draft write response type');
  }
  const parts = [];
  try { for await (const part of response.body ?? []) parts.push(part); }
  finally { await response.body?.cancel(); }
  const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)));
  if (response.status !== 200) {
    const e = result?.error;
    if ([400,403,404,409,422,500,503].includes(response.status) && keys(e,'code,details,message') &&
        ['INVALID_REQUEST','FORBIDDEN','NOT_FOUND','INVALID_STATE','INTERNAL_ERROR','DEPENDENCY_UNAVAILABLE',
          'REQUEST_IN_PROGRESS','VERSION_CONFLICT','IDEMPOTENCY_KEY_REUSED','EVENT_PAYLOAD_CONFLICT',
          'VALIDATION_FAILED','DUPLICATE_RESOURCE','BUSINESS_RULE_VIOLATION'].includes(e.code) &&
        typeof e.message === 'string' && Array.isArray(e.details) &&
        e.details.every(detail => keys(detail,'field,reason') && typeof detail.field === 'string' && typeof detail.reason === 'string'))
      throw new OrderReadError(response.status,e);
    throw new Error('Invalid draft write failure');
  }
  if (!keys(result,'eventId,payload,status') || result.eventId !== event.eventId || result.status !== 'processed')
    throw new Error('Invalid draft write acknowledgement');
  validate(result.payload);
  return result.payload;
}

function requestDraftWrite(url, token, event) {
  validateDraftWrite(event,event.source);
  return exchange(url,token,event,undefined,value=>validateWriteResult(value,event.payload.command,event.eventId));
}
function requestWriteReference(url, token, event, scopeId) {
  validateWriteReference(event);
  if (!['PendingCallWritesRead','IntakeFinalizationRead','RecipientReceiptRead','CustomerPreparationOutcomeRead'].includes(event.payload.operation) && scopeId === undefined)
    throw new Error('A draft write scope is required');
  return exchange(url,token,event,scopeId,value=>validateReferenceResult(value,event));
}
module.exports = { validateDraftWrite, requestDraftWrite, validateWriteReference, requestWriteReference,
  validateCallMutation, validateOrderCallLink, validateLegacyCallWrite, validateReceipt, validateWriteCall };
