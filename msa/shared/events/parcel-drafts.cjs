'use strict';
const { randomUUID } = require('node:crypto');
const { validateEvent } = require('./index.cjs');
const keys = (value, expected) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === expected;
const id = value => Number.isInteger(value) && value > 0 && value <= 2147483647;

function validateParcelDraftCommand(event, type, source) {
  validateEvent(event);
  const p = event.payload;
  const valid = event.eventType === type && event.source === source && (
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
      if (event.eventType !== 'LegacyDraftCallBindingsReadRequested' && size > 4096) throw new Error('Parcel draft response too large');
      parts.push(part);
    }
    const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)));
    if (!keys(result, 'eventId,payload,status') || result.eventId !== event.eventId || result.status !== 'processed')
      throw new Error('Invalid parcel draft acknowledgement');
    const p = result.payload;
    if (event.eventType === 'LegacyDraftCallBindingsReadRequested') {
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

module.exports = { validateParcelDraftCommand, requestParcelDraftCommand, restoreLegacyDraftBindings };
