'use strict';
const { validateEvent } = require('./index.cjs');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => object(value) && Object.keys(value).sort().join(',') === expected;
const id = value => Number.isInteger(value) && value > 0 && value <= 2147483647;
const name = value => typeof value === 'string';
const month = value => typeof value === 'string' && /^(?!0000)[0-9]{4}-(0[1-9]|1[0-2])$/.test(value);
const amount = value => Number.isInteger(value) && value >= 0;

function validateBilling(event, type, source) {
  validateEvent(event);
  const p = event.payload;
  let valid = event.eventType === type && event.source === source;
  if (type === 'BillingReadRequested')
    valid &&= source === 'customer' && keys(p, 'id,month,organizationName') && id(p.id) &&
      (p.month === null || month(p.month)) && (p.organizationName === null || name(p.organizationName));
  else if (type === 'CustomerBillingReadRequested')
    valid &&= source === 'customer' && keys(p, 'id,month') && id(p.id) &&
      (p.month === null || month(p.month));
  else if (type === 'BillingOrganizationsReadRequested')
    valid &&= source === 'order' && keys(p, '');
  else if (type === 'BillingRolloverRequested') {
    valid &&= ['order', 'customer'].includes(source) &&
      keys(p, source === 'order' ? 'months' : 'months,organizations') &&
      Array.isArray(p.months) && p.months.length > 0 && p.months.length <= 10 &&
      p.months.every(row => keys(row, 'billingMonth,organizationSeq') && id(row.organizationSeq) &&
        typeof row.billingMonth === 'string' && row.billingMonth.endsWith('-01') && month(row.billingMonth.slice(0,-3))) &&
      new Set(p.months.map(row => row.organizationSeq+':'+row.billingMonth)).size === p.months.length;
    if (valid && source === 'customer')
      valid &&= Array.isArray(p.organizations) && p.organizations.length <= 10 &&
        p.organizations.every(row => keys(row, 'name,organizationSeq') && id(row.organizationSeq) && name(row.name) &&
          p.months.some(item => item.organizationSeq === row.organizationSeq)) &&
        new Set(p.organizations.map(row=>row.organizationSeq)).size === p.organizations.length;
  } else valid = false;
  if (!valid) throw new Error('Invalid billing command');
}

class BillingError extends Error {
  constructor(status, error) { super('Billing rejected'); this.status = status; this.error = error; }
}

async function requestBilling(url, token, event) {
  validateBilling(event, event.eventType, event.source);
  if (typeof token !== 'string' || !/^[\x21-\x7e]{32,256}$/.test(token)) throw new Error('Invalid billing credentials');
  const endpoint = new URL(url);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    throw new Error('Invalid billing endpoint');
  const response = await fetch(endpoint, {
    method:'POST', redirect:'error', signal:AbortSignal.timeout(event.source === 'order' ? 30000 : 25000),
    headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(event),
  });
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel(); throw new Error('Invalid billing response type');
  }
  const parts=[];let size=0;
  try {
    for await (const part of response.body ?? []) {
      size+=part.length;
      // Source reads have no company-count or historical-name length cap; only boolean ACKs are bounded.
      if (event.eventType === 'BillingRolloverRequested' && size>4096) throw new Error('Billing response too large');
      parts.push(part);
    }
  } finally { await response.body?.cancel(); }
  const result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)));
  if (response.status !== 200) {
    const error=result?.error;
    if ([400,403,404,409,422,500,503].includes(response.status) && keys(error,'code,details,message') &&
        ['INVALID_REQUEST','FORBIDDEN','NOT_FOUND','INVALID_STATE','VALIDATION_FAILED','BUSINESS_RULE_VIOLATION','INTERNAL_ERROR','DEPENDENCY_UNAVAILABLE'].includes(error.code) &&
        typeof error.message==='string' && Array.isArray(error.details) && error.details.every(row=>keys(row,'field,reason') &&
          typeof row.field==='string' && typeof row.reason==='string')) throw new BillingError(response.status,error);
    throw new Error('Invalid billing failure');
  }
  if (!keys(result,'eventId,payload,status') || result.eventId!==event.eventId || result.status!=='processed')
    throw new Error('Invalid billing acknowledgement');
  const value=result.payload;
  if (event.eventType==='BillingOrganizationsReadRequested'
    ? !Array.isArray(value) || !value.every(id) || new Set(value).size!==value.length
    : event.eventType==='BillingRolloverRequested' ? typeof value!=='boolean'
    : event.eventType==='CustomerBillingReadRequested' ?
      !keys(value,'customerSeq,month,monthlyAmount') || value.customerSeq!==event.payload.id ||
      !month(value.month) || (event.payload.month!==null && value.month!==event.payload.month) || !amount(value.monthlyAmount)
    : !keys(value,'groupBillingAmount,month,monthlyAmount,organizationName,organizationSeq') ||
      value.organizationSeq!==event.payload.id || !month(value.month) ||
      (event.payload.month!==null && value.month!==event.payload.month) ||
      !(value.organizationName===null || name(value.organizationName)) || !amount(value.monthlyAmount) || !amount(value.groupBillingAmount))
    throw new Error('Invalid billing result');
  return value;
}
module.exports={validateBilling,requestBilling,BillingError};
