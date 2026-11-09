require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ConfigService } = require('@nestjs/config');
const { FaqCallSourcesClient } = require('../dist/faqs/faq-call-sources.client');

test('FAQ call lookup checks the exact trusted reply and never disguises a peer failure as null', async () => {
  const original = global.fetch;
  const id = '00000000-0000-4000-8000-000000000001';
  const client = new FaqCallSourcesClient(new ConfigService({
    CONSULTATION_URL: 'http://consultation:3004', CONSULTATION_AUTH_TOKEN: 'private-test-token',
  }));
  const reply = (eventId) => ({ eventId, status: 'processed', payload: { calls: [{ eventId: id, callSessionSeq: 17 }] } });
  const exercise = (change, status = 200) => {
    global.fetch = async (url, options) => {
      assert.equal(url, 'http://consultation:3004/internal/faq-call-sources');
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.headers.Authorization, 'Bearer private-test-token');
      const event = JSON.parse(options.body);
      assert.equal(event.source, 'operations');
      assert.equal(event.eventType, 'FaqCallSourcesRequested');
      assert.deepEqual(event.payload, { eventIds: [id] });
      const body = reply(event.eventId);
      change(body);
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    };
  };
  try {
    global.fetch = () => { throw Error('empty lookup called peer'); };
    assert.equal((await client.resolve([])).size, 0);
    exercise(() => {});
    assert.deepEqual([...await client.resolve([id])], [[id, 17]]);
    exercise((v) => { v.payload.calls[0].callSessionSeq = null; });
    assert.deepEqual([...await client.resolve([id])], [[id, null]]);
    for (const mutate of [
      (v) => { v.eventId = id; }, (v) => { v.status = 'pending'; },
      (v) => { v.payload.calls = []; }, (v) => { v.payload.calls.push(v.payload.calls[0]); },
      (v) => { v.payload.calls[0].eventId = 'unrequested'; },
      (v) => { v.payload.calls[0].callSessionSeq = 0; },
      (v) => { v.payload.calls[0].callSessionSeq = 2147483648; },
      (v) => { v.payload.calls[0].callSessionSeq = '17'; },
      (v) => { v.payload.calls[0].private = 'must not leak'; },
      (v) => { v.private = 'must not leak'; },
      (v) => { v.payload.calls[0].padding = 'x'.repeat(5000); },
    ]) {
      exercise(mutate);
      await assert.rejects(client.resolve([id]), /Invalid FAQ call sources/);
    }
    exercise(() => {}, 503);
    await assert.rejects(client.resolve([id]), /unavailable/);
    global.fetch = async () => new Response('{}');
    await assert.rejects(client.resolve([id]), /unavailable/);
    global.fetch = async () => { throw Error('peer connection lost'); };
    await assert.rejects(client.resolve([id]), /peer connection lost/);
  } finally { global.fetch = original; }
});
