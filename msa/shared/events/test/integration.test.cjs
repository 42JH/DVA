const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { createServer } = require('node:http');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { Pool } = require('pg');
const { enqueue, createReceiver, createRelay, eventHttpHandler } = require('../index.cjs');

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.PGHOST, 'events-db');
const sender = new Pool({ database: 'events_sender_test' });
const receiver = new Pool({ database: 'events_receiver_test' });
const token = 'local-test-key-'.padEnd(40, 'a');
const schema = resolve(process.env.DVA_CHANGELOG_ROOT || resolve(__dirname, '../../../liquibase/changelog'));
let server, url, mode, handle, relay;
const envelope = (payload = { orderSeq: 1 }) => ({ eventId: randomUUID(), source: 'order', eventType: 'OrderAccepted', payload });
const send = (event, authorization = `Bearer ${token}`) => fetch(url, { method: 'POST',
  headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body: JSON.stringify(event) });
async function transaction(pool, fn) {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
const add = (payload = { orderSeq: 1 }, aggregateSeq = 1) => transaction(sender,
  client => enqueue(client, { destination: 'delivery', eventType: 'OrderAccepted', aggregateSeq, payload }));
const rows = async (pool, table) => (await pool.query(`SELECT * FROM ${table}`)).rows;
const counts = async () => [ (await rows(receiver, 'inbox_events')).length, (await rows(receiver, 'effects')).length ];

before(async () => {
  const old = readFileSync(resolve(schema, 'consultation/001-initial.sql'), 'utf8').split('-- Infrastructure template,')[1];
  for (const pool of [sender, receiver]) {
    await pool.query(old.slice(old.indexOf('CREATE TABLE outbox_events')));
    await pool.query(readFileSync(resolve(schema, 'shared/001-event-transport.sql'), 'utf8'));
    await pool.query('CREATE TABLE effects(id integer PRIMARY KEY, value jsonb NOT NULL)');
  }
  handle = createReceiver({ pool: receiver, sources: { order: token },
    handlers: { 'order:OrderAccepted': async (client, event) => {
      await client.query('INSERT INTO effects(id,value) VALUES($1,$2)', [event.payload.orderSeq, event.payload]);
      if (mode === 'handler-failure') throw new Error('injected business failure');
    } } });
  const http = eventHttpHandler(async (...args) => {
    const ack = await handle(...args);
    if (mode === 'delayed-ack') await new Promise(resolve => setTimeout(resolve, 250));
    return ack;
  });
  server = createServer(async (request, response) => {
    if (mode === 'http-failure') { response.writeHead(503).end(); return; }
    if (mode === 'bad-ack') { response.writeHead(200, { 'Content-Type': 'application/json' }).end('{}'); return; }
    if (mode === 'redirect') { response.writeHead(307, { Location: '/redirect-target' }).end(); return; }
    if (mode === 'timeout') { request.on('close', () => response.destroy()); return; }
    if (mode === 'lost-ack') {
      const data = []; for await (const chunk of request) data.push(chunk);
      await handle(JSON.parse(Buffer.concat(data)), request.headers.authorization);
      response.destroy(); return;
    }
    await http(request, response);
  });
  await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
  url = `http://127.0.0.1:${server.address().port}/internal/events`;
  relay = createRelay({ pool: sender, source: 'order', destinations: { delivery: { url, token } } });
});
beforeEach(async () => {
  mode = 'success';
  for (const pool of [sender, receiver]) await pool.query('TRUNCATE outbox_events,inbox_events,effects');
});
after(async () => { server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve)); await sender.end(); await receiver.end(); });

test('business change and outbox both roll back on producer failure', async () => {
  await assert.rejects(transaction(sender, async client => {
    await client.query("INSERT INTO effects VALUES(1,'{}')");
    await enqueue(client, { destination: 'delivery', eventType: 'OrderAccepted', aggregateSeq: 1, payload: {} });
    throw new Error('producer failed');
  }));
  assert.equal((await rows(sender, 'effects')).length, 0);
  assert.equal((await rows(sender, 'outbox_events')).length, 0);
});

test('relay delivers a committed event and acknowledges exactly that event after business commit', async () => {
  const id = await add();
  assert.equal(await relay(), true);
  assert.deepEqual(await counts(), [1, 1]);
  assert.equal((await rows(receiver, 'inbox_events'))[0].event_id, id);
  assert.ok((await rows(sender, 'outbox_events'))[0].delivered_at);
  assert.equal(await relay(), false);
});

test('a filtered relay leaves unrelated durable intents pending and preserves selected aggregate order', async () => {
  const intent = await transaction(sender, client => enqueue(client, { destination: 'delivery', eventType: 'PreparationRequested', aggregateSeq: 1, payload: {} }));
  const first = await add({orderSeq: 1}), second = await add({orderSeq: 2});
  const selected = createRelay({ pool: sender, source: 'order', destinations: { delivery: { url, token } }, eventTypes: ['OrderAccepted'] });
  mode = 'http-failure'; await selected();
  assert.deepEqual(await counts(), [0, 0]);
  assert.equal(await selected(), false, 'the following selected event must wait for its failed predecessor');
  await sender.query("UPDATE outbox_events SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE event_id=$1", [first]);
  mode = 'success'; assert.equal(await selected(), true); assert.equal(await selected(), true); assert.equal(await selected(), false);
  const events = new Map((await rows(sender, 'outbox_events')).map(row => [row.event_id, row]));
  assert.equal(events.get(intent).delivered_at, null); assert.equal(events.get(intent).attempt_count, 0);
  assert.ok(events.get(first).delivered_at); assert.ok(events.get(second).delivered_at);
  assert.deepEqual((await receiver.query('SELECT event_id FROM inbox_events ORDER BY processed_at')).rows.map(row => row.event_id), [first, second]);
});

test('concurrent duplicate deliveries apply one business change', async () => {
  const event = envelope();
  const responses = await Promise.all(Array.from({ length: 10 }, () => send(event)));
  assert.ok(responses.every(r => r.status === 200));
  assert.deepEqual(await counts(), [1, 1]);
});

test('JSON key order does not change a duplicate payload', async () => {
  const event = envelope({ orderSeq: 1, a: 'b' });
  assert.equal((await send(event)).status, 200);
  assert.equal((await send({ ...event, payload: { a: 'b', orderSeq: 1 } })).status, 200);
  assert.deepEqual(await counts(), [1, 1]);
});

test('same event ID with different payload or event type is rejected', async () => {
  const event = envelope();
  await send(event);
  assert.equal((await send({ ...event, payload: { orderSeq: 2 } })).status, 409);
  const second = createReceiver({ pool: receiver, sources: { order: token }, handlers: { 'order:OtherEvent': async () => {} } });
  await assert.rejects(second({ ...event, eventType: 'OtherEvent' }, `Bearer ${token}`), { status: 409 });
  assert.deepEqual(await counts(), [1, 1]);
});

test('one source cannot impersonate another source or reuse its event ID', async () => {
  const event = envelope();
  await send(event);
  const otherToken = 'different-test-key-'.padEnd(40, 'b');
  const other = createReceiver({ pool: receiver, sources: { customer: otherToken }, handlers: { 'customer:OrderAccepted': async () => {} } });
  await assert.rejects(other({ ...event, source: 'customer' }, `Bearer ${token}`), { status: 401 });
  await assert.rejects(other({ ...event, source: 'customer' }, `Bearer ${otherToken}`), { status: 409 });
});

test('handler failure rolls back inbox and business change and later retry succeeds', async () => {
  const event = envelope(); mode = 'handler-failure';
  const failed = await send(event);
  assert.equal(failed.status, 500);
  assert.equal((await failed.text()).includes('injected business failure'), false);
  assert.deepEqual(await counts(), [0, 0]);
  mode = 'success'; assert.equal((await send(event)).status, 200);
  assert.deepEqual(await counts(), [1, 1]);
});

test('HTTP failure persists retry state without marking delivery', async () => {
  await add(); mode = 'http-failure'; await relay();
  const [event] = await rows(sender, 'outbox_events');
  assert.equal(event.delivered_at, null); assert.equal(event.attempt_count, 1);
  assert.equal(event.last_http_status, 503); assert.ok(event.next_attempt_at > event.occurred_at);
  assert.equal(await relay(), false); assert.deepEqual(await counts(), [0, 0]);
});

test('lost ACK replays the same event after a new relay instance starts', async () => {
  const id = await add(); mode = 'lost-ack'; await relay();
  assert.deepEqual(await counts(), [1, 1]);
  assert.equal((await rows(sender, 'outbox_events'))[0].delivered_at, null);
  await sender.query("UPDATE outbox_events SET next_attempt_at=clock_timestamp()-interval '1 second'");
  mode = 'success';
  const restarted = createRelay({ pool: sender, source: 'order', destinations: { delivery: { url, token } } });
  await restarted();
  assert.deepEqual(await counts(), [1, 1]);
  assert.equal((await rows(receiver, 'inbox_events'))[0].event_id, id);
  assert.ok((await rows(sender, 'outbox_events'))[0].delivered_at);
});

test('normal relay accepts a committed ACK delayed beyond 100 ms without duplicate application', async () => {
  mode = 'delayed-ack';
  const id = await add();
  await relay();
  assert.deepEqual(await counts(), [1, 1]);
  const [event] = await rows(sender, 'outbox_events');
  assert.equal(event.event_id, id);
  assert.ok(event.delivered_at);
  assert.equal(event.attempt_count, 0);
  assert.equal(event.last_http_status, 200);
  assert.equal(await relay(), false);
  assert.deepEqual(await counts(), [1, 1]);
});

test('invalid ACK, redirects and timeout never acknowledge an event', async () => {
  const faultRelay = createRelay({ pool: sender, source: 'order', destinations: { delivery: { url, token } }, timeoutMs: 100 });
  for (const failure of ['bad-ack', 'redirect', 'timeout']) {
    await sender.query('TRUNCATE outbox_events'); await add(); mode = failure;
    await faultRelay(); assert.equal((await rows(sender, 'outbox_events'))[0].delivered_at, null);
    assert.equal((await rows(sender, 'outbox_events'))[0].attempt_count, 1);
  }
  assert.deepEqual(await counts(), [0, 0]);
});

test('a receiver killed after DB commit recovers without duplicating business data', { timeout: 10000 }, async t => {
  async function boot(mode) {
    const child = fork(resolve(__dirname, 'receiver-process.cjs'), [mode], { silent: true });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    child.stdout.resume(); child.stderr.resume();
    const [message] = await once(child, 'message');
    return { child, url: `http://127.0.0.1:${message.port}/internal/events` };
  }
  await add();
  const first = await boot('pause-after-commit');
  const committed = once(first.child, 'message');
  const firstRelay = createRelay({ pool: sender, source: 'order', destinations: { delivery: { url: first.url, token } } });
  const inFlight = firstRelay();
  assert.equal((await committed)[0].committed, true);
  const exited = once(first.child, 'exit'); first.child.kill('SIGKILL'); await exited; await inFlight;
  assert.deepEqual(await counts(), [1, 1]);
  assert.equal((await rows(sender, 'outbox_events'))[0].delivered_at, null);
  await sender.query("UPDATE outbox_events SET next_attempt_at=clock_timestamp()-interval '1 second'");
  const restarted = await boot('normal');
  await createRelay({ pool: sender, source: 'order', destinations: { delivery: { url: restarted.url, token } } })();
  assert.deepEqual(await counts(), [1, 1]);
  assert.ok((await rows(sender, 'outbox_events'))[0].delivered_at);
  const stopped = once(restarted.child, 'exit'); restarted.child.kill('SIGTERM'); await stopped;
});

test('parallel relays do not overtake a pending event for the same aggregate', async () => {
  await add({ orderSeq: 1 }, 1); await add({ orderSeq: 2 }, 1); await add({ orderSeq: 3 }, 3);
  mode = 'http-failure'; await relay(); mode = 'success';
  await Promise.all([relay(), relay(), relay()]);
  assert.deepEqual((await rows(receiver, 'effects')).map(e => e.id), [3]);
  await sender.query("UPDATE outbox_events SET next_attempt_at=clock_timestamp()-interval '1 second'");
  await relay(); await relay();
  assert.deepEqual((await rows(receiver, 'effects')).map(e => e.id).sort(), [1, 2, 3]);
});

test('concurrent producers serialize same-aggregate intent until commit', async () => {
  const first = await sender.connect(); await first.query('BEGIN');
  try {
    await enqueue(first, { destination: 'delivery', eventType: 'OrderAccepted', aggregateSeq: 1, payload: { orderSeq: 1 } });
    let secondFinished = false;
    const second = add({ orderSeq: 2 }, 1).then(() => { secondFinished = true; });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(secondFinished, false);
    assert.equal(await relay(), false);
    await first.query('COMMIT'); await second;
    await relay(); await relay();
    assert.deepEqual((await rows(receiver, 'effects')).map(e => e.id), [1, 2]);
  } finally { await first.query('ROLLBACK'); first.release(); }
});

test('malformed, unauthorized and oversized HTTP bodies have no DB effects', async () => {
  assert.equal((await send(envelope(), 'Bearer wrong')).status, 401);
  assert.equal((await send({ ...envelope(), payload: [] })).status, 400);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(url, { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify(envelope({ text: 'a'.repeat(1024 * 1024) })) })).status, 413);
  assert.deepEqual(await counts(), [0, 0]);
});
