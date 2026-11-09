const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createServer } = require('node:http');
const { validateParcelDraftCommand, requestParcelDraftCommand } = require('../parcel-drafts.cjs');
const token = 'parcel-draft-test-only-'.padEnd(40, 'x');
const read = () => ({ eventId: randomUUID(), source: 'order', eventType: 'LegacyDraftCallBindingsReadRequested', payload: { orderSeqs: [1, 2] } });
const check = () => ({ eventId: randomUUID(), source: 'consultation', eventType: 'CallDraftDeletionCheckRequested', payload: { callSessionSeq: 3 } });
let server, url, mode;
before(async () => {
  server = createServer(async (req, res) => {
    const parts = []; for await (const part of req) parts.push(part);
    const input = JSON.parse(Buffer.concat(parts));
    assert.equal(req.headers.authorization, 'Bearer ' + token);
    if (mode === 'lost') { req.socket.destroy(); return; }
    if (mode === 'redirect') { res.writeHead(307, { Location: '/wrong' }).end(); return; }
    res.setHeader('Content-Type', mode === 'html' ? 'text/html' : 'application/json');
    if (mode === 'status') res.statusCode = 503;
    const rows = [{ orderSeq: 1, callSessionSeq: 10, callerPhoneNumber: null }, { orderSeq: 2, callSessionSeq: null, callerPhoneNumber: null }];
    let payload = input.eventType === 'LegacyDraftCallBindingsReadRequested' ? rows : false;
    if (mode === 'duplicate') payload[1] = payload[0];
    if (mode === 'missing') payload.pop();
    if (mode === 'foreign') payload[0].orderSeq = 99;
    if (mode === 'forged') payload[0].customerSeq = 99;
    if (mode === 'orphan-phone') payload[1].callerPhoneNumber = 'must-not-be-selected';
    if (mode === 'long-phone') payload[0].callerPhoneNumber = 'x'.repeat(20000);
    if (mode === 'boolean') payload = 'false';
    res.end(mode === 'json' ? '{' : mode === 'utf8' ? Buffer.from([255]) : mode === 'oversized' ? ' '.repeat(4097) :
      JSON.stringify({ eventId: mode === 'id' ? randomUUID() : input.eventId, status: mode === 'ack' ? 'received' : 'processed', payload }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); url = 'http://127.0.0.1:' + server.address().port;
});
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });

test('parcel draft commands accept only their exact owner, fields, positive IDs and unique bounded batches', () => {
  validateParcelDraftCommand(read(), 'LegacyDraftCallBindingsReadRequested', 'order');
  validateParcelDraftCommand(check(), 'CallDraftDeletionCheckRequested', 'consultation');
  for (const mutate of [e => e.source = 'customer', e => e.payload.orderSeqs = [], e => e.payload.orderSeqs = [1, 1],
    e => e.payload.orderSeqs = [0], e => e.payload.orderSeqs = ['1'], e => e.payload.orderSeqs = Array.from({ length: 101 }, (_, i) => i + 1),
    e => e.payload.actorId = 1, e => e.eventType = 'OrderAccepted']) {
    const bad = read(); mutate(bad); assert.throws(() => validateParcelDraftCommand(bad, 'LegacyDraftCallBindingsReadRequested', 'order'));
  }
  assert.throws(() => validateParcelDraftCommand({ ...check(), payload: { callSessionSeq: 2147483648 } }, 'CallDraftDeletionCheckRequested', 'consultation'));
  assert.throws(() => validateParcelDraftCommand({ ...read(), payload: {} }, 'CallDraftDeletionCheckRequested', 'order'));
});
test('binding ACKs preserve null and historical text, and reject mismatched, incomplete or forged snapshots', async () => {
  mode = 'valid'; assert.deepEqual(await requestParcelDraftCommand(url, token, read()),
    [{ orderSeq: 1, callSessionSeq: 10, callerPhoneNumber: null }, { orderSeq: 2, callSessionSeq: null, callerPhoneNumber: null }]);
  mode = 'long-phone'; assert.equal((await requestParcelDraftCommand(url, token, read()))[0].callerPhoneNumber.length, 20000);
  for (mode of ['lost', 'redirect', 'html', 'status', 'json', 'utf8', 'id', 'ack', 'duplicate', 'missing', 'foreign', 'forged', 'orphan-phone'])
    await assert.rejects(requestParcelDraftCommand(url, token, read()), undefined, mode);
});
test('deletion accepts only a matching boolean ACK and cleanup must explicitly succeed', async () => {
  mode = 'valid'; assert.equal(await requestParcelDraftCommand(url, token, check()), false);
  for (mode of ['boolean', 'id', 'ack', 'oversized']) await assert.rejects(requestParcelDraftCommand(url, token, check()));
  mode = 'valid'; await assert.rejects(requestParcelDraftCommand(url, token,
    { eventId: randomUUID(), source: 'order', eventType: 'LegacyDraftCallBindingsPruneRequested', payload: {} }));
  await assert.rejects(requestParcelDraftCommand(url, 'short', check()));
  await assert.rejects(requestParcelDraftCommand(url + '?redirect=1', token, check()));
});
