const { randomUUID, timingSafeEqual } = require('node:crypto');

const services = new Set(['customer', 'order', 'consultation', 'delivery', 'operations']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maxBytes = 1024 * 1024;
class EventError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function validateEvent(event) {
  if (!object(event) || Object.keys(event).sort().join(',') !== 'eventId,eventType,payload,source' ||
      typeof event.eventId !== 'string' || !uuid.test(event.eventId) || !services.has(event.source) ||
      typeof event.eventType !== 'string' || !/^[A-Z][A-Za-z0-9]{0,99}$/.test(event.eventType) || !object(event.payload))
    throw new EventError(400, 'INVALID_EVENT');
}
function checkToken(token) {
  if (typeof token !== 'string' || !/^[\x21-\x7e]{32,256}$/.test(token)) throw new Error('Invalid event authentication configuration');
}
async function transaction(pool, action) {
  const client = await pool.connect();
  let broken;
  try { await client.query('BEGIN'); const value = await action(client); await client.query('COMMIT'); return value; }
  catch (error) { try { await client.query('ROLLBACK'); } catch (failure) { broken = failure; } throw error; }
  finally { client.release(broken); }
}

async function enqueue(client, { destination, eventType, aggregateSeq, payload }) {
  validateEvent({ eventId: randomUUID(), source: destination, eventType, payload });
  if (!Number.isSafeInteger(aggregateSeq) || aggregateSeq < 1 || aggregateSeq > 2147483647)
    throw new EventError(400, 'INVALID_AGGREGATE');
  if (Buffer.byteLength(JSON.stringify(payload)) > maxBytes - 512) throw new EventError(413, 'EVENT_TOO_LARGE');
  // Lock before sequence allocation so concurrent producers commit aggregate intents in order.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1),$2)', [destination, aggregateSeq]);
  return (await client.query(
    `INSERT INTO outbox_events(destination,event_type,aggregate_seq,payload) VALUES($1,$2,$3,$4) RETURNING event_id`,
    [destination, eventType, aggregateSeq, payload],
  )).rows[0].event_id;
}

function createReceiver({ pool, sources, handlers }) {
  for (const [source, token] of Object.entries(sources)) {
    if (!services.has(source)) throw new Error('Invalid event source');
    checkToken(token);
  }
  return async (event, authorization) => {
    validateEvent(event);
    const token = Object.hasOwn(sources, event.source) ? sources[event.source] : undefined;
    const actual = Buffer.from(typeof authorization === 'string' ? authorization : '');
    const expected = Buffer.from(`Bearer ${token || ''}`);
    if (!token || actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new EventError(401, 'EVENT_UNAUTHORIZED');
    const key = `${event.source}:${event.eventType}`;
    if (!Object.hasOwn(handlers, key)) throw new EventError(422, 'UNSUPPORTED_EVENT');
    return transaction(pool, async client => {
      const inserted = await client.query(
        `INSERT INTO inbox_events(event_id,source,event_type,payload) VALUES($1,$2,$3,$4)
         ON CONFLICT(event_id) DO NOTHING RETURNING event_id`,
        [event.eventId, event.source, event.eventType, event.payload],
      );
      if (!inserted.rowCount) {
        const { rows } = await client.query(
          `SELECT source=$2 AND event_type=$3 AND payload=$4::jsonb AS matches FROM inbox_events WHERE event_id=$1`,
          [event.eventId, event.source, event.eventType, event.payload],
        );
        if (!rows[0]?.matches) throw new EventError(409, 'EVENT_CONFLICT');
        return { eventId: event.eventId, status: 'duplicate' };
      }
      await handlers[key](client, event);
      return { eventId: event.eventId, status: 'processed' };
    });
  };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, rejected = false;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        if (!rejected) { rejected = true; chunks.length = 0; reject(new EventError(413, 'EVENT_TOO_LARGE')); }
      } else if (!rejected) chunks.push(chunk);
    });
    request.on('end', () => {
      if (rejected) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new EventError(400, 'INVALID_EVENT_JSON')); }
    });
    request.on('error', () => reject(new EventError(400, 'INVALID_EVENT_BODY')));
    request.on('aborted', () => reject(new EventError(400, 'INVALID_EVENT_BODY')));
  });
}

function eventHttpHandler(receive) {
  return async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json');
    try {
      if (request.url !== '/internal/events') throw new EventError(404, 'EVENT_ROUTE_NOT_FOUND');
      if (request.method !== 'POST') throw new EventError(405, 'EVENT_METHOD_NOT_ALLOWED');
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || ''))
        throw new EventError(415, 'EVENT_JSON_REQUIRED');
      const result = await receive(await readBody(request), request.headers.authorization);
      response.writeHead(200).end(JSON.stringify(result));
    } catch (error) {
      request.resume();
      response.writeHead(error instanceof EventError ? error.status : 500)
        .end(JSON.stringify({ error: error instanceof EventError ? error.code : 'EVENT_PROCESSING_FAILED' }));
    }
  };
}

async function acknowledged(response, eventId) {
  if (response.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) {
    await response.body?.cancel(); return false;
  }
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 4096) throw new Error('Invalid event acknowledgement');
    chunks.push(chunk);
  }
  const ack = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return object(ack) && ack.eventId === eventId && ['processed', 'duplicate'].includes(ack.status);
}

function createRelay({ pool, source, destinations, timeoutMs = 5000 }) {
  if (!services.has(source) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
    throw new Error('Invalid event relay configuration');
  const endpoints = new Map(Object.entries(destinations).map(([destination, config]) => {
    if (!services.has(destination)) throw new Error('Invalid event destination');
    const url = new URL(config.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new Error('Invalid event endpoint');
    checkToken(config.token);
    return [destination, { url: url.href, token: config.token }];
  }));
  return () => transaction(pool, async client => {
    const { rows } = await client.query(
      `SELECT pending.* FROM outbox_events pending
       WHERE delivered_at IS NULL AND next_attempt_at<=clock_timestamp()
         AND NOT EXISTS (SELECT 1 FROM outbox_events earlier
           WHERE earlier.destination=pending.destination AND earlier.aggregate_seq=pending.aggregate_seq
             AND earlier.delivered_at IS NULL AND earlier.outbox_seq<pending.outbox_seq)
       ORDER BY outbox_seq FOR UPDATE OF pending SKIP LOCKED LIMIT 1`,
    );
    if (!rows.length) return false;
    const event = rows[0], endpoint = endpoints.get(event.destination);
    let ok = false, status = null;
    if (endpoint) {
      try {
        const response = await fetch(endpoint.url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
          headers: { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ eventId: event.event_id, source, eventType: event.event_type, payload: event.payload }) });
        status = response.status;
        ok = await acknowledged(response, event.event_id);
      } catch { /* An unknown remote outcome must remain pending and replay the same event ID. */ }
    }
    if (ok) await client.query(
      'UPDATE outbox_events SET delivered_at=clock_timestamp(),last_http_status=$2 WHERE event_id=$1', [event.event_id, status]);
    else await client.query(
      `UPDATE outbox_events SET attempt_count=LEAST(attempt_count,2147483646)+1,
       next_attempt_at=clock_timestamp()+($2::int*interval '1 millisecond'),last_http_status=$3 WHERE event_id=$1`,
      [event.event_id, Math.min(60000, 250 * 2 ** Math.min(event.attempt_count, 8)), status]);
    return true;
  });
}

async function sendEvent(url, token, event) {
  validateEvent(event);
  checkToken(token);
  const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(event) });
  if (!await acknowledged(response, event.eventId)) throw new Error('Event acknowledgement unavailable');
}

module.exports = { enqueue, createReceiver, createRelay, eventHttpHandler, validateEvent, sendEvent };
