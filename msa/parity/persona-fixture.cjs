// Disposable AI peer; the application uses its unchanged persona HTTP contract.
const { createServer } = require('node:http');
const assert = require('node:assert/strict');
assert.equal(process.env.NODE_ENV, 'test');
const token = process.env.AI_PERSONA_TOKEN;
assert.ok(token?.length >= 32);
const options = {
  voices: [{ id: 'test-voice', label: '검증 음성' }],
  speakingRate: { min: 0.8, max: 1.2 },
  turnWaitLevels: ['SHORT', 'NORMAL', 'LONG'],
};
const peers = Object.fromEntries(['monolith', 'operations'].map((side) => [side, {
  optionsMode: 'ok', refreshStatus: 202, notifications: [], optionRequests: 0,
  faqStatus: 503, faqHold: false, faqNotifications: [], healthStatus: 200, healthHold: false,
}]));
const server = createServer(async (request, response) => {
  try {
    const [, side, ...rest] = request.url.split('/');
    const peer = peers[side];
    const path = '/' + rest.join('/');
    if (peer && path === '/health' && request.method === 'GET') {
      if (!peer.healthHold) response.writeHead(peer.healthStatus).end();
      return;
    }
    if (request.headers.authorization !== 'Bearer ' + token) {
      response.writeHead(401).end();
      return;
    }
    assert.ok(peer);
    let body = '';
    for await (const chunk of request) {
      body += chunk;
      assert.ok(body.length <= 32768);
    }
    if (path === '/__state' && request.method === 'GET') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(peer));
    } else if (path === '/__control' && request.method === 'POST') {
      const input = JSON.parse(body);
      assert.deepEqual(Object.keys(input).filter((key) => !['optionsMode', 'refreshStatus', 'faqStatus', 'faqHold', 'healthStatus', 'healthHold'].includes(key)), []);
      Object.assign(peer, input);
      response.writeHead(204).end();
    } else if (path === '/internal/persona/options' && request.method === 'GET') {
      peer.optionRequests++;
      if (peer.optionsMode === 'redirect') {
        response.writeHead(302, { Location: '/private-should-not-follow' }).end();
      } else if (peer.optionsMode === 'unavailable') {
        response.writeHead(503).end();
      } else if (peer.optionsMode === 'slow') {
        setTimeout(() => { if (!response.destroyed) response.end(JSON.stringify(options)); }, 2300);
      } else {
        response.setHeader('Content-Type', 'application/json');
        response.end(peer.optionsMode === 'large' ? 'x'.repeat(32769)
          : peer.optionsMode === 'malformed' ? '{'
          : JSON.stringify(peer.optionsMode === 'invalid' ? { ...options, voices: [{ id: '', label: 'invalid' }] } : options));
      }
    } else if (path === '/internal/persona/refresh' && request.method === 'POST') {
      const input = JSON.parse(body);
      assert.deepEqual(Object.keys(input).sort(), ['aiPersonaVersionSeq', 'applicationId']);
      assert.ok(Number.isInteger(input.aiPersonaVersionSeq) && input.aiPersonaVersionSeq > 0);
      assert.match(input.applicationId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      peer.notifications.push(input);
      response.writeHead(peer.refreshStatus).end();
    } else if (path === '/internal/faqs/refresh' && request.method === 'POST') {
      const input = JSON.parse(body);
      assert.deepEqual(Object.keys(input).sort(), ['eventId', 'faqEntrySeqs', 'operation']);
      assert.match(input.eventId, /^[0-9a-f-]{36}$/);
      assert.ok(['INSERT', 'UPDATE', 'DELETE'].includes(input.operation));
      assert.ok(Array.isArray(input.faqEntrySeqs) && input.faqEntrySeqs.length > 0);
      peer.faqNotifications.push(input);
      if (!peer.faqHold) response.writeHead(peer.faqStatus).end();
    } else response.writeHead(404).end();
  } catch {
    response.writeHead(500).end();
    process.exitCode = 1;
  }
});
server.listen(8000, '0.0.0.0');
