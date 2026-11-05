const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { validateEvent, createReceiver, createRelay } = require('../index.cjs');

const token = 'test-only-event-key-'.padEnd(40, 'a');
const event = () => ({ eventId: randomUUID(), source: 'order', eventType: 'OrderAccepted', payload: { orderSeq: 1 } });

test('event envelopes accept only bounded identifiers and a JSON object payload', () => {
  assert.doesNotThrow(() => validateEvent(event()));
  for (const change of [{ eventId: 'no-uuid' }, { source: 'unknown' }, { eventType: '' },
    { payload: null }, { payload: [] }, { extra: true }])
    assert.throws(() => validateEvent({ ...event(), ...change }), { status: 400 });
});

test('receiver and relay reject empty or malformed authentication configuration', () => {
  const pool = { connect() { throw new Error('must not reach DB'); } };
  for (const value of ['', 'short', 'a'.repeat(32) + '\n']) {
    assert.throws(() => createReceiver({ pool, sources: { order: value }, handlers: {} }));
    assert.throws(() => createRelay({ pool, source: 'order', destinations: { delivery: { url: 'http://delivery:3003/internal/events', token: value } } }));
  }
  for (const url of ['file:///tmp/events', 'http://user:pass@delivery/events', 'http://delivery/events?token=secret', 'http://delivery/events#x'])
    assert.throws(() => createRelay({ pool, source: 'order', destinations: { delivery: { url, token } } }));
});

test('authentication and unsupported events fail before any DB access', async () => {
  const receiver = createReceiver({ pool: { connect() { throw new Error('must not reach DB'); } },
    sources: { order: token }, handlers: { 'order:OrderAccepted': async () => {} } });
  await assert.rejects(receiver(event(), 'Bearer wrong'), { status: 401 });
  await assert.rejects(receiver({ ...event(), source: 'customer' }, `Bearer ${token}`), { status: 401 });
  await assert.rejects(receiver({ ...event(), eventType: 'OtherEvent' }, `Bearer ${token}`), { status: 422 });
});
