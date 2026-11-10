'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { validateEvent } = require('./index.cjs');
const keys = (value, expected) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === expected;
const id = value => Number.isInteger(value) && value > 0 && value <= 2147483647;

const phone = value => typeof value==='string' && !value.includes('\u0000') && value.isWellFormed();
const digest = value => createHash('sha256').update(value).digest('hex');
const shortPhone = value => phone(value) && Buffer.byteLength(JSON.stringify(value))<=256;
const uniqueIds = values => Array.isArray(values) && values.length<=250 && values.every(id) && new Set(values).size===values.length;
const timestamp = value => typeof value==='string' && (['infinity','-infinity'].includes(value) || /^\d{4,6}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::\d{2}){0,2})(?: BC)?$/.test(value));
function draftCallQuery(p) {
  return keys(p,'callIds,customerIds,phoneHashes,phones') && uniqueIds(p.callIds) && uniqueIds(p.customerIds) &&
    Array.isArray(p.phones) && p.phones.every(shortPhone) && new Set(p.phones).size===p.phones.length &&
    Array.isArray(p.phoneHashes) && p.phoneHashes.every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)) &&
    new Set(p.phoneHashes).size===p.phoneHashes.length && p.customerIds.length+p.phones.length+p.phoneHashes.length<=250;
}
function validateDraftCallReferences(rows, query) {
  if(!draftCallQuery(query) || !keys(rows,'calls,customers,phones') ||
     !Array.isArray(rows.calls) || rows.calls.length>query.callIds.length ||
     !rows.calls.every(r=>keys(r,'call_session_seq,started_at')&&query.callIds.includes(r.call_session_seq)&&id(r.call_session_seq)&&(r.started_at===null||timestamp(r.started_at))) ||
     new Set(rows.calls.map(r=>r.call_session_seq)).size!==rows.calls.length ||
     !Array.isArray(rows.customers) || rows.customers.length>query.customerIds.length ||
     !rows.customers.every(r=>keys(r,'call_session_seq,customer_seq,started_at')&&query.customerIds.includes(r.customer_seq)&&id(r.customer_seq)&&id(r.call_session_seq)&&timestamp(r.started_at)) ||
     new Set(rows.customers.map(r=>r.customer_seq)).size!==rows.customers.length ||
     !Array.isArray(rows.phones) || !rows.phones.every(r=>keys(r,'call_session_seq,caller_phone_number,started_at')&&id(r.call_session_seq)&&timestamp(r.started_at)&&phone(r.caller_phone_number)&&
       (query.phones.includes(r.caller_phone_number)||query.phoneHashes.includes(digest(r.caller_phone_number)))) ||
     new Set(rows.phones.map(r=>r.caller_phone_number)).size!==rows.phones.length)
    throw new Error('Invalid draft call references');
}
async function requestDraftCallReferences(url, token, input) {
  if(!keys(input,'callIds,customerIds,phones') || !Array.isArray(input.callIds) || !Array.isArray(input.customerIds) || !Array.isArray(input.phones) || !input.phones.every(phone)) throw new Error('Invalid draft call scope');
  const phones=[...new Set(input.phones)];
  // Large legacy phone text travels in replies; digest candidates are verified against the full returned values.
  const payload={callIds:[...new Set(input.callIds)].sort((a,b)=>a-b),customerIds:[...new Set(input.customerIds)].sort((a,b)=>a-b),
    phones:phones.filter(shortPhone).sort(),phoneHashes:[...new Set(phones.filter(p=>!shortPhone(p)).map(digest))].sort()};
  const event={eventId:randomUUID(),source:'order',eventType:'DraftCallReferencesRequested',payload};
  validateParcelDraftCommand(event,'DraftCallReferencesRequested','order');
  if(!payload.callIds.length&&!payload.customerIds.length&&!payload.phones.length&&!payload.phoneHashes.length)return {calls:[],customers:[],phones:[]};
  return requestParcelDraftCommand(url,token,event);
}

function validateParcelDraftCommand(event, type, source) {
  validateEvent(event);
  const p = event.payload;
  const valid = event.eventType === type && event.source === source && (
    type === 'DraftCallReferencesRequested' && source === 'order' && draftCallQuery(p) ||
    type === 'LegacyDraftCallBindingsReadRequested' && source === 'order' && keys(p, 'orderSeqs') &&
      Array.isArray(p.orderSeqs) && p.orderSeqs.length > 0 && p.orderSeqs.length <= 100 &&
      p.orderSeqs.every(id) && new Set(p.orderSeqs).size === p.orderSeqs.length ||
    type === 'LegacyDraftCallBindingsPruneRequested' && source === 'order' && keys(p, '') ||
    type === 'CallDraftDeletionCheckRequested' && source === 'consultation' && keys(p, 'callSessionSeq') && id(p.callSessionSeq));
  if (!valid) throw new Error('Invalid parcel draft command');
}

async function requestParcelDraftCommand(url, token, event) {
  validateParcelDraftCommand(event, event.eventType, event.source);
  if (typeof token !== 'string' || !/^[\x21-\x7e]{32,256}$/.test(token)) throw new Error('Invalid parcel draft credentials');
  const endpoint = new URL(url);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    throw new Error('Invalid parcel draft endpoint');
  const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(event) });
  try {
    if (response.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? ''))
      throw new Error('Invalid parcel draft response');
    const parts = []; let size = 0;
    for await (const part of response.body ?? []) {
      size += part.length;
      // Historical phone text has no source length cap; only boolean ACKs have a fixed bound.
      if (!['LegacyDraftCallBindingsReadRequested','DraftCallReferencesRequested'].includes(event.eventType) && size > 4096) throw new Error('Parcel draft response too large');
      parts.push(part);
    }
    const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)));
    if (!keys(result, 'eventId,payload,status') || result.eventId !== event.eventId || result.status !== 'processed')
      throw new Error('Invalid parcel draft acknowledgement');
    const p = result.payload;
    if (event.eventType === 'DraftCallReferencesRequested') validateDraftCallReferences(p,event.payload);
    else if (event.eventType === 'LegacyDraftCallBindingsReadRequested') {
      if (!Array.isArray(p) || p.length !== event.payload.orderSeqs.length ||
          !p.every(row => keys(row, 'callSessionSeq,callerPhoneNumber,orderSeq') && event.payload.orderSeqs.includes(row.orderSeq) &&
            (row.callSessionSeq === null || id(row.callSessionSeq)) &&
            (row.callerPhoneNumber === null || typeof row.callerPhoneNumber === 'string') &&
            (row.callSessionSeq !== null || row.callerPhoneNumber === null)) || new Set(p.map(row => row.orderSeq)).size !== p.length)
        throw new Error('Invalid legacy call bindings');
    } else if (event.eventType === 'LegacyDraftCallBindingsPruneRequested' ? p !== true : typeof p !== 'boolean')
      throw new Error('Invalid parcel draft result');
    return p;
  } finally { await response.body?.cancel(); }
}

async function restoreLegacyDraftBindings(database, consultationUrl, token) {
  const state = await database.pool.query('SELECT completed FROM parcel_draft_migration_state WHERE singleton');
  if (state.rows.length !== 1) throw new Error('Missing parcel draft migration state');
  if (state.rows[0].completed) return;
  for (;;) {
    const done = await database.transaction(async client => {
      const { rows } = await client.query(`SELECT legacy_order_seq FROM legacy_parcel_draft_bindings
        WHERE NOT completed ORDER BY legacy_order_seq LIMIT 100 FOR UPDATE SKIP LOCKED`);
      if (!rows.length) return !(await client.query('SELECT 1 FROM legacy_parcel_draft_bindings WHERE NOT completed LIMIT 1')).rowCount;
      const orderSeqs = rows.map(row => row.legacy_order_seq);
      const bindings = await requestParcelDraftCommand(consultationUrl + '/internal/legacy-draft-call-bindings/read', token,
        { eventId: randomUUID(), source: 'order', eventType: 'LegacyDraftCallBindingsReadRequested', payload: { orderSeqs } });
      await client.query(`UPDATE order_parcel_drafts d SET call_session_seq=b."callSessionSeq",caller_phone_number=b."callerPhoneNumber"
        FROM jsonb_to_recordset($1::jsonb) AS b("orderSeq" integer,"callSessionSeq" integer,"callerPhoneNumber" text)
        WHERE d.legacy_order_seq=b."orderSeq"`, [JSON.stringify(bindings)]);
      await client.query('UPDATE legacy_parcel_draft_bindings SET completed=true WHERE legacy_order_seq=ANY($1::integer[])', [orderSeqs]);
      return false;
    });
    if (done) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  // Cleanup happens only after every local binding has a confirmed durable completion marker.
  await requestParcelDraftCommand(consultationUrl + '/internal/legacy-draft-call-bindings/prune', token,
    { eventId: randomUUID(), source: 'order', eventType: 'LegacyDraftCallBindingsPruneRequested', payload: {} });
  await database.transaction(async client => {
    await client.query('DELETE FROM legacy_parcel_draft_bindings');
    await client.query('UPDATE parcel_draft_migration_state SET completed=true WHERE singleton');
  });
}

module.exports = { validateParcelDraftCommand, requestParcelDraftCommand, restoreLegacyDraftBindings, validateDraftCallReferences, requestDraftCallReferences };
