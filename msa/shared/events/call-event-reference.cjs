const { isIP } = require('node:net');
const { validateEvent } = require('./index.cjs');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, names) => object(value) && Object.keys(value).sort().join(',') === names;
const id = value => Number.isInteger(value) && value > 0 && value <= 2147483647;
const nullableId = value => value === null || id(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const lookup = value => keys(value,'callOrderSeq,customerSeq,orderSeq') && id(value.orderSeq) && nullableId(value.callOrderSeq) && nullableId(value.customerSeq);
function privateAddress(value) {
  if (typeof value !== 'string' || isIP(value) !== 4) return false;
  const [a,b] = value.split('.').map(Number);
  return a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168;
}
function validateScopeRequest(event) {
  validateEvent(event);
  if (!uuid(event.eventId) || event.source !== 'consultation' || event.eventType !== 'CallEventOrderScopeRequested' ||
      !keys(event.payload,'callbackAddress,lookup') || !lookup(event.payload.lookup) ||
      !(event.payload.callbackAddress === null || privateAddress(event.payload.callbackAddress)))
    throw new Error('Invalid call event order scope');
}
function validateScopeResult(event) {
  validateEvent(event);
  const p = event.payload;
  if (event.source !== 'order' || event.eventType !== 'CallEventOrderChecked' ||
      !keys(p,'allowed,exists,lookup,scopeId,step') || !uuid(p.scopeId) ||
      !Number.isInteger(p.step) || p.step < 0 || p.step >= 50 || !lookup(p.lookup) ||
      typeof p.exists !== 'boolean' || !(p.allowed === null || typeof p.allowed === 'boolean') ||
      !p.exists && p.allowed !== null)
    throw new Error('Invalid call event order result');
}
function validateDirective(value) {
  if (!keys(value,'next') || !(value.next === null || lookup(value.next)))
    throw new Error('Invalid call event order continuation');
}
async function requestPacket(url, token, event, signal, maximumBytes=16384) {
  if(maximumBytes!==null&&(!Number.isInteger(maximumBytes)||maximumBytes<1||maximumBytes>1024*1024))throw new Error('Invalid acknowledgement bound');
  const response = await fetch(url, {method:'POST',redirect:'error',signal,
    headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(event)});
  if (response.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) {
    await response.body?.cancel();
    throw new Error('Call event order scope unavailable');
  }
  const chunks=[]; let size=0;
  for await (const chunk of response.body || []) {
    size+=chunk.length;
    if (maximumBytes!==null&&size>maximumBytes) throw new Error('Call event order acknowledgement too large');
    chunks.push(chunk);
  }
  const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!keys(value,'eventId,payload,status') || value.eventId !== event.eventId || value.status !== 'processed')
    throw new Error('Invalid call event order acknowledgement');
  return value.payload;
}
module.exports={privateAddress,validateScopeRequest,validateScopeResult,validateDirective,requestPacket};
