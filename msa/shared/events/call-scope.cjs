const { validateEvent } = require('./index.cjs');
const { createHash } = require('node:crypto');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => Number.isInteger(value) && value > 0 && value <= 2147483647;
const operations = ['CustomerUpdated', 'PersonalPinsListed', 'PersonalPinCreated', 'PersonalPinUpdated'];
const address = value => object(value) &&
  ['name','phoneNumber','roadAddress','jibunAddress','dongName','postalCode'].every(key => typeof value[key] === 'string') &&
  Object.keys(value).every(key => ['name','phoneNumber','roadAddress','jibunAddress','dongName','postalCode','detailAddress'].includes(key)) &&
  (value.detailAddress === undefined || typeof value.detailAddress === 'string');
const codes = ['INVALID_REQUEST', 'FORBIDDEN', 'NOT_FOUND', 'DUPLICATE_RESOURCE', 'INVALID_STATE',
  'VALIDATION_FAILED', 'BUSINESS_RULE_VIOLATION', 'INTERNAL_ERROR', 'DEPENDENCY_UNAVAILABLE', 'EVENT_PAYLOAD_CONFLICT'];
function validateScopeEvent(event, source) {
  validateEvent(event);
  const command = event.payload.command;
  if (event.source !== source || event.eventType !== 'CallScopedCustomerRequested' ||
      Object.keys(event.payload).sort().join(',') !== (source === 'customer' ? 'command' : 'caller,command') ||
      !object(command) || Object.keys(command).sort().join(',') !== 'callSessionSeq,id,input,operation,requestId' ||
      !operations.includes(command.operation) || !id(command.id) || !id(command.callSessionSeq) ||
      !object(command.input)) throw new Error('Invalid scoped customer command');
  validateEvent({ ...event, eventId: command.requestId });
  if (source === 'consultation') {
    const caller = event.payload.caller;
    if (caller !== null && (!object(caller) || Object.keys(caller).sort().join(',') !== 'customerSeq,endedAt,phone' ||
        !(caller.phone === null || typeof caller.phone === 'string') ||
        !(caller.customerSeq === null || id(caller.customerSeq)) ||
        !(caller.endedAt === null || (typeof caller.endedAt === 'string' &&
          Number.isFinite(Date.parse(caller.endedAt)) && new Date(caller.endedAt).toISOString() === caller.endedAt))))
      throw new Error('Invalid call scope');
  }
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!object(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
const commandHash = command => createHash('sha256').update(JSON.stringify(canonical(command))).digest('hex');
class ScopeResponseError extends Error {
  constructor(status, error) { super('Scoped customer request rejected'); this.status = status; this.error = error; }
}
async function requestScope(url, token, event) {
  if (!/^[\x21-\x7e]{32,256}$/.test(token)) throw new Error('Invalid scope credentials');
  const endpoint = new URL(url);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    throw new Error('Invalid scope endpoint');
  const response = await fetch(endpoint, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(event.source === 'customer' ? 22000 : 15000),
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token,
      'X-Request-Id': event.payload.command.requestId }, body: JSON.stringify(event),
  });
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel(); throw new Error('Invalid scope response type');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing scope response');
  const parts = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.length;
      if (length > 16 * 1024 * 1024) throw new Error('Scope response too large');
      parts.push(Buffer.from(value));
    }
  } finally { await reader.cancel(); }
  const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)));
  if (response.status !== 200) {
    const error = result?.error;
    if ([400,403,404,409,422,500,503].includes(response.status) && object(error) &&
        codes.includes(error.code) && typeof error.message === 'string' && Array.isArray(error.details) &&
        error.details.every(detail => object(detail) && typeof detail.field === 'string' && typeof detail.reason === 'string'))
      throw new ScopeResponseError(response.status, error);
    throw new Error('Invalid scope failure');
  }
  if (!object(result) || Object.keys(result).sort().join(',') !== 'eventId,payload,status' ||
      result.eventId !== event.eventId || result.status !== 'processed') throw new Error('Invalid scope acknowledgement');
  const value = result.payload, operation = event.payload.command.operation;
  if (operation === 'CustomerUpdated' ? value !== null : operation === 'PersonalPinCreated'
    ? !object(value) || Object.keys(value).sort().join(',') !== 'personalPinSeq,version' || !id(value.personalPinSeq) || !id(value.version)
    : operation === 'PersonalPinUpdated' ? !object(value) || Object.keys(value).join(',') !== 'version' || !id(value.version)
    : !object(value) || Object.keys(value).sort().join(',') !== 'data,hasNext,total_count' || !Array.isArray(value.data) ||
      value.data.length > 100 || typeof value.hasNext !== 'boolean' || !Number.isSafeInteger(value.total_count) || value.total_count < 0 ||
      value.data.some(pin => !object(pin) || Object.keys(pin).sort().join(',') !== 'addressData,customerSeq,label,personalPinSeq,version' ||
        !id(pin.personalPinSeq) || pin.customerSeq !== event.payload.command.id || !id(pin.version) ||
        !(pin.label === null || typeof pin.label === 'string') || !address(pin.addressData)))
    throw new Error('Invalid scoped customer result');
  return value;
}
module.exports = { validateScopeEvent, commandHash, requestScope, ScopeResponseError };
