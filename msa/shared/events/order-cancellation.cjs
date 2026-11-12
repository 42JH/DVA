'use strict';
const { validateEvent } = require('./index.cjs');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => Number.isInteger(value) && value > 0 && value <= 2147483647;
const keys = (value, expected) => object(value) && Object.keys(value).sort().join(',') === expected;
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function validateOrderCancellation(event, source) {
  validateEvent(event);
  const payload = event.payload, command = payload.command;
  const scopeKeys = source === 'order' ? 'command' : source === 'consultation' ? 'caller,command' : 'command,customerSeq';
  const unpaidOnly = source !== 'order' && payload.unpaidOnly === true;
  if (!['order','consultation','customer'].includes(source) || event.source !== source || event.eventType !== 'OrderCancellationRequested' ||
      !keys(payload, unpaidOnly ? scopeKeys + ',unpaidOnly' : scopeKeys) ||
      !keys(command, 'callSessionSeq,id,orderParcelSeqs,requestId') || !id(command.id) || !id(command.callSessionSeq) ||
      typeof command.requestId !== 'string' || command.requestId.length < 1 || command.requestId.length > 128 ||
      !(command.orderParcelSeqs === null || Array.isArray(command.orderParcelSeqs) && command.orderParcelSeqs.length > 0 &&
        command.orderParcelSeqs.every(id) && new Set(command.orderParcelSeqs).size === command.orderParcelSeqs.length))
    throw new Error('Invalid order cancellation command');
  if (source === 'consultation') {
    const caller = payload.caller;
    if (!keys(caller, 'endedAt,orderSeq,phone') ||
        !(caller.phone === null || typeof caller.phone === 'string' && /^[0-9]+$/.test(caller.phone)) ||
        !(caller.endedAt === null || date(caller.endedAt)) || !(caller.orderSeq === null || id(caller.orderSeq)))
      throw new Error('Invalid order call scope');
  }
  if (source === 'customer' && !id(payload.customerSeq)) throw new Error('Invalid order customer scope');
}
class OrderCancellationError extends Error {
  constructor(status, error) { super('Order cancellation rejected'); this.status = status; this.error = error; }
}
async function requestOrderCancellation(url, token, event) {
  validateOrderCancellation(event,event.source);
  if (typeof token !== 'string' || !/^[\x21-\x7e]{32,256}$/.test(token)) throw new Error('Invalid cancellation credentials');
  const endpoint = new URL(url);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    throw new Error('Invalid cancellation endpoint');
  const response = await fetch(endpoint, {
    method: 'POST', redirect: 'error',
    // The callback includes durable audit confirmation; outer hops must outlive it.
    signal: AbortSignal.timeout(event.source === 'order' ? 30000 : event.source === 'consultation' ? 25000 : 20000),
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(event),
  });
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel(); throw new Error('Invalid cancellation response type');
  }
  const parts = [];
  let size=0;
  try { for await (const part of response.body ?? []) { size+=part.length; if(size>4096)throw new Error('Invalid cancellation response size'); parts.push(part); } }
  finally { await response.body?.cancel(); }
  const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)));
  if (response.status !== 200) {
    const error = result?.error;
    if ([400, 403, 404, 409, 500, 503].includes(response.status) && keys(error, 'code,details,message') &&
        ['INVALID_REQUEST', 'FORBIDDEN', 'NOT_FOUND', 'INVALID_STATE', 'REQUEST_IN_PROGRESS', 'INTERNAL_ERROR', 'DEPENDENCY_UNAVAILABLE'].includes(error.code) &&
        typeof error.message === 'string' && Array.isArray(error.details) && error.details.every(detail =>
          keys(detail, 'field,reason') && typeof detail.field === 'string' && typeof detail.reason === 'string'))
      throw new OrderCancellationError(response.status, error);
    throw new Error('Invalid cancellation failure');
  }
  if (!keys(result, 'eventId,payload,status') || result.eventId !== event.eventId || result.status !== 'processed' || result.payload !== null)
    throw new Error('Invalid cancellation acknowledgement');
  return null;
}
module.exports = { validateOrderCancellation, requestOrderCancellation, OrderCancellationError };
